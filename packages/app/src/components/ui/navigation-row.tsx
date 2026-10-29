import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";

export function NavigationRow({
  title,
  description,
  status,
  onPress,
  testID,
}: {
  title: string;
  description?: string;
  status?: string;
  onPress(): void;
  testID?: string;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} testID={testID}>
      {({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <View style={[styles.row, (pressed || hovered) && styles.active]}>
          <View style={styles.content}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {description ? (
              <Text style={styles.description} numberOfLines={1}>
                {description}
              </Text>
            ) : null}
          </View>
          {status ? <Text style={styles.description}>{status}</Text> : null}
          <ChevronRight size={16} color={styles.description.color} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
  },
  active: { backgroundColor: theme.colors.surface2 },
  content: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
