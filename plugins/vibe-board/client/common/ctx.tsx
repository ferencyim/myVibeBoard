import type { PluginTheme } from "@getpaseo/plugin";
import React, { createContext, useContext, type ReactNode } from "react";

export interface HostValue {
  theme: PluginTheme;
  compact: boolean;
  openAgent?: (input: { readonly agentId: string }) => void;
}

const HostContext = createContext<HostValue | null>(null);

export function HostProvider({ value, children }: { value: HostValue; children: ReactNode }) {
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function useHost(): HostValue {
  const value = useContext(HostContext);
  if (!value) throw new Error("useHost must run inside HostProvider");
  return value;
}
