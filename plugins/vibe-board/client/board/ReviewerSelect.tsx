import React from "react";
import { View } from "react-native";
import type { Preset } from "../../shared/vibe/contract";
import { Chip, Muted } from "../common/ui";

/** Picks the preset whose model reviews the finished card (one tap on the selected chip clears it). */
export function ReviewerSelect({
  presets,
  value,
  onChange,
}: {
  presets: readonly Preset[];
  value: string | null;
  onChange: (presetId: string | null) => void;
}) {
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Chip label="不复核" selected={value === null} onPress={() => onChange(null)} />
        {presets.map((p) => (
          <Chip
            key={p.id}
            label={p.name}
            selected={value === p.id}
            onPress={() => onChange(value === p.id ? null : p.id)}
          />
        ))}
      </View>
      {presets.length === 0 ? <Muted>还没有预设。</Muted> : null}
    </View>
  );
}
