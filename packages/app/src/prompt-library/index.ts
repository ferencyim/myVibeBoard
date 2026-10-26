import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { useSyncExternalStore } from "react";
import { PromptLibraryModel } from "./internal/model";
import type { PromptLibraryHostSnapshot } from "./internal/types";

export const promptLibrary = new PromptLibraryModel({
  storage: AsyncStorage,
  createId: () => randomUUID(),
});

export function usePromptLibraryHost(serverId: string): PromptLibraryHostSnapshot {
  const subscribe = promptLibrary.subscribe;
  const getSnapshot = () => promptLibrary.getSnapshot(serverId);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export { PromptLibraryModel } from "./internal/model";
export { filterPromptEntries } from "./internal/merge";
export type {
  PromptLibraryHostSnapshot,
  PromptLibraryHostStatus,
  PromptLibraryRemote,
  PromptLibraryStorage,
} from "./internal/types";
