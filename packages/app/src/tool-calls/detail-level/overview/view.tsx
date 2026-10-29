import React, { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExpandableBadge } from "@/components/message";
import { useIsCompactFormFactor } from "@/constants/layout";
import { type OverviewSummary, type OverviewToolCallGroup } from "./model";
import { OverviewToolCallGroupSheet } from "./sheet";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { describeToolCall, type StepItem } from "../grouping";
import { PressHighlight } from "@/components/ui/press-highlight";
import { waterfallScrollTarget, waterfallStepIds } from "./waterfall";

interface OverviewGroupProps {
  group: OverviewToolCallGroup;
  expanded: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children: ReactNode;
  onLocate: (groupId: string) => void;
}

function StepRow({
  id,
  onMeasure,
  children,
}: {
  id: string;
  onMeasure: (id: string, y: number) => void;
  children: ReactNode;
}) {
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => onMeasure(id, event.nativeEvent.layout.y),
    [id, onMeasure],
  );
  return <View onLayout={onLayout}>{children}</View>;
}

function WaterfallEntry({ item, onSelect }: { item: StepItem; onSelect: (id: string) => void }) {
  const select = useCallback(() => onSelect(item.id), [item.id, onSelect]);
  const label = item.kind === "thought" ? item.text : describeToolCall(item).name;
  return (
    <PressHighlight accessibilityRole="button" onPress={select} style={styles.entry}>
      <Text numberOfLines={2} style={styles.entryText}>
        {label}
      </Text>
    </PressHighlight>
  );
}

const TOOL_CALL_GROUP_MAX_HEIGHT = 400;

function joinSummaryParts(parts: string[], conjunction: string): string {
  if (parts.length === 0) {
    return "";
  }
  let joined = parts[0] ?? "";
  if (parts.length === 2) {
    joined = `${parts[0]} ${conjunction} ${parts[1]}`;
  } else if (parts.length > 2) {
    joined = `${parts.slice(0, -1).join(", ")}, ${conjunction} ${parts.at(-1)}`;
  }
  const firstCharacter = joined[0];
  return firstCharacter ? `${firstCharacter.toLocaleUpperCase()}${joined.slice(1)}` : joined;
}

function useOverviewSummary(summary: OverviewSummary): string {
  const { t } = useTranslation();
  return useMemo(() => {
    const parts: string[] = [];
    const entries = [
      [summary.editedFileCount, "toolCallGroup.editedFiles"],
      [summary.commandCount, "toolCallGroup.commands"],
      [summary.readFileCount, "toolCallGroup.readFiles"],
      [summary.searchCount, "toolCallGroup.searches"],
      [summary.otherToolCount, "toolCallGroup.otherTools"],
      [summary.paseoCallCount, "toolCallGroup.paseoCalls"],
    ] as const;
    for (const [count, key] of entries) {
      if (count > 0) {
        parts.push(t(`${key}.${count === 1 ? "one" : "other"}`, { count }));
      }
    }
    if (summary.failedCount > 0) {
      parts.push(
        t("toolCallGroup.failed", { count: summary.failedCount, defaultValue: "{{count}} failed" }),
      );
    }
    if (summary.thoughtCount > 0) {
      parts.push(
        t("toolCallGroup.thoughts", {
          count: summary.thoughtCount,
          defaultValue: "{{count}} thinking steps",
        }),
      );
    }
    return joinSummaryParts(parts, t("toolCallGroup.and"));
  }, [summary, t]);
}

export const OverviewToolCallGroupView = memo(function OverviewToolCallGroupView({
  group,
  expanded,
  isLastInSequence,
  onExpandedChange,
  onLocate,
  children,
}: OverviewGroupProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView>(null);
  const isCompact = useIsCompactFormFactor();
  const [waterfallVisible, setWaterfallVisible] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetOffset, setTargetOffset] = useState<number | null>(null);
  const offsets = useRef(new Map<string, number>());
  const pendingSelection = useRef<string | null>(null);
  const aggregateSummary = useOverviewSummary(group.summary);
  const scrollToLatest = useCallback(() => {
    const target = waterfallScrollTarget(selectedId, targetOffset);
    if (typeof target === "number") scrollRef.current?.scrollTo({ y: target, animated: false });
    else if (target === "latest") scrollRef.current?.scrollToEnd({ animated: false });
  }, [selectedId, targetOffset]);
  const toggle = useCallback(() => {
    onExpandedChange(group.run.id, !expanded);
  }, [expanded, group.run.id, onExpandedChange]);
  const close = useCallback(() => {
    onExpandedChange(group.run.id, false);
  }, [group.run.id, onExpandedChange]);
  const showWaterfall = useCallback(() => setWaterfallVisible(true), []);
  const hideWaterfall = useCallback(() => setWaterfallVisible(false), []);
  const selectStep = useCallback((id: string) => {
    pendingSelection.current = id;
    setWaterfallVisible(false);
  }, []);
  const handleWaterfallDismiss = useCallback(() => {
    const id = pendingSelection.current;
    pendingSelection.current = null;
    if (!id) return;
    setSelectedId(id);
    const offset = offsets.current.get(id) ?? null;
    setTargetOffset(offset);
    if (offset !== null) scrollRef.current?.scrollTo({ y: offset, animated: false });
    onExpandedChange(group.run.id, true);
    onLocate(group.run.id);
  }, [group.run.id, onExpandedChange, onLocate]);
  const measureStep = useCallback(
    (id: string, y: number) => {
      offsets.current.set(id, y);
      if (id === selectedId) {
        setTargetOffset(y);
        scrollRef.current?.scrollTo({ y, animated: false });
      }
    },
    [selectedId],
  );
  const stepChildren = useMemo(() => {
    const ids = waterfallStepIds(group.run.calls);
    return React.Children.toArray(children).map((child, index) => {
      const id = ids[index];
      return id ? (
        <StepRow key={id} id={id} onMeasure={measureStep}>
          {child}
        </StepRow>
      ) : (
        child
      );
    });
  }, [children, group.run.calls, measureStep]);
  const waterfallHeader = useMemo(() => ({ title: aggregateSummary }), [aggregateSummary]);
  const waterfall = (
    <AdaptiveModalSheet
      visible={waterfallVisible}
      header={waterfallHeader}
      onClose={hideWaterfall}
      onDismiss={handleWaterfallDismiss}
      testID="tool-call-waterfall"
    >
      <ScrollView>
        {group.run.calls.map((item) => (
          <WaterfallEntry key={item.id} item={item} onSelect={selectStep} />
        ))}
      </ScrollView>
    </AdaptiveModalSheet>
  );
  const waterfallButton = (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("toolCallGroup.waterfall", { defaultValue: "Steps" })}
      onPress={showWaterfall}
      style={styles.entry}
    >
      <Text style={styles.entryText}>⋯</Text>
    </PressHighlight>
  );
  const renderDetails = useCallback(
    () => (
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        onContentSizeChange={scrollToLatest}
      >
        {stepChildren}
      </ScrollView>
    ),
    [stepChildren, scrollToLatest],
  );

  if (isCompact) {
    return (
      <>
        <ExpandableBadge
          testID="tool-call-group"
          label={aggregateSummary}
          icon={Wrench}
          isLoading={group.isLoading}
          isExpanded={false}
          isLastInSequence={isLastInSequence}
          onToggle={toggle}
        />
        {waterfallButton}
        {waterfall}
        <OverviewToolCallGroupSheet
          visible={expanded}
          summary={aggregateSummary}
          onClose={close}
          targetOffset={targetOffset}
          waitingForTarget={selectedId !== null}
        >
          {stepChildren}
        </OverviewToolCallGroupSheet>
      </>
    );
  }

  return (
    <>
      <ExpandableBadge
        testID="tool-call-group"
        label={aggregateSummary}
        icon={Wrench}
        isLoading={group.isLoading}
        isExpanded={expanded}
        isLastInSequence={isLastInSequence}
        onToggle={toggle}
        renderDetails={renderDetails}
        borderlessWhenExpanded
      />
      {waterfallButton}
      {waterfall}
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  scroll: {
    maxHeight: TOOL_CALL_GROUP_MAX_HEIGHT,
  },
  content: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: 13,
  },
  entry: { padding: theme.spacing[2] },
  entryText: { color: theme.colors.textSecondary, fontSize: theme.fontSize.base },
}));
