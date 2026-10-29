import { MenuRoot } from "@/components/ui/menu";
import type { ComponentProps } from "react";

/** Uses the shared menu engine and opts compact surfaces into its bottom sheet. */
export function Menu({ compactMode = "sheet", ...props }: ComponentProps<typeof MenuRoot>) {
  return <MenuRoot compactMode={compactMode} {...props} />;
}

export {
  MenuTrigger,
  MenuSurface,
  MenuItem,
  MenuSeparator,
  MenuLabel,
  MenuHint,
  MenuSubTrigger,
  MenuTextField,
  type MenuItemProps,
  type MenuSurfaceProps,
  type MenuPageDefinition,
} from "@/components/ui/menu";
