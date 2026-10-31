import { type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import React, { useCallback } from "react";

export function BehaviourSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const openBehaviour = useCallback(() => openScreen({ screenId: "behaviour" }), [openScreen]);
  return (
    <SidebarRow
      icon="Bot"
      label="Agent 行为"
      active={currentScreen?.screenId === "behaviour"}
      onPress={openBehaviour}
    />
  );
}
