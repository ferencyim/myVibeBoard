import { StyleSheet } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";

type ProviderGlyphTone = "muted" | "foreground";

export function ModelProviderGlyph({
  provider,
  serverId,
  size,
  tone = "muted",
}: {
  provider: string;
  serverId: string | null;
  size: number;
  tone?: ProviderGlyphTone;
}) {
  const Icon = useProviderIcon(provider, serverId);
  const color =
    tone === "foreground" ? styles.providerIconForeground.color : styles.providerIconMuted.color;
  return <Icon size={size} color={color} />;
}

const styles = StyleSheet.create((theme) => ({
  providerIconMuted: { color: theme.colors.foregroundMuted },
  providerIconForeground: { color: theme.colors.foreground },
}));
