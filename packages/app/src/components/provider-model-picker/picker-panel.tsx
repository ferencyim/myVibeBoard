import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, ChevronDown, Search } from "lucide-react-native";
import { AgentProfileGlyph, type AgentProfilePicker } from "@/agent-profiles";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ModelProviderGlyph } from "@/components/model-browser";
import {
  filterModelGroups,
  flattenModelGroups,
  groupModelItems,
  moveHighlight,
  resolveEffortControlKind,
  toModelItem,
  type PickerModelItem,
} from "@/components/provider-model-picker/model-list";
import { getProviderModelRows } from "@/provider-selection/provider-selection";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";

export interface PickerThinking {
  options: { id: string; label: string }[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

/** Keyboard hook for the host: returns true when the key was consumed. */
export type PickerKeyHandler = (key: string, preventDefault: () => void) => boolean;

export interface PickerPanelProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  isLoading: boolean;
  thinking?: PickerThinking | null;
  profiles?: AgentProfilePicker | null;
  onPick: (provider: string, modelId: string) => void;
  onApplyProfile?: (profileId: string) => void;
  onRetryProvider?: (provider: string) => void;
  isRetryingProvider?: boolean;
  serverId: string | null;
  autoFocusSearch?: boolean;
  keyHandlerRef?: MutableRefObject<PickerKeyHandler | null>;
}

const PROFILES_TAB = "__profiles__";
const ThemedCheck = withUnistyles(Check);
const ThemedChevron = withUnistyles(ChevronDown);
const ThemedSearch = withUnistyles(Search);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const sheetMapping = (theme: Theme) => ({ color: theme.colors.bgSheet });

interface ListEntry {
  key: string;
  service?: string;
  item?: PickerModelItem;
}

function resolveInitialTab(providers: ProviderSelectorProvider[], selectedProvider: string) {
  return providers.some((entry) => entry.id === selectedProvider)
    ? selectedProvider
    : (providers[0]?.id ?? PROFILES_TAB);
}

export function ProviderModelPanel(props: PickerPanelProps) {
  const { providers, selectedProvider, profiles, onApplyProfile, serverId } = props;
  const hasProfiles = Boolean(profiles && profiles.rows.length > 0 && onApplyProfile);
  const [activeTab, setActiveTab] = useState(() => resolveInitialTab(providers, selectedProvider));
  const showRail = providers.length + (hasProfiles ? 1 : 0) > 1;
  const activeProvider = providers.find((entry) => entry.id === activeTab) ?? null;
  const showProfiles = activeTab === PROFILES_TAB && profiles && onApplyProfile;

  return (
    <View style={styles.root} testID="provider-model-picker">
      {showRail ? (
        <View style={styles.rail}>
          {providers.map((entry) => (
            <RailTab
              key={entry.id}
              id={entry.id}
              label={entry.label}
              subtitle={railSubtitle(entry)}
              active={entry.id === activeTab}
              unavailable={entry.modelSelection.kind === "error"}
              serverId={serverId}
              onSelect={setActiveTab}
            />
          ))}
          {hasProfiles ? (
            <RailTab
              id={PROFILES_TAB}
              label="配置"
              subtitle="预设的模型与参数组合"
              active={activeTab === PROFILES_TAB}
              unavailable={false}
              serverId={serverId}
              onSelect={setActiveTab}
            />
          ) : null}
        </View>
      ) : null}
      <View style={styles.panel}>
        {showProfiles ? (
          <ProfilesPanel rows={profiles.rows} onApply={onApplyProfile} />
        ) : (
          <ProviderBody key={activeTab} {...props} provider={activeProvider} />
        )}
      </View>
    </View>
  );
}

function ProviderBody(props: PickerPanelProps & { provider: ProviderSelectorProvider | null }) {
  const {
    provider,
    selectedProvider,
    selectedModel,
    thinking,
    onPick,
    onRetryProvider,
    isRetryingProvider = false,
    isLoading,
    autoFocusSearch = false,
    keyHandlerRef,
  } = props;
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const viewportHeight = useRef(0);
  const layouts = useRef(new Map<string, { y: number; height: number }>());

  const rows = useMemo(
    () => (provider ? getProviderModelRows(provider).map(toModelItem) : []),
    [provider],
  );
  const groups = useMemo(() => filterModelGroups(groupModelItems(rows), query), [rows, query]);
  const flatItems = useMemo(() => flattenModelGroups(groups), [groups]);
  const entries = useMemo(() => buildEntries(groups), [groups]);

  const handleQuery = useCallback((text: string) => {
    setQuery(text);
    setHighlight(-1);
  }, []);
  const pick = useCallback(
    (item: PickerModelItem) => onPick(item.provider, item.modelId),
    [onPick],
  );
  const ensureVisible = useCallback((key: string) => {
    const layout = layouts.current.get(key);
    if (!layout) return;
    const top = scrollY.current;
    const bottom = top + viewportHeight.current;
    if (layout.y < top) scrollRef.current?.scrollTo({ y: layout.y - 4, animated: false });
    else if (layout.y + layout.height > bottom) {
      scrollRef.current?.scrollTo({
        y: layout.y + layout.height - viewportHeight.current + 4,
        animated: false,
      });
    }
  }, []);

  useEffect(() => {
    if (!keyHandlerRef) return undefined;
    keyHandlerRef.current = (key, preventDefault) => {
      if (key === "ArrowDown" || key === "ArrowUp") {
        preventDefault();
        const next = moveHighlight(highlight, key === "ArrowDown" ? 1 : -1, flatItems.length);
        setHighlight(next);
        const item = flatItems[next];
        if (item) ensureVisible(item.key);
        return true;
      }
      const item = key === "Enter" ? flatItems[highlight] : undefined;
      if (!item) return false;
      preventDefault();
      pick(item);
      return true;
    };
    return () => {
      keyHandlerRef.current = null;
    };
  }, [ensureVisible, flatItems, highlight, keyHandlerRef, pick]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = event.nativeEvent.contentOffset.y;
  }, []);
  const handleListLayout = useCallback((event: LayoutChangeEvent) => {
    viewportHeight.current = event.nativeEvent.layout.height;
  }, []);
  const recordLayout = useCallback((key: string, y: number, height: number) => {
    layouts.current.set(key, { y, height });
  }, []);
  const handleRetry = useCallback(() => {
    if (provider) onRetryProvider?.(provider.id);
  }, [onRetryProvider, provider]);

  const ownsSelection = provider?.id === selectedProvider;
  const showEffort = ownsSelection && thinking && thinking.options.length > 0;
  const highlightedKey = highlight >= 0 ? flatItems[highlight]?.key : undefined;

  return (
    <>
      <View style={styles.titleBlock}>
        <Text style={styles.title} numberOfLines={1}>
          {provider?.label ?? ""}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {panelSubtitle(provider, rows.length, isLoading)}
        </Text>
      </View>
      {provider?.modelSelection.kind === "error" ? (
        <View style={styles.statusBlock} accessibilityRole="alert">
          <Text style={styles.statusText}>{provider.modelSelection.message}</Text>
          {onRetryProvider ? (
            <Button variant="outline" size="xs" disabled={isRetryingProvider} onPress={handleRetry}>
              重试
            </Button>
          ) : null}
        </View>
      ) : (
        <>
          <View style={styles.search}>
            <ThemedSearch size={ICON_SIZE.sm} uniProps={mutedMapping} />
            <AdaptiveTextInput
              onChangeText={handleQuery}
              placeholder="搜索模型"
              autoFocus={autoFocusSearch}
              accessibilityLabel="搜索模型"
              style={styles.searchInput}
            />
          </View>
          <ScrollView
            ref={scrollRef}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={32}
            onScroll={handleScroll}
            onLayout={handleListLayout}
          >
            {entries.map((entry) =>
              entry.item ? (
                <ModelRow
                  key={entry.key}
                  item={entry.item}
                  selected={Boolean(ownsSelection) && entry.item.modelId === selectedModel}
                  highlighted={highlightedKey === entry.key}
                  onPick={pick}
                  onLayoutRow={recordLayout}
                />
              ) : (
                <Text key={entry.key} style={styles.groupHeader} numberOfLines={1}>
                  {entry.service}
                </Text>
              ),
            )}
            {entries.length === 0 ? (
              <EmptyState
                loading={isLoading || provider?.modelSelection.kind === "loading"}
                text={resolveEmptyText(query, isLoading, provider?.label ?? "")}
              />
            ) : null}
          </ScrollView>
        </>
      )}
      {showEffort && thinking ? <EffortRow thinking={thinking} /> : null}
    </>
  );
}

function buildEntries(groups: ReturnType<typeof groupModelItems>): ListEntry[] {
  const list: ListEntry[] = [];
  for (const group of groups) {
    if (group.service) {
      list.push({ key: `h:${group.service}`, service: group.service });
    }
    for (const item of group.items) list.push({ key: item.key, item });
  }
  return list;
}

function EmptyState({ loading, text }: { loading: boolean; text: string }) {
  return (
    <View style={styles.empty}>
      {loading ? <ThemedSpinner size="small" uniProps={mutedMapping} /> : null}
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function resolveGlyphOpacity(active: boolean, unavailable: boolean) {
  if (active) return styles.railGlyphActive;
  return unavailable ? styles.railGlyphDim : styles.railGlyphIdle;
}

function railSubtitle(provider: ProviderSelectorProvider): string {
  if (provider.modelSelection.kind === "error") return provider.modelSelection.message;
  if (provider.modelSelection.kind === "loading") return "正在加载";
  return `${provider.modelSelection.rows.length} 个模型`;
}

function panelSubtitle(
  provider: ProviderSelectorProvider | null,
  count: number,
  isLoading: boolean,
): string {
  if (!provider) return "";
  if (provider.modelSelection.kind === "error") return "不可用";
  if (provider.modelSelection.kind === "loading" || (isLoading && count === 0)) return "正在加载";
  return `${count} 个模型`;
}

function resolveEmptyText(query: string, isLoading: boolean, label: string): string {
  if (query.trim()) return "没有匹配的模型";
  if (isLoading) return "正在加载模型";
  return `${label} 暂无可用模型`;
}

const RailTab = memo(function RailTab(props: {
  id: string;
  label: string;
  subtitle: string;
  active: boolean;
  unavailable: boolean;
  serverId: string | null;
  onSelect: (id: string) => void;
}) {
  const { id, onSelect } = props;
  const handlePress = useCallback(() => onSelect(id), [id, onSelect]);
  const style = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.railTab,
      props.active ? styles.railTabActive : null,
      Boolean(hovered) && !props.active ? styles.railTabHovered : null,
    ],
    [props.active],
  );
  const dim = resolveGlyphOpacity(props.active, props.unavailable);
  return (
    <Tooltip delayDuration={150} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <PressHighlight
          onPress={handlePress}
          style={style}
          accessibilityRole="tab"
          aria-selected={props.active}
          accessibilityLabel={props.label}
          testID={`provider-model-picker-tab-${id}`}
        >
          <View style={[styles.railGlyph, dim]}>
            {id === PROFILES_TAB ? (
              <AgentProfileGlyph size={19} />
            ) : (
              <ModelProviderGlyph
                provider={id}
                serverId={props.serverId}
                size={19}
                tone={props.active ? "foreground" : "muted"}
              />
            )}
          </View>
          {props.unavailable ? <View style={styles.railDot} /> : null}
        </PressHighlight>
      </TooltipTrigger>
      <TooltipContent side="left" align="center" offset={8}>
        <Text style={styles.tooltipTitle}>{props.label}</Text>
        <Text style={styles.tooltipSubtitle}>{props.subtitle}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

const ModelRow = memo(function ModelRow(props: {
  item: PickerModelItem;
  selected: boolean;
  highlighted: boolean;
  onPick: (item: PickerModelItem) => void;
  onLayoutRow: (key: string, y: number, height: number) => void;
}) {
  const { item, onPick, onLayoutRow } = props;
  const handlePress = useCallback(() => {
    if (!props.selected) onPick(item);
  }, [item, onPick, props.selected]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) =>
      onLayoutRow(item.key, event.nativeEvent.layout.y, event.nativeEvent.layout.height),
    [item.key, onLayoutRow],
  );
  const style = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || props.highlighted) && styles.rowHovered,
    ],
    [props.highlighted],
  );
  return (
    <PressHighlight
      onPress={handlePress}
      onLayout={handleLayout}
      style={style}
      accessibilityRole="radio"
      aria-checked={props.selected}
      accessibilityLabel={item.isDefault ? `${item.name}，默认` : item.name}
      testID={`provider-model-picker-row-${item.modelId || "default"}`}
    >
      <View style={[styles.radio, props.selected ? styles.radioOn : null]}>
        {props.selected ? (
          <ThemedCheck size={11} strokeWidth={2.5} uniProps={sheetMapping} />
        ) : null}
      </View>
      <Text style={styles.rowText} numberOfLines={1}>
        {item.name}
      </Text>
      {item.isDefault ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>默认</Text>
        </View>
      ) : null}
    </PressHighlight>
  );
});

function ProfilesPanel(props: {
  rows: AgentProfilePicker["rows"];
  onApply: (profileId: string) => void;
}) {
  return (
    <>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>配置</Text>
        <Text style={styles.subtitle}>预设的模型与参数组合</Text>
      </View>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {props.rows.map((row) => (
          <ProfileRow key={row.id} row={row} onApply={props.onApply} />
        ))}
      </ScrollView>
    </>
  );
}

function ProfileRow(props: {
  row: AgentProfilePicker["rows"][number];
  onApply: (profileId: string) => void;
}) {
  const { row, onApply } = props;
  const handlePress = useCallback(() => onApply(row.id), [onApply, row.id]);
  const style = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.profileRow,
      Boolean(hovered) && styles.rowHovered,
    ],
    [],
  );
  return (
    <PressHighlight onPress={handlePress} style={style} accessibilityRole="button">
      <AgentProfileGlyph icon={row.icon} color={row.color} />
      <View style={styles.profileText}>
        <Text style={styles.rowText} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {row.summary}
        </Text>
      </View>
    </PressHighlight>
  );
}

function EffortRow({ thinking }: { thinking: PickerThinking }) {
  const labels = thinking.options.map((option) => option.label);
  const kind = resolveEffortControlKind(labels);
  return (
    <View style={styles.effortRow} testID="provider-model-picker-effort">
      <Text style={styles.effortLabel}>思考强度</Text>
      {kind === "segmented" ? (
        <View style={styles.segments} accessibilityRole="radiogroup">
          {thinking.options.map((option) => (
            <Segment
              key={option.id}
              option={option}
              selected={option.id === thinking.selectedId}
              onSelect={thinking.onSelect}
            />
          ))}
        </View>
      ) : (
        <EffortSelect thinking={thinking} />
      )}
    </View>
  );
}

function Segment(props: {
  option: { id: string; label: string };
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { option, onSelect } = props;
  const handlePress = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  return (
    <PressHighlight
      onPress={handlePress}
      style={props.selected ? styles.segmentOn : styles.segment}
      accessibilityRole="radio"
      aria-checked={props.selected}
    >
      <Text style={props.selected ? styles.segmentTextOn : styles.segmentText}>{option.label}</Text>
    </PressHighlight>
  );
}

function EffortSelect({ thinking }: { thinking: PickerThinking }) {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const options = useMemo(
    () => thinking.options.map((option) => ({ id: option.id, label: option.label })),
    [thinking.options],
  );
  const current = thinking.options.find((option) => option.id === thinking.selectedId);
  const handleOpen = useCallback(() => setOpen(true), []);
  return (
    <>
      <PressHighlight
        ref={anchorRef}
        collapsable={false}
        onPress={handleOpen}
        style={styles.effortSelect}
        accessibilityRole="button"
      >
        <Text style={styles.segmentText} numberOfLines={1}>
          {current?.label ?? "默认"}
        </Text>
        <ThemedChevron size={ICON_SIZE.xs} uniProps={mutedMapping} />
      </PressHighlight>
      <Combobox
        options={options}
        value={thinking.selectedId ?? ""}
        onSelect={thinking.onSelect}
        searchable={false}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, flexDirection: "row", minHeight: 0, minWidth: 0 },
  rail: {
    width: 52,
    flexShrink: 0,
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: 9,
    paddingHorizontal: 7,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.bgSheetInset,
  },
  railTab: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  railTabActive: { backgroundColor: theme.colors.hoverTint },
  railTabHovered: { backgroundColor: theme.colors.hoverTint },
  railGlyph: { alignItems: "center", justifyContent: "center" },
  railGlyphIdle: { opacity: 0.48 },
  railGlyphActive: { opacity: 1 },
  railGlyphDim: { opacity: 0.28 },
  railDot: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.warning,
    borderWidth: 2,
    borderColor: theme.colors.bgSheetInset,
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.md,
    fontWeight: theme.fontWeight.semibold,
  },
  tooltipSubtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  panel: { flex: 1, minWidth: 0, minHeight: 0, padding: theme.spacing[1.5] },
  titleBlock: { paddingTop: theme.spacing[1.5], paddingBottom: theme.spacing[2], paddingLeft: 10 },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, marginTop: 1 },
  statusBlock: {
    borderRadius: 10,
    backgroundColor: theme.colors.hoverTint,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: 10,
    marginBottom: theme.spacing[1.5],
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  statusText: { color: theme.colors.textSecondary, fontSize: theme.fontSize.sm },
  search: {
    height: 32,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: 10,
    backgroundColor: theme.colors.hoverTint,
    paddingHorizontal: 10,
    marginBottom: theme.spacing[1.5],
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.md,
    outlineWidth: 0,
  },
  list: { flexShrink: 1, flexGrow: 1, minHeight: 0 },
  listContent: { paddingBottom: theme.spacing[1] },
  groupHeader: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    paddingHorizontal: 10,
  },
  row: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: 10,
    paddingVertical: theme.spacing[1.5],
    paddingRight: 10,
    paddingLeft: 10,
  },
  rowHovered: { backgroundColor: theme.colors.hoverTint },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOn: { backgroundColor: theme.colors.foreground, borderColor: theme.colors.foreground },
  rowText: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.md,
  },
  badge: {
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.hoverTint,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
  },
  badgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  empty: { alignItems: "center", gap: theme.spacing[2], padding: theme.spacing[4] },
  emptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: 10,
    padding: 10,
  },
  profileText: { flex: 1, minWidth: 0 },
  effortRow: {
    flexShrink: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    marginHorizontal: -theme.spacing[1.5],
    paddingTop: theme.spacing[1.5],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[1.5],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  effortLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  segments: {
    flexDirection: "row",
    gap: 2,
    padding: 2,
    borderRadius: 10,
    backgroundColor: theme.colors.hoverTint,
  },
  segment: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentOn: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.borderStrong,
  },
  segmentText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  segmentTextOn: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  effortSelect: {
    width: 128,
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    borderRadius: 8,
    backgroundColor: theme.colors.hoverTint,
  },
}));
