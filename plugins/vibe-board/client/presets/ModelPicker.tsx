import { useCallback } from "react";
import { View } from "react-native";
import type { Preset } from "../../shared/vibe/contract";
import { Chip, Field, Muted } from "../common/ui";

const CHOICES_STYLE = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };
interface ChoiceProps {
  label: string;
  hint?: string;
  value: string | null;
  selected: boolean;
  onChange: (presetId: string | null) => void;
}
function Choice({ label, hint, value, selected, onChange }: ChoiceProps) {
  const choose = useCallback(() => {
    if (!selected) onChange(value);
  }, [selected, onChange, value]);
  return <Chip label={label} hint={hint} selected={selected} onPress={choose} />;
}
export function ModelPicker({
  label,
  presets,
  value,
  onChange,
  noneLabel,
}: {
  label: string;
  presets: readonly Preset[];
  value: string | null;
  onChange: (presetId: string | null) => void;
  noneLabel: string;
}) {
  return (
    <Field label={label}>
      <View style={CHOICES_STYLE}>
        <Choice label={noneLabel} value={null} selected={value === null} onChange={onChange} />
        {presets.map((preset) => (
          <Choice
            key={preset.id}
            label={preset.name}
            hint={`${preset.provider}/${preset.model}`}
            value={preset.id}
            selected={value === preset.id}
            onChange={onChange}
          />
        ))}
      </View>
      {presets.length === 0 ? <Muted>还没有可用的预设：在「预设管理」里添加。</Muted> : null}
    </Field>
  );
}
