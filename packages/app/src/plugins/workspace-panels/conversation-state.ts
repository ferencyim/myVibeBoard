import { create } from "zustand";

export interface ConversationPanelSelection {
  pluginId: string;
  panelId: string;
}

interface ConversationPanelState {
  selections: ReadonlyMap<string, ConversationPanelSelection>;
  open(key: string, selection: ConversationPanelSelection): void;
  close(key: string): void;
}

export const useConversationPanelStore = create<ConversationPanelState>((set) => ({
  selections: new Map(),
  open(key, selection) {
    set((state) => {
      const selections = new Map(state.selections);
      selections.set(key, selection);
      return { selections };
    });
  },
  close(key) {
    set((state) => {
      const selections = new Map(state.selections);
      selections.delete(key);
      return { selections };
    });
  },
}));
