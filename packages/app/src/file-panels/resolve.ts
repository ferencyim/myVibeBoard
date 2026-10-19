import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";

export interface FilePanelFile {
  path: string;
  kind: "text" | "image" | "binary";
  size: number;
  hasBytes: boolean;
}

export interface FilePanelSelector {
  extensions: readonly string[];
  filenames?: readonly string[];
}

export interface FilePanelCandidate {
  id: string;
  files: FilePanelSelector;
  document: "text" | "bytes";
  maxBytes: number;
}

export interface FilePanelResolution<Candidate> {
  panel: Candidate | null;
  candidates: readonly Candidate[];
  selectorKey: string;
  /** The remembered candidate for `selectorKey`, when this host has it. */
  associatedPanelId: string | null;
}

export function filePanelExtension(path: string): string {
  const name = filePanelBasename(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function filePanelBasename(path: string): string {
  return path.trim().split(/[\\/]/).pop() ?? "";
}

/** Which files an association applies to: one extension, or one exact filename. */
export interface FilePanelSelectorKey {
  kind: "ext" | "name";
  value: string;
}

function filePanelSelectorKey(key: FilePanelSelectorKey): string {
  return `${key.kind}:${key.value}`;
}

export function parseFilePanelSelectorKey(selectorKey: string): FilePanelSelectorKey {
  const separator = selectorKey.indexOf(":");
  const kind = selectorKey.slice(0, separator) === "name" ? "name" : "ext";
  return { kind, value: selectorKey.slice(separator + 1) };
}

function matchesSelector(file: FilePanelFile, selector: FilePanelSelector): boolean {
  if (selector.filenames?.includes(filePanelBasename(file.path))) return true;
  const extension = filePanelExtension(file.path);
  return selector.extensions.some((entry) => entry.toLowerCase() === extension);
}

export function resolveFilePanel<Candidate extends FilePanelCandidate>(input: {
  file: FilePanelFile;
  candidates: readonly Candidate[];
  associations: Readonly<Record<string, string>>;
  /** A panel chosen for this tab open; wins over the association while it is a candidate. */
  choice?: string | null;
}): FilePanelResolution<Candidate> {
  const { file, associations } = input;
  const candidates = input.candidates.filter((candidate) => {
    const documentAvailable = candidate.document === "text" ? file.kind === "text" : file.hasBytes;
    return (
      documentAvailable && file.size <= candidate.maxBytes && matchesSelector(file, candidate.files)
    );
  });
  const filename = filePanelBasename(file.path);
  const matchedFilename = candidates.some((candidate) =>
    candidate.files.filenames?.includes(filename),
  );
  const selectorKey = matchedFilename
    ? filePanelSelectorKey({ kind: "name", value: filename })
    : filePanelSelectorKey({ kind: "ext", value: filePanelExtension(file.path) });
  const associated = candidates.find((candidate) => candidate.id === associations[selectorKey]);
  const chosen = candidates.find((candidate) => candidate.id === input.choice);
  const panel = chosen ?? associated ?? candidates[0] ?? null;
  return { panel, candidates, selectorKey, associatedPanelId: associated?.id ?? null };
}

/** Raw reads always carry bytes, independently of whether a panel will retain them. */
export function resolveFileReadPanels<Candidate extends FilePanelCandidate>(input: {
  file: FileReadResult | null;
  path: string;
  candidates: readonly Candidate[];
  associations: Readonly<Record<string, string>>;
  choice?: string | null;
}): FilePanelResolution<Candidate> | null {
  const { file, path } = input;
  if (!file) return null;
  return resolveFilePanel({
    file: { path, kind: file.kind, size: file.size, hasBytes: true },
    candidates: input.candidates,
    associations: input.associations,
    choice: input.choice,
  });
}
