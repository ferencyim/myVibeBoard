import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useHosts } from "@/runtime/host-runtime";
import type { SidebarGroupingMode } from "./sidebar-grouping";

interface Preferences {
  modes: Record<string, SidebarGroupingMode>;
  setMode: (host: string, mode: SidebarGroupingMode) => void;
}

const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      modes: {},
      setMode: (host, mode) => set((state) => ({ modes: { ...state.modes, [host]: mode } })),
    }),
    {
      name: "sidebar-grouping-preferences",
      storage: createValidatedPersistStorage(
        AsyncStorage,
        z.object({
          modes: z.record(z.string(), z.enum(["project", "date", "status"])),
        }),
      ),
      partialize: (state) => ({ modes: state.modes }),
    },
  ),
);

export function useSidebarGroupingPreference() {
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const hosts = useHosts();
  let host = "";
  if (hostFilters.length === 1) host = hostFilters[0];
  else if (hosts.length === 1) host = hosts[0].serverId;
  const mode = usePreferences((state) => state.modes[host] ?? "project");
  const setMode = usePreferences((state) => state.setMode);
  const changeMode = useCallback(
    (value: SidebarGroupingMode) => setMode(host, value),
    [host, setMode],
  );
  return { mode, changeMode };
}

const options = [
  { value: "project", label: "项目" },
  { value: "date", label: "日期" },
  { value: "status", label: "状态" },
] satisfies { value: SidebarGroupingMode; label: string }[];

export function SidebarGroupingControl() {
  const { mode, changeMode } = useSidebarGroupingPreference();
  return (
    <SegmentedControl
      options={options}
      value={mode}
      onValueChange={changeMode}
      size="xs"
      testID="sidebar-grouping"
    />
  );
}
