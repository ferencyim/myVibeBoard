// Priority, tag and preset pickers (WP-14).

import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  CARD_PRIORITIES,
  type CardPriority,
  type Preset,
  type Tag,
} from "../../shared/vibe/contract";
import { PRIORITY_LABELS, errorMessage } from "../board/logic";
import type { BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { Btn, Chip, Muted, TextField } from "../common/ui";
import { QuotaBadge } from "./usage";
import type { ProviderUsageLike } from "./logic";

export function PrioritySelector({
  value,
  onChange,
}: {
  value: CardPriority;
  onChange: (value: CardPriority) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {CARD_PRIORITIES.map((p) => (
        <Chip key={p} label={PRIORITY_LABELS[p]} selected={value === p} onPress={() => onChange(p)} />
      ))}
    </View>
  );
}

/** Multi-select tag chips plus an inline "new tag" field. */
export function TagSelector({
  tags,
  value,
  onChange,
  api,
  onTagsChanged,
}: {
  tags: readonly Tag[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  api?: BoardApi;
  onTagsChanged?: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  const create = async () => {
    const name = draft.trim();
    if (!name || !api) return;
    try {
      const { tag } = await api.tagsCreate({ name });
      setDraft("");
      onTagsChanged?.();
      onChange([...value, tag.id]);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {tags.map((t) => (
          <Chip key={t.id} label={t.name} selected={value.includes(t.id)} onPress={() => toggle(t.id)} />
        ))}
      </View>
      {api ? (
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <TextField
            style={{ flex: 1 }}
            value={draft}
            onChangeText={setDraft}
            placeholder="新标签"
            onSubmitEditing={create}
          />
          <Btn small label="添加" icon="Plus" onPress={create} disabled={!draft.trim()} />
        </View>
      ) : null}
    </View>
  );
}

function PresetRow({
  preset,
  selected,
  tag,
  usage,
  onPress,
}: {
  preset: Preset;
  selected: boolean;
  tag?: string;
  usage: readonly ProviderUsageLike[] | null;
  onPress: () => void;
}) {
  const { theme } = useHost();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }} numberOfLines={1}>
          {preset.name}
          {tag ? `  · ${tag}` : ""}
        </Text>
        <Muted>
          {preset.provider} / {preset.model}
        </Muted>
      </View>
      <QuotaBadge provider={preset.provider} usage={usage} />
    </Pressable>
  );
}

/**
 * Agent preset picker. Each row shows the provider's remaining quota. When the user's pick differs
 * from the master agent's recommendation both are shown side by side and the user decides.
 */
export function PresetSelector({
  presets,
  value,
  suggestedId,
  onChange,
  usage,
}: {
  presets: readonly Preset[];
  value: string | null;
  suggestedId?: string | null;
  onChange: (presetId: string | null) => void;
  usage: readonly ProviderUsageLike[] | null;
}) {
  const { theme, compact } = useHost();
  const user = presets.find((p) => p.id === value) ?? null;
  const suggested = presets.find((p) => p.id === suggestedId) ?? null;
  const conflict = !!user && !!suggested && user.id !== suggested.id;

  return (
    <View style={{ gap: 8 }}>
      {conflict ? (
        <View
          style={{
            gap: 6,
            padding: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.statusWarning,
          }}
        >
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
            你的选择与总 agent 推荐不一致，请选择其一
          </Text>
          <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Muted>我选的</Muted>
              <PresetRow preset={user} selected usage={usage} onPress={() => onChange(user.id)} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Muted>总 agent 推荐</Muted>
              <PresetRow
                preset={suggested}
                selected={false}
                usage={usage}
                onPress={() => onChange(suggested.id)}
              />
            </View>
          </View>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected: value === null }}
        onPress={() => onChange(null)}
        style={{
          padding: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: value === null ? theme.colors.accent : theme.colors.border,
          backgroundColor: value === null ? theme.colors.surface2 : theme.colors.surface1,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>
          {suggested ? `不预选（采用推荐：${suggested.name}）` : "不预选（采用推荐或项目默认）"}
        </Text>
      </Pressable>
      {presets.map((p) => (
        <PresetRow
          key={p.id}
          preset={p}
          selected={value === p.id}
          tag={p.id === suggestedId ? "推荐" : undefined}
          usage={usage}
          onPress={() => onChange(p.id)}
        />
      ))}
      {presets.length === 0 ? <Muted>还没有预设，点击“管理”添加。</Muted> : null}
    </View>
  );
}
