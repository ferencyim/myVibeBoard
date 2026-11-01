/* eslint-disable react-perf/jsx-no-new-function-as-prop, eslint/max-nested-callbacks, react/no-array-index-key -- Draft rows are edited in place and callbacks capture their row. */
import { useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ModelGroup } from "@getpaseo/protocol/messages";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { sortModelGroupEntries } from "./model-groups-form";

export function ModelGroupsPage({ serverId }: { serverId: string }) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const supported = useSessionStore((state) =>
    Boolean(state.sessions[serverId]?.serverInfo?.features?.modelGroups),
  );
  const snapshot = useProvidersSnapshot(serverId);
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const [draft, setDraft] = useState<ModelGroup[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowRevision, setRowRevision] = useState(0);
  const groups = draft ?? config?.modelGroups ?? [];
  const updateGroup = (index: number, update: (group: ModelGroup) => ModelGroup) => {
    setDraft(groups.map((group, i) => (i === index ? update(group) : group)));
  };
  const save = async () => {
    if (
      groups.some(
        (group) =>
          !group.name.trim() ||
          group.entries.some((entry) => !entry.provider || !Number.isFinite(entry.order)),
      )
    ) {
      Alert.alert("无法保存", "请填写组名、有效序号和模型。");
      return;
    }
    setSaving(true);
    try {
      const saved = await patchConfig({ modelGroups: sortModelGroupEntries(groups) });
      if (!saved) throw new Error("主机未连接。");
      setDraft(null);
      setRowRevision((value) => value + 1);
    } catch (error) {
      Alert.alert("无法保存", error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  if (!supported || !config) {
    return (
      <SettingsSection title="模型组">
        <Text style={styles.hint}>
          {supported ? "正在加载…" : "连接支持模型组的主机后可使用此功能。"}
        </Text>
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title="模型组" info="按序号依次尝试组内模型。">
      <View style={styles.container}>
        {groups.map((group, groupIndex) => (
          <View key={group.id} style={[settingsStyles.card, styles.group]}>
            <Text style={styles.label}>组名</Text>
            <FormTextInput
              accessibilityLabel="组名"
              initialValue={group.name}
              resetKey={`${group.id}-${rowRevision}`}
              onChangeText={(name) => updateGroup(groupIndex, (current) => ({ ...current, name }))}
            />
            {group.entries.map((entry, entryIndex) => (
              <View key={`${entryIndex}-${rowRevision}`} style={styles.entry}>
                <View style={styles.order}>
                  <FormTextInput
                    accessibilityLabel="序号"
                    keyboardType="numeric"
                    initialValue={Number.isNaN(entry.order) ? "" : String(entry.order)}
                    resetKey={`${group.id}-${entryIndex}`}
                    onChangeText={(value) =>
                      updateGroup(groupIndex, (current) => ({
                        ...current,
                        entries: current.entries.map((item, i) =>
                          i === entryIndex
                            ? { ...item, order: value.trim() ? Number(value) : NaN }
                            : item,
                        ),
                      }))
                    }
                  />
                </View>
                <View style={styles.model}>
                  <CombinedModelSelector
                    providers={providers}
                    selectedProvider={entry.provider}
                    selectedModel={entry.model}
                    onSelect={(provider, model) =>
                      updateGroup(groupIndex, (current) => ({
                        ...current,
                        entries: current.entries.map((item, i) =>
                          i === entryIndex
                            ? { ...item, provider, model, thinkingOptionId: undefined }
                            : item,
                        ),
                      }))
                    }
                    isLoading={snapshot.isLoading || snapshot.isFetching}
                    onOpen={() => snapshot.refetchIfStale()}
                    serverId={serverId}
                    triggerFill
                  />
                </View>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    updateGroup(groupIndex, (current) => ({
                      ...current,
                      entries: current.entries.filter((_, i) => i !== entryIndex),
                    }));
                    setRowRevision((value) => value + 1);
                  }}
                >
                  删除
                </Button>
              </View>
            ))}
            <View style={styles.actions}>
              <Button
                variant="secondary"
                size="sm"
                onPress={() =>
                  updateGroup(groupIndex, (current) => ({
                    ...current,
                    entries: [
                      ...current.entries,
                      { order: current.entries.length + 1, provider: "", model: "" },
                    ],
                  }))
                }
              >
                添加模型
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onPress={() => setDraft(groups.filter((_, i) => i !== groupIndex))}
              >
                删除组
              </Button>
            </View>
          </View>
        ))}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            onPress={() =>
              setDraft([
                ...groups,
                {
                  id: `model_group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
                  name: "",
                  entries: [],
                },
              ])
            }
          >
            新增模型组
          </Button>
          <Button onPress={() => void save()} disabled={draft === null || saving}>
            保存
          </Button>
          {draft !== null ? (
            <Button
              variant="ghost"
              onPress={() => {
                setDraft(null);
                setRowRevision((value) => value + 1);
              }}
              disabled={saving}
            >
              取消
            </Button>
          ) : null}
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[4] },
  group: { padding: theme.spacing[4], gap: theme.spacing[3] },
  label: { color: theme.colors.textPrimary, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.textMuted, fontSize: theme.fontSize.base },
  entry: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  order: { width: 72 },
  model: { flex: 1, minWidth: 140 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
