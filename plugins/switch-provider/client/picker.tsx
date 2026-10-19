import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { switchSession } from "../shared/convert";

// A panel, not a popover: only panels receive `navigation`, which is how the new agent gets focused.
export function SwitchPanel({ theme, agentId, navigation }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const switchRpc = useRpc(switchSession);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const catalog = useQuery({
    queryKey: ["switch-provider", "catalog"],
    queryFn: async () => {
      const { entries } = await paseo.providers.snapshot();
      return entries.filter((entry) => entry.enabled && entry.status === "ready");
    },
  });
  const styles = useMemo(
    () => ({
      box: { padding: 32, alignItems: "center" as const },
      column: { width: "100%" as const, maxWidth: 560, gap: 16 },
      title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" as const },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
      heading: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
      list: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden" as const },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
      divider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
      pressed: { backgroundColor: theme.colors.surface1 },
      label: { flex: 1, color: theme.colors.foreground, fontSize: 14 },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme],
  );
  async function pick(provider: string, modelId: string) {
    setError(null);
    setBusy(true);
    try {
      const created = await switchRpc({ agentId, provider, modelId });
      navigation?.openAgent({ agentId: created.agentId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      return;
    }
    setBusy(false);
  }
  const provider = catalog.data?.find((entry) => entry.provider === chosen);
  const rows = provider
    ? (provider.models ?? [])
        .filter((model) => model.isSelectable !== false)
        .map((model) => ({ key: model.id, label: model.label, detail: model.id, onPress: () => pick(provider.provider, model.id) }))
    : (catalog.data ?? []).map((entry) => {
        const count = (entry.models ?? []).filter((model) => model.isSelectable !== false).length;
        return {
          key: entry.provider,
          label: entry.label ?? entry.provider,
          detail: `${count} ${count === 1 ? "model" : "models"}`,
          onPress: () => setChosen(entry.provider),
        };
      });
  let heading = "Choose a provider";
  if (busy) heading = "Switching…";
  else if (catalog.isPending) heading = "Loading providers…";
  else if (catalog.isError) heading = "Could not load providers";
  else if (provider) heading = `${provider.label ?? provider.provider}: choose a model`;
  const muted = theme.colors.foregroundMuted;
  return (
    <ScrollView contentContainerStyle={styles.box}>
      <View style={styles.column}>
        <View style={{ gap: 6 }}>
          <Text style={styles.title}>Continue on another provider</Text>
          <Text style={styles.subtitle}>
            Starts a new agent in this workspace with the full conversation, including tool calls. This agent keeps running.
          </Text>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.heading}>{heading.toUpperCase()}</Text>
        <View style={styles.list}>
          {provider ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to providers"
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              onPress={() => setChosen(null)}
            >
              <Icon name="ArrowLeft" size={16} color={muted} />
              <Text style={styles.label}>Providers</Text>
            </Pressable>
          ) : null}
          {rows.map((row, index) => (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              accessibilityLabel={row.label}
              disabled={busy}
              style={({ pressed }) => [styles.row, (provider || index > 0) && styles.divider, pressed && styles.pressed]}
              onPress={row.onPress}
            >
              <Text style={styles.label}>{row.label}</Text>
              <Text style={styles.detail}>{row.detail}</Text>
              <Icon name="ChevronRight" size={16} color={muted} />
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
