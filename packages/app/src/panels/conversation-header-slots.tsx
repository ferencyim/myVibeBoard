import { createContext, useContext, type ReactNode } from "react";

export interface ConversationHeaderSlots {
  left?: ReactNode;
  ordinaryIdentity?: ReactNode;
  right?: (openMode?: () => void) => ReactNode;
}

const ConversationHeaderSlotsContext = createContext<ConversationHeaderSlots>({});

export const ConversationHeaderSlotsProvider = ConversationHeaderSlotsContext.Provider;

export function useConversationHeaderSlots() {
  return useContext(ConversationHeaderSlotsContext);
}
