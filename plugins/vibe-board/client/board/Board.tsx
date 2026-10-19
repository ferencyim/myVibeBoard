// Five-column board. Wide layouts show all columns side by side (drag a card by its grip to move
// it between columns / reorder it); compact layouts show one column at a time behind a segmented
// control and use the card menu ("移动到") instead. Gestures use PanResponder only (the plugin
// sandbox has no gesture-handler / reanimated).

import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, ScrollView, Text, View } from "react-native";
import { CARD_COLUMNS, type CardColumn, type CardView, type Preset, type Tag } from "../../shared/vibe/contract";
import { useHost } from "../common/ctx";
import { Chip, Muted } from "../common/ui";
import { CardItem } from "./CardItem";
import {
  COLUMN_LABELS,
  columnAtX,
  insertIndexAtY,
  planDrop,
  userTargets,
  type DropPlan,
  type Rect,
} from "./logic";

export interface BoardProps {
  columns: Record<CardColumn, CardView[]>;
  colorOf: (projectId: string) => string;
  /** Show the project name on cards (general board). */
  projectNameOf?: (projectId: string) => string | undefined;
  tagsById: ReadonlyMap<string, Tag>;
  presetsById: ReadonlyMap<string, Preset>;
  onOpen: (card: CardView) => void;
  onMenu: (card: CardView) => void;
  onDrop: (card: CardView, plan: DropPlan) => void;
  onAdd?: (column: CardColumn) => void;
}

interface Measured {
  columns: Array<{ column: CardColumn; rect: Rect }>;
  cards: Map<string, { column: CardColumn; rect: Rect }>;
}

type RefView = { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void };

function measure(ref: RefView | null | undefined): Promise<Rect | null> {
  return new Promise((resolve) => {
    if (!ref?.measureInWindow) return resolve(null);
    ref.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

export function Board(props: BoardProps) {
  const { compact, theme } = useHost();
  const [active, setActive] = useState<CardColumn>("todo");
  const [drag, setDrag] = useState<{
    card: CardView;
    hover: CardColumn | null;
    index: number;
    /** Floating copy of the card, positioned relative to the board root. */
    overlay: { left: number; top: number; width: number } | null;
  } | null>(null);
  const rootRef = useRef<RefView | null>(null);
  const pan = useRef(new Animated.ValueXY()).current;
  const columnRefs = useRef(new Map<CardColumn, RefView | null>());
  const cardRefs = useRef(new Map<string, RefView | null>());
  const measured = useRef<Measured>({ columns: [], cards: new Map() });
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const propsRef = useRef(props);
  propsRef.current = props;

  const visibleColumns = compact ? [active] : CARD_COLUMNS;

  const startDrag = async (card: CardView) => {
    const root = await measure(rootRef.current);
    const own = await measure(cardRefs.current.get(card.id));
    pan.setValue({ x: 0, y: 0 });
    setDrag({
      card,
      hover: card.column,
      index: -1,
      overlay: root && own ? { left: own.x - root.x, top: own.y - root.y, width: own.width } : null,
    });
    const columns: Measured["columns"] = [];
    const cards: Measured["cards"] = new Map();
    for (const column of visibleColumns) {
      const rect = await measure(columnRefs.current.get(column));
      if (rect) columns.push({ column, rect });
      for (const c of propsRef.current.columns[column]) {
        const r = await measure(cardRefs.current.get(c.id));
        if (r) cards.set(c.id, { column, rect: r });
      }
    }
    measured.current = { columns, cards };
  };

  const locate = (card: CardView, x: number, y: number) => {
    const m = measured.current;
    const column = columnAtX(x, m.columns);
    if (!column) return { column: null, index: 0 };
    const rects = propsRef.current.columns[column]
      .filter((c) => c.id !== card.id)
      .map((c) => m.cards.get(c.id)?.rect)
      .filter((r): r is Rect => !!r);
    return { column, index: insertIndexAtY(y, rects) };
  };

  const moveDrag = (card: CardView, x: number, y: number, dx: number, dy: number) => {
    pan.setValue({ x: dx, y: dy });
    const { column, index } = locate(card, x, y);
    const cur = dragRef.current;
    if (cur && (cur.hover !== column || cur.index !== index)) setDrag({ ...cur, hover: column, index });
  };

  const endDrag = (card: CardView, x: number, y: number) => {
    const { column, index } = locate(card, x, y);
    setDrag(null);
    if (!column) return;
    props.onDrop(card, planDrop(card, column, index, propsRef.current.columns[column]));
  };

  const renderColumn = (column: CardColumn) => {
    const cards = props.columns[column];
    const dragging = drag?.card;
    const blocked =
      !!dragging && dragging.column !== column && !userTargets(dragging.column).includes(column);
    const isHover = !!dragging && drag?.hover === column && !blocked;
    let others = 0;
    return (
      <View
        key={column}
        ref={(r) => void columnRefs.current.set(column, r as unknown as RefView | null)}
        collapsable={false}
        style={{
          width: compact ? undefined : 272,
          flex: compact ? 1 : undefined,
          marginRight: compact ? 0 : 10,
          borderRadius: 10,
          padding: 8,
          gap: 8,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: isHover ? theme.colors.accent : theme.colors.border,
          opacity: blocked ? 0.45 : 1,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600", flex: 1 }}>
            {COLUMN_LABELS[column]}
          </Text>
          <Muted>{cards.length}</Muted>
          {props.onAdd && (column === "draft" || column === "todo") ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`新建到${COLUMN_LABELS[column]}`} onPress={() => props.onAdd?.(column)} hitSlop={6}>
              <Icon name="Plus" size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
        <ScrollView
          scrollEnabled={!drag}
          style={{ flex: compact ? 1 : undefined }}
          contentContainerStyle={{ gap: 8, paddingBottom: 4, minHeight: 40 }}
        >
          {cards.map((card) => {
            const isDragged = dragging?.id === card.id;
            const showBar = isHover && !isDragged && drag?.index === others;
            if (!isDragged) others += 1;
            return (
              <React.Fragment key={card.id}>
                {showBar ? <DropBar /> : null}
                <DraggableCard
                  card={card}
                  dim={isDragged}
                  refSetter={(r) => void cardRefs.current.set(card.id, r)}
                  onStart={startDrag}
                  onMove={moveDrag}
                  onEnd={endDrag}
                >
                  {(handle) => (
                    <CardItem
                      card={card}
                      color={props.colorOf(card.projectId)}
                      projectName={props.projectNameOf?.(card.projectId)}
                      tagsById={props.tagsById}
                      presetsById={props.presetsById}
                      onOpen={() => props.onOpen(card)}
                      onMenu={() => props.onMenu(card)}
                      handle={handle}
                    />
                  )}
                </DraggableCard>
              </React.Fragment>
            );
          })}
          {isHover && drag && drag.index >= others ? <DropBar /> : null}
          {cards.length === 0 && !isHover ? <Muted>空</Muted> : null}
        </ScrollView>
      </View>
    );
  };

  return (
    <View
      ref={(r) => void (rootRef.current = r as unknown as RefView | null)}
      collapsable={false}
      style={{ flex: 1 }}
    >
      {compact ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingBottom: 8 }}>
          {CARD_COLUMNS.map((c) => (
            <Chip
              key={c}
              label={COLUMN_LABELS[c]}
              count={props.columns[c].length}
              selected={active === c}
              onPress={() => setActive(c)}
            />
          ))}
        </ScrollView>
      ) : null}
      {compact ? (
        renderColumn(active)
      ) : (
        <ScrollView
          horizontal
          scrollEnabled={!drag}
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 8 }}
        >
          {CARD_COLUMNS.map(renderColumn)}
        </ScrollView>
      )}
      {drag?.overlay ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: drag.overlay.left,
            top: drag.overlay.top,
            width: drag.overlay.width,
            zIndex: 100,
            elevation: 8,
            opacity: 0.92,
            transform: pan.getTranslateTransform(),
          }}
        >
          <CardItem
            card={drag.card}
            color={props.colorOf(drag.card.projectId)}
            projectName={props.projectNameOf?.(drag.card.projectId)}
            tagsById={props.tagsById}
            presetsById={props.presetsById}
            onOpen={() => undefined}
            onMenu={() => undefined}
            handle={null}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

function DropBar() {
  const { theme } = useHost();
  // Zero net layout height so measured card rects stay valid while hovering.
  return <View style={{ height: 4, marginVertical: -2, borderRadius: 2, backgroundColor: theme.colors.accent }} />;
}

function DraggableCard({
  card,
  dim,
  refSetter,
  onStart,
  onMove,
  onEnd,
  children,
}: {
  card: CardView;
  dim: boolean;
  refSetter: (ref: RefView | null) => void;
  onStart: (card: CardView) => void;
  onMove: (card: CardView, x: number, y: number, dx: number, dy: number) => void;
  onEnd: (card: CardView, x: number, y: number) => void;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const { theme } = useHost();
  const latest = useRef({ card, onStart, onMove, onEnd });
  latest.current = { card, onStart, onMove, onEnd };

  // PanResponder.create must run once (a re-created responder loses the gesture mid-drag).
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => latest.current.onStart(latest.current.card),
      onPanResponderMove: (_e, g) =>
        latest.current.onMove(latest.current.card, g.moveX, g.moveY, g.dx, g.dy),
      onPanResponderRelease: (_e, g) => latest.current.onEnd(latest.current.card, g.moveX, g.moveY),
      onPanResponderTerminate: () => latest.current.onEnd(latest.current.card, -1, -1),
    }),
  ).current;

  const handle = (
    <View
      {...responder.panHandlers}
      accessibilityLabel={`拖动 ${card.key}`}
      style={{ padding: 6, cursor: "grab" } as object}
    >
      <Icon name="GripVertical" size={16} color={theme.colors.foregroundMuted} />
    </View>
  );

  return (
    <View
      ref={(r) => refSetter(r as unknown as RefView | null)}
      collapsable={false}
      style={{ opacity: dim ? 0.3 : 1 }}
    >
      {children(handle)}
    </View>
  );
}

/** Lookup helpers so the screen does not rebuild maps on every render. */
export function useIdMap<T extends { id: string }>(items: readonly T[]): ReadonlyMap<string, T> {
  return useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
}
