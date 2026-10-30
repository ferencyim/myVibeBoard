import { useCallback, useMemo } from "react";
import type { ActionMenuProps } from "@getpaseo/plugin/client/ui";
import { MoreVertical } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmDialog } from "@/utils/confirm-dialog";

const ThemedMoreVertical = withUnistyles(MoreVertical);
const mutedColor = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

/**
 * Row menu for plugins: a kebab trigger plus the host dropdown/sheet. The plugin opens it from a
 * right click or long press through `open`; the kebab stays mounted (hidden) so it stays the anchor.
 */
export function ActionMenu({
  label,
  items,
  onSelect,
  open,
  onOpenChange,
  visible = true,
}: ActionMenuProps) {
  const select = useCallback(
    async (id: string) => {
      const item = items.find((entry) => entry.id === id);
      if (item?.confirm) {
        const ok = await confirmDialog({ ...item.confirm, destructive: item.destructive });
        if (!ok) return;
      }
      onSelect(id);
    },
    [items, onSelect],
  );
  const triggerStyle = useMemo(() => [styles.trigger, !visible && styles.hidden], [visible]);
  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <ThemedMoreVertical size={14} uniProps={mutedColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={180} sheetTitle={label}>
        {items.map((item) => (
          <ActionMenuEntry
            key={item.id}
            id={item.id}
            destructive={item.destructive}
            onSelect={select}
          >
            {item.label}
          </ActionMenuEntry>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionMenuEntry({
  id,
  destructive,
  onSelect,
  children,
}: {
  id: string;
  destructive?: boolean;
  onSelect(id: string): void;
  children: string;
}) {
  const handle = useCallback(() => onSelect(id), [onSelect, id]);
  return (
    <DropdownMenuItem destructive={destructive} onSelect={handle}>
      {children}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create(() => ({
  trigger: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  hidden: { opacity: 0 },
}));
