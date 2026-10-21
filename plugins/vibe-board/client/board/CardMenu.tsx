// "移动到" menu: the compact-layout replacement for cross-column drag, also available on wide.

import { Modal } from "@getpaseo/plugin/client/react-native";
import React from "react";
import { View } from "react-native";
import type { CardColumn, CardView } from "../../shared/vibe/contract";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Field, Muted } from "../common/ui";
import { COLUMN_LABELS, stepNeighbours, userTargets } from "./logic";

export type MenuAction =
  | { type: "open" }
  | { type: "move"; to: CardColumn }
  | { type: "step"; step: "up" | "down" | "top" | "bottom" }
  | { type: "archive" }
  | { type: "review" }
  | { type: "dispatch" };

export function CardMenu({
  card,
  columnCards,
  onClose,
  onAction,
}: {
  card: CardView | null;
  columnCards: readonly CardView[];
  onClose: () => void;
  onAction: (card: CardView, action: MenuAction) => void;
}) {
  // Modal content renders in a host portal, outside our context tree: bridge the host value.
  const host = useHost();
  if (!card) return null;
  const targets = userTargets(card.column);
  const steps = (["top", "up", "down", "bottom"] as const).filter(
    (s) => stepNeighbours(columnCards, card.id, s) !== null,
  );
  const labels = { top: "置顶", up: "上移", down: "下移", bottom: "置底" } as const;
  const act = (action: MenuAction) => {
    onClose();
    onAction(card, action);
  };
  return (
    <Modal title={`${card.key} ${card.title}`} open onOpenChange={(o) => !o && onClose()}>
      <Modal.Content>
        <HostProvider value={host}>
        <View style={{ gap: 14 }}>
          <Field label="移动到">
            <View style={{ gap: 8 }}>
              {targets.map((to) => (
                <Btn key={to} icon="ArrowRight" label={COLUMN_LABELS[to]} onPress={() => act({ type: "move", to })} />
              ))}
              {targets.length === 0 ? (
                <Muted size={13}>「{COLUMN_LABELS[card.column]}」中的卡片由系统推进，不能手动移动。</Muted>
              ) : null}
            </View>
          </Field>
          {steps.length > 0 ? (
            <Field label="列内排序">
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {steps.map((s) => (
                  <Btn key={s} label={labels[s]} onPress={() => act({ type: "step", step: s })} />
                ))}
              </View>
            </Field>
          ) : null}
          {card.column === "draft" || card.column === "todo" ? (
            <Field label="手动触发">
              {card.column === "draft" ? (
                <Btn icon="MessageSquare" label="让总 agent 审查" onPress={() => act({ type: "review" })} />
              ) : (
                <Btn icon="Play" label="立即执行" onPress={() => act({ type: "dispatch" })} />
              )}
            </Field>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn variant="primary" icon="ExternalLink" label="打开详情" onPress={() => act({ type: "open" })} />
            <Btn icon="Archive" label="归档" onPress={() => act({ type: "archive" })} />
          </View>
        </View>
      </HostProvider>
      </Modal.Content>
    </Modal>
  );
}
