// 复核 tab (WP-108): pick the reviewer model (default: no review) and read the review conclusions
// and the returns they caused, oldest first. After execution the reviewer looks at the change before
// the evidence verification; severe findings send the card back to the main agent.

import { useToast } from "@getpaseo/plugin/client/react-native";
import React from "react";
import { View } from "react-native";
import type { CardEvent, CardView, Preset } from "../../shared/vibe/contract";
import { errorMessage } from "../board/logic";
import type { BoardApi } from "../common/api";
import { Field, Muted } from "../common/ui";
import { useOptimisticCard } from "../detail/optimistic";
import { Bubble, SystemRow } from "./Chat";
import { ModelPicker } from "./ModelPicker";
import { chatItemsOf } from "./logic";

export function ReviewTab({
  api,
  card: serverCard,
  events,
  presets,
  reload,
}: {
  api: BoardApi;
  card: CardView;
  events: readonly CardEvent[];
  presets: readonly Preset[];
  reload: () => Promise<unknown>;
}) {
  const toast = useToast();
  const { card, update } = useOptimisticCard(
    serverCard,
    (patch) => api.cardsUpdate({ card: serverCard.id, ...patch }),
    reload,
    (e) => toast.error(errorMessage(e)),
  );
  const items = chatItemsOf(events, "review");
  return (
    <View style={{ gap: 14 }}>
      <ModelPicker
        label="复核模型"
        presets={presets}
        value={card.reviewerPresetId}
        noneLabel="不复核"
        hint="执行完成后先由它 review 代码改动；发现严重问题会自动退回主代理修改，然后再做证据验证。"
        onChange={(reviewerPresetId) => void update({ reviewerPresetId })}
      />
      <Field label="复核结论与历史">
        {items.length === 0 ? (
          <Muted size={13}>
            {card.reviewerPresetId ? "还没有复核结果：执行完成后由复核模型 review。" : "这张卡片不复核。"}
          </Muted>
        ) : (
          <View style={{ gap: 8 }}>
            {items.map((item) =>
              item.kind === "message" ? (
                <Bubble key={item.id} item={item} />
              ) : item.kind === "system" ? (
                <SystemRow key={item.id} item={item} />
              ) : null,
            )}
          </View>
        )}
      </Field>
    </View>
  );
}
