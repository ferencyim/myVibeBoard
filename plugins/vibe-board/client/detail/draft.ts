// Text field drafts of the card detail page. The page polls the card every few seconds; a field
// the owner has edited (local !== base) must not be overwritten by a newer server value, or the
// cursor jumps and typing is lost. `base` is the last server value the draft was synced to.

export interface FieldDraft {
  local: string;
  base: string;
}

export const initialDraft = (server: string): FieldDraft => ({ local: server, base: server });

export const isDirty = (d: FieldDraft): boolean => d.local !== d.base;

/** Apply a (possibly new) server value. Dirty drafts keep the user's text; clean ones follow. */
export function reconcileField(d: FieldDraft, server: string): FieldDraft {
  if (server === d.base) return d;
  if (isDirty(d) && d.local !== server) return d;
  // Clean draft, or the server now holds exactly what the user typed (saved): in sync.
  return { local: server, base: server };
}

export const edit = (d: FieldDraft, local: string): FieldDraft => ({ ...d, local });

/** Drop the edits and show the server value. */
export const discard = (server: string): FieldDraft => initialDraft(server);
