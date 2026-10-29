/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- Small plugin kit; row styles depend on per-row state. */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { Children, createContext, Fragment, useContext, useMemo, type PropsWithChildren, type ReactNode } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { avatarColor, avatarInitial } from "./profile-mapping";

/** Layout numbers of the settings panel; the same rows serve the 360 drawer, the settings screen and the phone sheet. */
export const KIT = { gap: 16, rowHeight: 40, radius: 8, headerHeight: 39, avatar: 62, textareaHeight: 120, sidePadding: 15, rowPadding: 12 } as const;

function createKitStyles(theme: PluginTheme) {
  const c = theme.colors;
  return StyleSheet.create({
    body: { flex: 1, backgroundColor: c.surface0 },
    bodyContent: { paddingTop: 24, paddingHorizontal: KIT.sidePadding, paddingBottom: 28, gap: KIT.gap },
    header: { height: KIT.headerHeight, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.surface0 },
    headerSide: { width: 32, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 6 },
    headerTitle: { flex: 1, textAlign: "center", color: c.foreground, fontSize: 13, fontWeight: "600" },
    field: { gap: 6 },
    label: { color: c.foregroundMuted, fontSize: 13, lineHeight: 18, paddingLeft: 8 },
    input: { color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: KIT.radius, paddingVertical: 10, paddingHorizontal: 11, fontSize: 14, lineHeight: 19, minHeight: 38, backgroundColor: c.surface1 },
    inputInvalid: { borderColor: c.statusDanger },
    textarea: { height: KIT.textareaHeight, textAlignVertical: "top" },
    note: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16, paddingLeft: 8 },
    error: { color: c.statusDanger, fontSize: 12, lineHeight: 16, paddingLeft: 8 },
    groupWrap: { gap: 6 },
    groupTitle: { color: c.foregroundMuted, fontSize: 12, fontWeight: "500", paddingLeft: 4 },
    card: { borderWidth: 1, borderColor: c.border, borderRadius: KIT.radius, backgroundColor: c.surface1 },
    rowSeparator: { borderTopWidth: 1, borderColor: c.border },
    row: { minHeight: KIT.rowHeight, paddingHorizontal: KIT.rowPadding, flexDirection: "row", alignItems: "center", gap: 8 },
    rowLabelBlock: { flex: 1, minWidth: 0, paddingVertical: 6 },
    rowLabel: { color: c.foreground, fontSize: 13, fontWeight: "500", lineHeight: 18 },
    rowHint: { color: c.foregroundMuted, fontSize: 12, lineHeight: 15 },
    rowValue: { color: c.foregroundMuted, fontSize: 12, maxWidth: 160 },
    rowControl: { flexShrink: 1, alignItems: "flex-end" },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.5 },
    button: { minHeight: 32, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: c.border, borderRadius: 6 },
    buttonText: { color: c.foreground, fontSize: 13, fontWeight: "500" },
    buttonDangerText: { color: c.statusDanger },
    avatarWrap: { alignItems: "center", marginTop: 8, marginBottom: 0 },
    avatarBadge: { position: "absolute", right: -4, bottom: -4, width: 24, height: 24, borderRadius: 12, borderWidth: 3, borderColor: c.surface0, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" },
    avatarCircle: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
    avatarInitial: { color: "#ffffff", fontWeight: "600" },
    popover: { alignSelf: "center", width: 284, maxWidth: "100%", borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.surface1, overflow: "hidden" },
    popoverTitle: { minHeight: 40, paddingTop: 7, paddingBottom: 3, paddingLeft: 13, paddingRight: 10, color: c.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.3 },
    swatchGrid: { flexDirection: "row", flexWrap: "wrap", gap: 5, paddingHorizontal: 10, paddingBottom: 12 },
    swatch: { width: 40, height: 40, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "transparent" },
    swatchSelected: { borderColor: c.foregroundMuted, backgroundColor: c.surface2 },
    swatchDot: { width: 18, height: 18, borderRadius: 9 },
  });
}
type KitStyles = ReturnType<typeof createKitStyles>;
interface KitContextValue { theme: PluginTheme; styles: KitStyles }
const KitContext = createContext<KitContextValue | null>(null);

export function KitProvider({ theme, children }: PropsWithChildren<{ theme: PluginTheme }>) {
  const value = useMemo(() => ({ theme, styles: createKitStyles(theme) }), [theme]);
  return <KitContext.Provider value={value}>{children}</KitContext.Provider>;
}
export function useKit(): KitContextValue {
  const value = useContext(KitContext);
  if (!value) throw new Error("KitProvider is missing");
  return value;
}

/** Scrolling body with the panel padding and the 16px block gap. */
export function SettingsBody({ children }: PropsWithChildren) {
  const { styles } = useKit();
  return <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}

/** 39px header for sub-pages: back, centered title, balancing spacer. */
export function SubPageHeader({ title, onBack }: { title: string; onBack(): void }) {
  const { styles, theme } = useKit();
  return <View style={styles.header}>
    <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={onBack} hitSlop={6} style={styles.headerSide}><Icon name="ArrowLeft" size={16} color={theme.colors.foreground} /></Pressable>
    <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
    <View style={styles.headerSide} />
  </View>;
}

interface FieldProps { label: string; value: string; onChangeText(value: string): void; onBlur?(): void; placeholder?: string; error?: string | null; note?: string; maxLength?: number }
export function Field({ label, value, onChangeText, onBlur, placeholder, error, note, maxLength }: FieldProps) {
  const { styles, theme } = useKit();
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} onBlur={onBlur} placeholder={placeholder} placeholderTextColor={theme.colors.foregroundMuted} maxLength={maxLength} style={[styles.input, error ? styles.inputInvalid : null]} />
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : note ? <Text style={styles.note}>{note}</Text> : null}
  </View>;
}

/** Fixed-height multiline field; long text scrolls inside it. */
export function TextArea({ label, value, onChangeText, onBlur, placeholder, error, note, height = KIT.textareaHeight }: FieldProps & { height?: number }) {
  const { styles, theme } = useKit();
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} onBlur={onBlur} placeholder={placeholder} placeholderTextColor={theme.colors.foregroundMuted} multiline style={[styles.input, styles.textarea, { height }, error ? styles.inputInvalid : null]} />
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : note ? <Text style={styles.note}>{note}</Text> : null}
  </View>;
}

/** Inset card: optional title above, 1px separators between rows. */
export function Group({ title, children }: PropsWithChildren<{ title?: string }>) {
  const { styles } = useKit();
  const rows = Children.toArray(children).filter(Boolean);
  if (!rows.length) return null;
  return <View style={styles.groupWrap}>
    {title ? <Text style={styles.groupTitle}>{title}</Text> : null}
    <View style={styles.card}>{rows.map((row, index) => <Fragment key={index}><View style={index ? styles.rowSeparator : undefined}>{row}</View></Fragment>)}</View>
  </View>;
}

interface RowBase { icon?: string; label: string; hint?: string; disabled?: boolean }
function RowLabel({ icon, label, hint }: Pick<RowBase, "icon" | "label" | "hint">) {
  const { styles, theme } = useKit();
  return <>
    {icon ? <Icon name={icon} size={14} color={theme.colors.foregroundMuted} /> : null}
    <View style={styles.rowLabelBlock}><Text style={styles.rowLabel}>{label}</Text>{hint ? <Text style={styles.rowHint}>{hint}</Text> : null}</View>
  </>;
}

/** Navigation row: label left, current value and chevron right. */
export function NavRow({ icon, label, hint, value, onPress, disabled }: RowBase & { value?: string; onPress(): void }) {
  const { styles, theme } = useKit();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null, disabled ? styles.disabled : null]}>
    <RowLabel icon={icon} label={label} hint={hint} />
    {value ? <Text style={styles.rowValue} numberOfLines={1}>{value}</Text> : null}
    <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
  </Pressable>;
}

export function SwitchRow({ icon, label, hint, value, onValueChange, disabled }: RowBase & { value: boolean; onValueChange(value: boolean): void }) {
  const { styles, theme } = useKit();
  return <View style={[styles.row, disabled ? styles.disabled : null]}>
    <RowLabel icon={icon} label={label} hint={hint} />
    <Switch accessibilityLabel={label} value={value} onValueChange={onValueChange} disabled={disabled} trackColor={{ true: theme.colors.accent, false: theme.colors.border }} />
  </View>;
}

/** Label left, any control (an inline select, a button) right; vertically centred. */
export function ControlRow({ icon, label, hint, children }: RowBase & { children: ReactNode }) {
  const { styles } = useKit();
  return <View style={styles.row}>
    <RowLabel icon={icon} label={label} hint={hint} />
    <View style={styles.rowControl}>{children}</View>
  </View>;
}

export function ValueRow({ label, value }: { label: string; value: string }) {
  const { styles } = useKit();
  return <View style={styles.row}><RowLabel label={label} /><Text style={styles.rowValue} numberOfLines={1}>{value}</Text></View>;
}

export function Caption({ children }: PropsWithChildren) {
  const { styles } = useKit();
  return <Text style={styles.note}>{children}</Text>;
}

export function ErrorLine({ error }: { error?: unknown }) {
  const { styles } = useKit();
  return error ? <Text accessibilityRole="alert" style={styles.error}>{String(error)}</Text> : null;
}

export function OutlineButton({ label, onPress, disabled, danger }: { label: string; onPress(): void; disabled?: boolean; danger?: boolean }) {
  const { styles } = useKit();
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, pressed ? styles.pressed : null, disabled ? styles.disabled : null]}>
    <Text style={[styles.buttonText, danger ? styles.buttonDangerText : null]}>{label}</Text>
  </Pressable>;
}

/** Initial-on-hue circle, matching the host avatar look. */
export function BotAvatar({ name, hue, size }: { name: string; hue: number; size: number }) {
  const { styles } = useKit();
  return <View accessibilityRole="image" accessibilityLabel={name} style={[styles.avatarCircle, { width: size, height: size, borderRadius: size / 2, backgroundColor: avatarColor(hue) }]}>
    <Text style={[styles.avatarInitial, { fontSize: Math.round(size * 0.42), lineHeight: size }]}>{avatarInitial(name)}</Text>
  </View>;
}

/** Header avatar with the pencil badge; pressing it opens the color popover. */
export function AvatarButton({ name, hue, onPress }: { name: string; hue: number; onPress(): void }) {
  const { styles, theme } = useKit();
  return <View style={styles.avatarWrap}>
    <Pressable accessibilityRole="button" accessibilityLabel="编辑头像" onPress={onPress} style={({ pressed }) => (pressed ? styles.pressed : null)}>
      <BotAvatar name={name} hue={hue} size={KIT.avatar} />
      <View style={styles.avatarBadge}><Icon name="Pencil" size={11} color={theme.colors.foreground} /></View>
    </Pressable>
  </View>;
}

export function AvatarPopover({ hue, hues, onPick }: { hue: number; hues: ReadonlyArray<{ hue: number; label: string }>; onPick(hue: number): void }) {
  const { styles } = useKit();
  return <View style={styles.popover}>
    <Text style={styles.popoverTitle}>颜色</Text>
    <View style={styles.swatchGrid}>
      {hues.map((item) => <Pressable key={item.hue} accessibilityRole="button" accessibilityState={{ selected: item.hue === hue }} accessibilityLabel={item.label} onPress={() => onPick(item.hue)} style={[styles.swatch, item.hue === hue ? styles.swatchSelected : null]}>
        <View style={[styles.swatchDot, { backgroundColor: avatarColor(item.hue) }]} />
      </Pressable>)}
    </View>
  </View>;
}
