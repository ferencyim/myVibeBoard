// Small building blocks of a plugin settings page (WP-99): folded groups, a declarative field list
// and the link to the central "Agent behaviour" page. The same file is kept in every plugin that
// has a settings page (plugins are independent packages).

import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsCard, SettingsInput, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import React, { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

export type Field =
  | { kind: "bool"; key: string; label: string }
  | { kind: "text"; key: string; label: string }
  | { kind: "int"; key: string; label: string; min: number; max: number; nullable?: boolean }
  | { kind: "number"; key: string; label: string; min: number; max: number }
  | { kind: "select"; key: string; label: string; options: ReadonlyArray<{ label: string; value: string }> };

/** Clamp typed text into [min, max]; text that is not a number keeps `fallback`. */
export function clampNumber(text: string, min: number, max: number, fallback: number, integer: boolean): number {
  const n = Number(text);
  if (text.trim() === "" || !Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

/** One card of fields bound to a settings object; `save` receives the whole next value. */
export function FieldsCard<V extends Record<string, unknown>>({
  fields,
  values,
  save,
}: {
  fields: readonly Field[];
  values: V;
  save(next: V): void;
}) {
  const set = (key: string, value: unknown) => save({ ...values, [key]: value });
  return (
    <SettingsCard>
      {fields.map((f) => {
        const current = values[f.key];
        switch (f.kind) {
          case "bool":
            return (
              <SettingsSwitch
                key={f.key}
                label={f.label}
                value={current === true}
                onValueChange={(v: boolean) => set(f.key, v)}
              />
            );
          case "text":
            return (
              <SettingsInput
                key={f.key}
                label={f.label}
                initialValue={String(current ?? "")}
                onChangeText={(text) => set(f.key, text.trim())}
              />
            );
          case "select":
            return (
              <SettingsSelect
                key={f.key}
                label={f.label}
                value={String(current)}
                options={f.options}
                onValueChange={(v: string) => set(f.key, v)}
              />
            );
          default: {
            const integer = f.kind === "int";
            const nullable = f.kind === "int" && f.nullable === true;
            return (
              <SettingsInput
                key={f.key}
                label={f.label}
                initialValue={current === null || current === undefined ? "" : String(current)}
                onChangeText={(text) =>
                  set(
                    f.key,
                    nullable && text.trim() === ""
                      ? null
                      : clampNumber(text, f.min, f.max, typeof current === "number" ? current : f.min, integer),
                  )
                }
              />
            );
          }
        }
      })}
    </SettingsCard>
  );
}

/** A settings group that can be folded away. */
export function Group({
  theme,
  title,
  initiallyOpen = false,
  children,
}: {
  theme: PluginTheme;
  title: string;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={{ gap: 8 }}>
      <Pressable onPress={() => setOpen(!open)} style={{ paddingVertical: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 15 }}>
          {open ? "▾ " : "▸ "}
          {title}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export const Muted = ({ theme, children }: { theme: PluginTheme; children: ReactNode }) => (
  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{children}</Text>
);

/** Host navigation to another plugin's screen (a fork addition; absent on older hosts). */
type CrossPluginNavigation = {
  openPluginScreen?: (input: { pluginId: string; screenId: string }) => void;
};

/** Link to the central "Agent behaviour" page, where this plugin's prompts are edited. */
export function BehaviourLink({
  theme,
  navigation,
  text,
}: {
  theme: PluginTheme;
  navigation: unknown;
  text: string;
}) {
  const open = (navigation as CrossPluginNavigation | undefined)?.openPluginScreen;
  return (
    <View style={{ gap: 8 }}>
      <Muted theme={theme}>{text}</Muted>
      {open ? (
        <Pressable
          onPress={() => open({ pluginId: "vibe-board", screenId: "behaviour" })}
          style={{
            alignSelf: "flex-start",
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}
        >
          <Text style={{ color: theme.colors.foreground }}>打开「Agent 行为」页</Text>
        </Pressable>
      ) : (
        <Muted theme={theme}>在侧栏的「Agent 行为」入口中打开。</Muted>
      )}
    </View>
  );
}
