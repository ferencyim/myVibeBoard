// Single choice of an agent preset for one job of the card (WP-105): scout / planning model on the
// plan tab, executing / reviewing model on the execution tab. Offered: presets whose purpose
// includes the job, or that have no purpose set. Chips wrap, so it fits a phone.

import React from "react";
import { View } from "react-native";
import type { Preset, RoleHint } from "../../shared/vibe/contract";
import { Chip, Field, Muted } from "../common/ui";
import { presetsFor } from "./logic";

export function ModelPicker({
  label,
  role,
  presets,
  value,
  onChange,
  noneLabel,
  hint,
  disabled,
}: {
  label: string;
  role: RoleHint;
  presets: readonly Preset[];
  value: string | null;
  onChange: (presetId: string | null) => void;
  /** Offer "none" (e.g. 不探路 / 不复核); omitted = a model must be picked. */
  noneLabel?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const offered = presetsFor(presets, role);
  // A picked preset whose purpose changed later stays visible so the choice is not silently lost.
  const picked = presets.find((p) => p.id === value);
  const list = picked && !offered.includes(picked) ? [...offered, picked] : offered;
  const pick = (id: string | null) => {
    if (!disabled && id !== value) onChange(id);
  };
  return (
    <Field label={label} hint={hint}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {noneLabel ? <Chip label={noneLabel} selected={value === null} onPress={() => pick(null)} /> : null}
        {list.map((p) => (
          <Chip key={p.id} label={p.name} hint={`${p.provider}/${p.model}`} selected={value === p.id} onPress={() => pick(p.id)} />
        ))}
      </View>
      {list.length === 0 ? <Muted>还没有可用的预设：在「预设管理」里添加，并在「用途」里勾选。</Muted> : null}
    </Field>
  );
}
