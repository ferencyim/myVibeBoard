import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import pLimit from "p-limit";
import { resolvePaseoHome } from "../paseo-home.js";
import type { ImportKind } from "esbuild";
import type { Node, NamedImportBindings, NamedExportBindings } from "typescript";

const nodeRequire = createRequire(import.meta.url);
const limitImportReads = pLimit(4);
const pendingImports = new Map<string, Promise<ModuleImport[]>>();

export type PluginImportKind = ImportKind | "type-reference";

interface ModuleImport {
  specifier: string;
  kind: PluginImportKind;
  typeOnly: boolean;
}

// Keep the TypeScript compiler off daemon startup. esbuild erases these edges, so
// ownership validation needs the original syntax and declaration-aware resolution.
export function createPluginImportReader(
  directory: string,
  paseoHome = resolvePaseoHome(),
  dependencies?: Set<string>,
) {
  const ts = nodeRequire("typescript") as typeof import("typescript");
  const track = (file: string) => {
    dependencies?.add(path.resolve(file));
    return file;
  };
  const system: typeof ts.sys = {
    ...ts.sys,
    fileExists: (file) => ts.sys.fileExists(track(file)),
    readFile: (file, encoding) => ts.sys.readFile(track(file), encoding),
    directoryExists: (file) => ts.sys.directoryExists(track(file)),
    getDirectories: (file) => ts.sys.getDirectories(track(file)),
    readDirectory: (file, ...args) => ts.sys.readDirectory(track(file), ...args),
    realpath: (file) => ts.sys.realpath!(track(file)),
  };
  const configFile = ts.findConfigFile(directory, system.fileExists);
  const config = configFile
    ? ts.getParsedCommandLineOfConfigFile(
        configFile,
        {},
        {
          ...system,
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
          },
        },
      )
    : undefined;
  const options = {
    ...config?.options,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };
  const cache = ts.createModuleResolutionCache(directory, (file) => file, options);
  return {
    resolve(specifier: string, importer: string, kind: PluginImportKind): string | undefined {
      const resolved =
        kind === "type-reference"
          ? ts.resolveTypeReferenceDirective(specifier, importer, options, system)
              .resolvedTypeReferenceDirective?.resolvedFileName
          : ts.resolveModuleName(
              specifier,
              importer,
              options,
              system,
              cache,
              undefined,
              kind === "require-call" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
            ).resolvedModule?.resolvedFileName;
      return resolved ? realpathSync.native(resolved) : undefined;
    },
    async read(file: string): Promise<ModuleImport[]> {
      track(file);
      const metadata = await stat(file);
      const key = JSON.stringify([
        paseoHome,
        file,
        metadata.size,
        metadata.mtimeMs,
        metadata.ctimeMs,
      ]);
      const pending = pendingImports.get(key);
      if (pending) return pending;
      const operation = limitImportReads(() => read(file, metadata));
      pendingImports.set(key, operation);
      try {
        return await operation;
      } finally {
        if (pendingImports.get(key) === operation) pendingImports.delete(key);
      }
    },
  };

  async function read(file: string, metadata: Stats): Promise<ModuleImport[]> {
    const cacheDir = path.join(paseoHome, "cache", "plugin-imports-v1");
    const cacheKey = createHash("sha256").update(file).digest("hex");
    const cacheFile = path.join(cacheDir, `${cacheKey}.json`);
    try {
      const cached: unknown = JSON.parse(await readFile(cacheFile, "utf8"));
      if (isCachedImports(cached, metadata.size, metadata.mtimeMs, metadata.ctimeMs, ts.version)) {
        return cached.imports;
      }
    } catch {
      // Cache misses and unreadable cache files must not prevent plugin loading.
    }
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: ModuleImport[] = [];
    function add(node: Node | undefined, typeOnly: boolean, kind: ImportKind = "import-statement") {
      if (node && ts.isStringLiteralLike(node)) {
        imports.push({
          specifier: node.text,
          kind,
          typeOnly: source.isDeclarationFile || typeOnly,
        });
      }
    }
    function onlyTypeBindings(
      bindings: NamedImportBindings | NamedExportBindings | undefined,
    ): boolean {
      return (
        !!bindings &&
        (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly)
      );
    }
    function visit(node: Node): void {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const typeOnly =
          !!clause?.isTypeOnly || (!clause?.name && onlyTypeBindings(clause?.namedBindings));
        add(node.moduleSpecifier, typeOnly);
      } else if (ts.isExportDeclaration(node)) {
        add(node.moduleSpecifier, node.isTypeOnly || onlyTypeBindings(node.exportClause));
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        add(node.argument.literal, true);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        add(node.moduleReference.expression, node.isTypeOnly, "require-call");
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          add(node.arguments[0], false, "dynamic-import");
        else if (ts.isIdentifier(node.expression) && node.expression.text === "require")
          add(node.arguments[0], false, "require-call");
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const reference of source.referencedFiles) {
      imports.push({
        specifier: path.resolve(path.dirname(file), reference.fileName),
        kind: "import-statement",
        typeOnly: true,
      });
    }
    for (const reference of source.typeReferenceDirectives) {
      imports.push({ specifier: reference.fileName, kind: "type-reference", typeOnly: true });
    }
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(
        cacheFile,
        JSON.stringify({
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          ctimeMs: metadata.ctimeMs,
          version: ts.version,
          imports,
        }),
      );
    } catch {
      // A read-only home is supported; parsing still supplies the result.
    }
    return imports;
  }
}

function isCachedImports(
  value: unknown,
  size: number,
  mtimeMs: number,
  ctimeMs: number,
  version: string,
): value is {
  imports: ModuleImport[];
} {
  if (!value || typeof value !== "object") return false;
  const cached = value as {
    size?: unknown;
    mtimeMs?: unknown;
    ctimeMs?: unknown;
    version?: unknown;
    imports?: unknown;
  };
  return (
    cached.size === size &&
    cached.mtimeMs === mtimeMs &&
    cached.ctimeMs === ctimeMs &&
    cached.version === version &&
    Array.isArray(cached.imports) &&
    cached.imports.every((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const entry = item as Partial<ModuleImport>;
      return (
        typeof entry.specifier === "string" &&
        typeof entry.kind === "string" &&
        typeof entry.typeOnly === "boolean"
      );
    })
  );
}
