// Regenerates server/master/rules.generated.ts from skills/vibe-master/SKILL.md (the single
// source of the master's static rules). `--check` fails when the file is stale.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, "../../../skills/vibe-master/SKILL.md");
const target = join(here, "../server/master/rules.generated.ts");

const source = readFileSync(skill, "utf8").replace(/\r\n/g, "\n");
const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
const output = `// GENERATED FROM skills/vibe-master/SKILL.md by scripts/gen-rules.mjs - DO NOT EDIT.\nexport const MASTER_RULES = ${JSON.stringify(body)};\n`;

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8").replace(/\r\n/g, "\n") : "";
  const generated = current
    ? await import("data:text/javascript;base64," + Buffer.from(current).toString("base64"))
    : null;
  if (generated?.MASTER_RULES !== body) {
    console.error("server/master/rules.generated.ts is stale: run `npm run gen:rules`.");
    process.exit(1);
  }
} else {
  writeFileSync(target, output);
}
