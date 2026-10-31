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
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Check, Search } from "lucide-react-native";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { RefreshModelsButton } from "./refresh-models-button";
import { Switch } from "@/components/ui/switch";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ModelProviderGlyph } from "@/components/model-provider-glyph";
import {
  filterModelGroups,
  flattenModelGroups,
  groupModelItems,
  localizeEffortLabel,
  moveHighlight,
  toModelItem,
  type PickerModelItem,
} from "@/components/provider-model-picker/model-list";
import { getProviderModelRows } from "@/provider-selection/provider-selection";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";

/** Fast-mode switch of the selected model; absent when the provider reports no fast feature. */
export interface PickerFast {
  value: boolean;
  onChange: (value: boolean) => void;
}

export interface PickerThinking {
  options: { id: string; label: string }[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

/** Permission modes of the selected provider; the picker is the only place they are changed. */
export interface PickerPermission {
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
  fast?: PickerFast | null;
  permission?: PickerPermission | null;
  onPick: (provider: string, modelId: string) => void;
  onRetryProvider?: (provider: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  refreshDisabled: boolean;
  isRetryingProvider?: boolean;
  serverId: string | null;
  autoFocusSearch?: boolean;
  keyHandlerRef?: MutableRefObject<PickerKeyHandler | null>;
}

const ThemedCheck = withUnistyles(Check);
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
    : (providers[0]?.id ?? "");
}

export function ProviderModelPanel(props: PickerPanelProps) {
  const { providers, selectedProvider, serverId } = props;
  const [activeTab, setActiveTab] = useState(() => resolveInitialTab(providers, selectedProvider));
  useEffect(() => {
    if (!providers.some((entry) => entry.id === activeTab)) {
      setActiveTab(resolveInitialTab(providers, selectedProvider));
    }
  }, [activeTab, providers, selectedProvider]);
  const showRail = providers.length > 1;
  const activeProvider = providers.find((entry) => entry.id === activeTab) ?? null;

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
        </View>
      ) : null}
      <View style={styles.panel}>
        <ProviderBody key={activeTab} {...props} provider={activeProvider} />
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
    fast,
    permission,
    onPick,
    onRetryProvider,
    onRefresh,
    isRefreshing,
    refreshDisabled,
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

  const selectionKind = provider?.modelSelection.kind;
  const ownsSelection = provider?.id === selectedProvider;
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
      <RefreshModelsButton
        onRefresh={onRefresh}
        isLoading={isRefreshing}
        disabled={isLoading || refreshDisabled}
      />
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
                loading={isLoading || selectionKind === "loading"}
                text={resolveEmptyText(query, isLoading, provider?.label ?? "")}
              />
            ) : null}
          </ScrollView>
        </>
      )}
      <PickerFooter
        thinking={thinking}
        fast={fast}
        permission={permission}
        active={Boolean(ownsSelection)}
        disabled={selectionKind === "error"}
      />
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
            <ModelProviderGlyph
              provider={id}
              serverId={props.serverId}
              size={19}
              tone={props.active ? "foreground" : "muted"}
            />
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

function PickerFooter(props: {
  thinking?: PickerThinking | null;
  fast?: PickerFast | null;
  permission?: PickerPermission | null;
  /** Only the provider that owns the current selection shows its controls. */
  active: boolean;
  disabled?: boolean;
}) {
  const { thinking, fast, permission, active, disabled } = props;
  if (!active) return null;
  return (
    <>
      {thinking && thinking.options.length > 0 ? (
        <EffortRow thinking={thinking} disabled={disabled} />
      ) : null}
      {fast ? <FastRow fast={fast} /> : null}
      {permission && permission.options.length > 0 ? (
        <PermissionRow permission={permission} />
      ) : null}
    </>
  );
}

function EffortRow({ thinking, disabled }: { thinking: PickerThinking; disabled?: boolean }) {
  const options = useMemo(
    () => thinking.options.map((option) => ({ id: option.id, label: localizeEffortLabel(option) })),
    [thinking.options],
  );
  return (
    <View style={styles.effortRow} testID="provider-model-picker-effort">
      <Text style={styles.effortLabel}>推理强度</Text>
      <SegmentedControl
        options={options}
        selectedId={thinking.selectedId}
        onSelect={thinking.onSelect}
        disabled={disabled}
      />
    </View>
  );
}

function PermissionRow({ permission }: { permission: PickerPermission }) {
  return (
    <View style={styles.effortRow} testID="provider-model-picker-permission">
      <Text style={styles.effortLabel}>权限</Text>
      <SegmentedControl
        options={permission.options}
        selectedId={permission.selectedId}
        onSelect={permission.onSelect}
      />
    </View>
  );
}

function FastRow({ fast }: { fast: PickerFast }) {
  return (
    <View style={styles.fastRow} testID="provider-model-picker-fast">
      <Text style={styles.effortLabel}>快速</Text>
      <Switch value={fast.value} onValueChange={fast.onChange} accessibilityLabel="快速模式" />
    </View>
  );
}

interface EffortOption {
  id: string;
  label: string;
}

interface SegmentBox {
  x: number;
  width: number;
}

function noop() {}

const SLIDE_EASING = Easing.bezier(0.22, 1, 0.36, 1);

/** Sliding-pill segmented control; many options scroll sideways instead of turning into a menu. */
function SegmentedControl(props: {
  options: EffortOption[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const { options, selectedId, onSelect, disabled = false } = props;
  const boxes = useRef(new Map<string, SegmentBox>());
  const [layoutVersion, setLayoutVersion] = useState(0);
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const prevSelected = useRef<string | undefined>(undefined);

  const handleSegmentLayout = useCallback((id: string, box: SegmentBox) => {
    const prev = boxes.current.get(id);
    if (prev && prev.x === box.x && prev.width === box.width) return;
    boxes.current.set(id, box);
    setLayoutVersion((version) => version + 1);
  }, []);

  // First placement and resizes jump; only a selection change slides.
  useEffect(() => {
    const box = selectedId ? boxes.current.get(selectedId) : undefined;
    if (!box) {
      width.value = 0;
      return;
    }
    const slide =
      prevSelected.current !== undefined && prevSelected.current !== selectedId && width.value > 0;
    prevSelected.current = selectedId;
    if (slide) {
      x.value = withTiming(box.x, { duration: 250, easing: SLIDE_EASING });
      width.value = withTiming(box.width, { duration: 250, easing: SLIDE_EASING });
    } else {
      x.value = box.x;
      width.value = box.width;
    }
  }, [layoutVersion, selectedId, width, x]);

  const pillStyle = useAnimatedStyle(() => ({
    width: width.value,
    opacity: width.value > 0 ? 1 : 0,
    transform: [{ translateX: x.value }],
  }));

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.segmentsScroll}
      contentContainerStyle={styles.segmentsScrollContent}
    >
      <View
        style={[styles.segments, disabled && styles.segmentsDisabled]}
        accessibilityRole="radiogroup"
        aria-disabled={disabled}
      >
        <Animated.View pointerEvents="none" style={[styles.segmentPill, pillStyle]}>
          <View style={styles.segmentPillFill} />
          <View style={styles.segmentPillHighlight} />
        </Animated.View>
        {options.map((option) => (
          <Segment
            key={option.id}
            option={option}
            selected={option.id === selectedId}
            onSelect={disabled ? noop : onSelect}
            onBox={handleSegmentLayout}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function Segment(props: {
  option: EffortOption;
  selected: boolean;
  onSelect: (id: string) => void;
  onBox: (id: string, box: SegmentBox) => void;
}) {
  const { option, onSelect, onBox } = props;
  const handlePress = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) =>
      onBox(option.id, { x: event.nativeEvent.layout.x, width: event.nativeEvent.layout.width }),
    [onBox, option.id],
  );
  return (
    <PressHighlight
      onPress={handlePress}
      onLayout={handleLayout}
      style={styles.segment}
      accessibilityRole="radio"
      aria-checked={props.selected}
    >
      <Text style={props.selected ? styles.segmentTextOn : styles.segmentText}>{option.label}</Text>
    </PressHighlight>
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
  fastRow: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: -theme.spacing[1.5],
    paddingTop: theme.spacing[1],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[3],
    minHeight: 32,
  },
  segments: {
    flexDirection: "row",
    gap: 2,
    padding: 2,
    borderRadius: 10,
    backgroundColor: theme.colors.hoverTint,
  },
  segmentPill: {
    position: "absolute",
    top: 2,
    bottom: 2,
    left: 0,
    borderRadius: 8,
    overflow: "hidden",
  },
  // Text color at 12% plus a one-pixel top highlight, both from theme tokens.
  segmentPillFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.foreground,
    opacity: 0.12,
  },
  segmentPillHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: theme.colors.foreground,
    opacity: 0.16,
  },
  segmentsScroll: { flexShrink: 1, flexGrow: 0, minWidth: 0 },
  segmentsScrollContent: { flexGrow: 0 },
  segmentsDisabled: { opacity: 0.5 },
  segment: {
    height: 28,
    paddingHorizontal: 7,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
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
}));
