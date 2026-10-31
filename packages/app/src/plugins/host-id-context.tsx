import { createContext, useContext } from "react";

export const PluginHostIdContext = createContext<string | null>(null);
export const usePluginHostId = () => useContext(PluginHostIdContext);
