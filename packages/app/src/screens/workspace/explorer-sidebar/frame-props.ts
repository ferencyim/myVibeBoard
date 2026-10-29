import type { ReactNode } from "react";
export interface ExplorerFrameProps {
  children: ReactNode;
  presentation: "overlay" | "dock";
  persistenceKey: string;
  containerWidth: number;
  fixedWidth?: number;
  isOpen: boolean;
  isWorkspaceActive: boolean;
  surfaceColor?: string;
}
