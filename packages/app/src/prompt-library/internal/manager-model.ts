import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import {
  normalizePromptLibraryTag,
  normalizePromptLibraryTags,
  promptLibraryTagKey,
  removePromptLibraryTag,
} from "@getpaseo/protocol/prompt-library";

export interface PromptLibraryDraft {
  id: string | null;
  title: string;
  body: string;
  tags: string[];
  original: {
    title: string;
    body: string;
    tags: string[];
  } | null;
}

export type PromptLibraryManagerView = "list" | "edit" | "tags";

export interface PromptLibraryManagerSnapshot {
  serverId: string | null;
  view: PromptLibraryManagerView;
  query: string;
  draft: PromptLibraryDraft | null;
  renamingTag: string | null;
  tagDraft: string;
  pending: boolean;
  error: string | null;
  dirty: boolean;
  canSubmit: boolean;
}

export interface PromptLibraryManagerDependencies {
  save: (
    serverId: string,
    input: { id?: string; title: string; body: string; tags: string[] },
  ) => Promise<PromptLibraryEntry>;
  remove: (serverId: string, id: string) => Promise<void>;
  renameTag: (serverId: string, from: string, to: string) => Promise<void>;
  deleteTag: (serverId: string, tag: string) => Promise<void>;
}

export class PromptLibraryManagerModel {
  private state: PromptLibraryManagerSnapshot = {
    serverId: null,
    view: "list",
    query: "",
    draft: null,
    renamingTag: null,
    tagDraft: "",
    pending: false,
    error: null,
    dirty: false,
    canSubmit: false,
  };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly dependencies: PromptLibraryManagerDependencies) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PromptLibraryManagerSnapshot => this.state;

  open(serverId: string): void {
    this.update({
      ...this.state,
      serverId,
      view: "list",
      query: "",
      draft: null,
      renamingTag: null,
      tagDraft: "",
      pending: false,
      error: null,
    });
  }

  reset(): void {
    this.update({
      serverId: null,
      view: "list",
      query: "",
      draft: null,
      renamingTag: null,
      tagDraft: "",
      pending: false,
      error: null,
      dirty: false,
      canSubmit: false,
    });
  }

  setQuery(query: string): void {
    this.update({ ...this.state, query });
  }

  startCreate(tags: readonly string[] = []): void {
    this.setState({
      view: "edit",
      draft: {
        id: null,
        title: "",
        body: "",
        tags: normalizePromptLibraryTags(tags),
        original: null,
      },
      error: null,
      pending: false,
    });
  }

  startEdit(entry: PromptLibraryEntry): void {
    this.setState({
      view: "edit",
      draft: {
        id: entry.id,
        title: entry.title,
        body: entry.body,
        tags: [...entry.tags],
        original: { title: entry.title, body: entry.body, tags: [...entry.tags] },
      },
      error: null,
      pending: false,
    });
  }

  /**
   * Gate for leaving the current draft (switching entries, filters or views). Clean drafts pass;
   * a dirty one needs `confirmDiscard` to resolve true.
   */
  async confirmLeave(confirmDiscard: () => Promise<boolean>): Promise<boolean> {
    if (!this.state.dirty) return true;
    return confirmDiscard();
  }

  cancelEdit(): void {
    this.setState({ view: "list", draft: null, pending: false, error: null });
  }

  setTitle(title: string): void {
    if (!this.state.draft) return;
    this.updateDraft({ title });
  }

  setBody(body: string): void {
    if (!this.state.draft) return;
    this.updateDraft({ body });
  }

  addTag(raw: string): void {
    const draft = this.state.draft;
    if (!draft) return;
    const tag = normalizePromptLibraryTag(raw);
    if (tag.length === 0) return;
    if (
      draft.tags.some((candidate) => promptLibraryTagKey(candidate) === promptLibraryTagKey(tag))
    ) {
      return;
    }
    this.updateDraft({ tags: normalizePromptLibraryTags([...draft.tags, tag]) });
  }

  removeTag(tag: string): void {
    const draft = this.state.draft;
    if (!draft) return;
    this.updateDraft({ tags: removePromptLibraryTag(draft.tags, tag) });
  }

  async save(): Promise<PromptLibraryEntry | null> {
    const draft = this.state.draft;
    const serverId = this.state.serverId;
    if (!draft || !serverId || !this.state.canSubmit || this.state.pending) return null;
    this.setState({ pending: true, error: null });
    try {
      const saved = await this.dependencies.save(serverId, {
        ...(draft.id ? { id: draft.id } : {}),
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
      });
      this.setState({ view: "list", draft: null, pending: false, error: null });
      return saved;
    } catch (error) {
      this.setState({ pending: false, error: errorCode(error) });
      return null;
    }
  }

  async remove(): Promise<void> {
    const draft = this.state.draft;
    const serverId = this.state.serverId;
    if (!draft?.id || !serverId || this.state.pending) return;
    this.setState({ pending: true, error: null });
    try {
      await this.dependencies.remove(serverId, draft.id);
      this.setState({ view: "list", draft: null, pending: false, error: null });
    } catch (error) {
      this.setState({ pending: false, error: errorCode(error) });
    }
  }

  openTags(): void {
    this.setState({
      view: "tags",
      query: "",
      draft: null,
      renamingTag: null,
      tagDraft: "",
      error: null,
    });
  }

  closeTags(): void {
    this.setState({ view: "list", renamingTag: null, tagDraft: "", error: null });
  }

  startTagRename(tag: string): void {
    this.setState({ renamingTag: tag, tagDraft: tag, error: null });
  }

  cancelTagRename(): void {
    this.setState({ renamingTag: null, tagDraft: "", error: null });
  }

  setTagDraft(tagDraft: string): void {
    this.setState({ tagDraft });
  }

  async saveTagRename(): Promise<void> {
    const serverId = this.state.serverId;
    const from = this.state.renamingTag;
    const to = normalizePromptLibraryTag(this.state.tagDraft);
    if (!serverId || !from || !to || this.state.pending) return;
    if (promptLibraryTagKey(from) === promptLibraryTagKey(to)) {
      this.setState({ renamingTag: null, tagDraft: "", error: null });
      return;
    }
    this.setState({ pending: true, error: null });
    try {
      await this.dependencies.renameTag(serverId, from, to);
      this.setState({ pending: false, renamingTag: null, tagDraft: "", error: null });
    } catch (error) {
      this.setState({ pending: false, error: errorCode(error) });
    }
  }

  async deleteTag(tag: string): Promise<void> {
    const serverId = this.state.serverId;
    if (!serverId || this.state.pending) return;
    this.setState({ pending: true, error: null });
    try {
      await this.dependencies.deleteTag(serverId, tag);
      this.setState({
        pending: false,
        ...(this.state.renamingTag &&
        promptLibraryTagKey(this.state.renamingTag) === promptLibraryTagKey(tag)
          ? { renamingTag: null, tagDraft: "" }
          : {}),
        error: null,
      });
    } catch (error) {
      this.setState({ pending: false, error: errorCode(error) });
    }
  }

  clearError(): void {
    this.setState({ error: null });
  }

  private updateDraft(patch: Partial<Pick<PromptLibraryDraft, "title" | "body" | "tags">>): void {
    const draft = this.state.draft;
    if (!draft) return;
    this.setState({ draft: { ...draft, ...patch }, error: null });
  }

  private setState(patch: Partial<PromptLibraryManagerSnapshot>): void {
    this.update({ ...this.state, ...patch });
  }

  private update(state: PromptLibraryManagerSnapshot): void {
    const draft = state.draft;
    let dirty = false;
    if (draft) {
      if (draft.original) {
        dirty =
          draft.title !== draft.original.title ||
          draft.body !== draft.original.body ||
          !sameTags(draft.tags, draft.original.tags);
      } else {
        dirty = draft.title.length > 0 || draft.body.length > 0 || draft.tags.length > 0;
      }
    }
    const canSubmit = Boolean(
      draft && draft.title.trim().length > 0 && draft.body.trim().length > 0 && dirty,
    );
    this.state = { ...state, dirty, canSubmit };
    for (const listener of this.listeners) listener();
  }
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "prompt_library_failed";
}
