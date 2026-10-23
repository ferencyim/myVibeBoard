// Single choice of an agent preset for one job of the card (WP-105): scout / planning / plan review
// model on the plan tab, main / sub-agent model on the execution tab, reviewer on the review tab,
// verifier on the verification tab (WP-108). All presets are available for every job.

import React from "react";
import { View } from "react-native";
import type { Preset } from "../../shared/vibe/contract";
import { Chip, Field, Muted } from "../common/ui";

export function ModelPicker({
  label,
  presets,
  value,
  onChange,
  noneLabel,
  fallback,
  hint,
  disabled,
}: {
  label: string;
  presets: readonly Preset[];
  value: string | null;
  onChange: (presetId: string | null) => void;
  /** Offer "none" (e.g. 不探路 / 不复核); the job is skipped without a pick. */
  noneLabel?: string;
  /**
   * WP-108: the job falls back to the project / global default without a pick. The empty choice shows
   * that default ("名称（项目默认）"); null = no default set either.
   */
  fallback?: string | null;
  hint?: string;
  disabled?: boolean;
}) {
  const pick = (id: string | null) => {
    if (!disabled && id !== value) onChange(id);
  };
  const empty =
    noneLabel ?? (fallback !== undefined ? (fallback ? `默认：${fallback}` : "默认（未设置）") : undefined);
  return (
    <Field label={label} hint={hint}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {empty ? <Chip label={empty} selected={value === null} onPress={() => pick(null)} /> : null}
        {presets.map((p) => (
          <Chip key={p.id} label={p.name} hint={`${p.provider}/${p.model}`} selected={value === p.id} onPress={() => pick(p.id)} />
        ))}
      </View>
      {presets.length === 0 ? <Muted>还没有可用的预设：在「预设管理」里添加。</Muted> : null}
    </Field>
  );
}
