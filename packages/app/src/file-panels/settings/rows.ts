import {
  claimsFilePanelSelectorKey,
  filePanelClaimedSelectorKeys,
  parseFilePanelSelectorKey,
  type FilePanelCandidate,
} from "../resolve";

/** One selector key in Settings > Files. */
export interface FilePanelSettingsRow<Candidate> {
  selectorKey: string;
  /** Every known panel for the key, coalesced across hosts, in resolver order. */
  candidates: readonly Candidate[];
  /** The remembered panel, which may be on no connected host; null means Paseo asks on open. */
  associatedPanelId: string | null;
}

/**
 * The keys worth configuring: every key more than one known panel claims, and every key that has
 * an association, so a remembered choice can always be changed or forgotten. A panel installed on
 * several hosts is one candidate.
 */
export function buildFilePanelSettingsRows<Candidate extends FilePanelCandidate>(input: {
  candidates: readonly Candidate[];
  associations: Readonly<Record<string, string>>;
}): FilePanelSettingsRow<Candidate>[] {
  const candidates = coalesceById(input.candidates);
  const keys = new Set([
    ...candidates.flatMap((candidate) => filePanelClaimedSelectorKeys(candidate.files)),
    ...Object.keys(input.associations),
  ]);
  return [...keys]
    .sort(compareSelectorKeys)
    .map((selectorKey) => ({
      selectorKey,
      candidates: candidates.filter((candidate) =>
        claimsFilePanelSelectorKey(candidate.files, selectorKey),
      ),
      associatedPanelId: input.associations[selectorKey] ?? null,
    }))
    .filter((row) => row.candidates.length > 1 || row.associatedPanelId !== null);
}

function coalesceById<Candidate extends { id: string }>(
  candidates: readonly Candidate[],
): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

/** Extensions before filenames, each alphabetically. */
function compareSelectorKeys(left: string, right: string): number {
  const a = parseFilePanelSelectorKey(left);
  const b = parseFilePanelSelectorKey(right);
  if (a.kind !== b.kind) return a.kind === "ext" ? -1 : 1;
  return a.value.localeCompare(b.value);
}
