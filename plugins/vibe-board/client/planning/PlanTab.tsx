// 方案 tab (WP-105): pick the scout and planning models, 制定方案, read the card's single plan,
// edit the acceptance criteria, and talk to the planning model in the plan conversation.

import * as hostUi from "@getpaseo/plugin/client/react-native";
import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Text, View } from "react-native";
import type { AgentSession, CardEvent, CardView, Preset } from "../../shared/vibe/contract";
import { errorMessage } from "../board/logic";
import { useLocalStatus, type BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { Btn, Chip, Field, Muted, TextField } from "../common/ui";
import { discard, edit, initialDraft, isDirty, reconcileField } from "../detail/draft";
import { useOptimisticCard } from "../detail/optimistic";
import { Conversation } from "./Chat";
import { ModelPicker } from "./ModelPicker";
import { chatItemsOf, plannerSessionOf, plannerStatusLabel, waitingForReply } from "./logic";

// Hosts older than v0.12.1 have no Markdown component; the plan then shows as plain text.
const HostMarkdown = (hostUi as { Markdown?: React.ComponentType<{ text: string }> }).Markdown;

export interface PlanTabProps {
  api: BoardApi;
  card: CardView;
  events: readonly CardEvent[];
  sessions: readonly AgentSession[];
  presets: readonly Preset[];
  reload: () => Promise<unknown>;
}

export function PlanTab({ api, card: serverCard, events, sessions, presets, reload }: PlanTabProps) {
  const { theme } = useHost();
  const toast = useToast();
  const { offline } = useLocalStatus();
  const [starting, setStarting] = useState(false);
  const items = chatItemsOf(events, "plan");
  const session = plannerSessionOf(sessions);
  const working = session?.state === "starting" || session?.state === "working" || waitingForReply(items);

  // Model picks show at once; the write and refetch run in the background (WP-104 optimistic.ts).
  const { card, update: updateCard } = useOptimisticCard(
    serverCard,
    (patch) => api.cardsUpdate({ card: serverCard.id, ...patch }),
    reload,
    (e) => toast.error(errorMessage(e)),
  );
  const update = (patch: { scoutPresetId?: string | null; plannerPresetId?: string | null }) =>
    void updateCard(patch);

  const makePlan = async () => {
    setStarting(true);
    try {
      await api.planStart({ card: card.id });
      void reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={{ gap: 14 }}>
      <ModelPicker
        label="探路模型"
        role="scout"
        presets={presets}
        value={card.scoutPresetId}
        noneLabel="不探路"
        hint="制定方案前先用便宜的只读模型查一遍代码；规划时也可以请它调查。"
        onChange={(scoutPresetId) => update({ scoutPresetId })}
      />
      <ModelPicker
        label="规划模型"
        role="planner"
        presets={presets}
        value={card.plannerPresetId}
        hint="中途换模型时，新模型会拿到方案对话、当前方案和验收标准接着做。"
        onChange={(plannerPresetId) => update({ plannerPresetId })}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Btn
          variant="primary"
          icon="Sparkles"
          label={card.plan ? "重新制定方案" : "制定方案"}
          disabled={starting || offline || !card.plannerPresetId || card.column === "done"}
          onPress={makePlan}
        />
        <Chip label={plannerStatusLabel(session)} />
        {!card.plannerPresetId ? <Muted>先选规划模型</Muted> : null}
      </View>

      <Field label="方案">
        {card.plan?.description.trim() ? (
          <View
            style={{
              gap: 6,
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            {HostMarkdown ? (
              <HostMarkdown text={card.plan.description} />
            ) : (
              <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>
                {card.plan.description}
              </Text>
            )}
            {card.plan.files?.length ? <Muted size={12}>涉及文件：{card.plan.files.join(", ")}</Muted> : null}
          </View>
        ) : (
          <Muted size={13}>还没有方案：选好规划模型后点「制定方案」。</Muted>
        )}
      </Field>

      <AcceptanceEditor api={api} card={card} reload={reload} />

      <Conversation
        api={api}
        card={card}
        thread="plan"
        items={items}
        busyText={working ? "规划模型正在思考…" : null}
        emptyText="方案对话：规划模型的提问、你的回答和修改要求都在这里。"
        composerHint="回答规划模型的问题，或者直接提修改要求，方案会随之更新。"
        placeholder="回答问题或提出修改…"
        reload={reload}
      />
    </View>
  );
}

/** The acceptance criteria: drafted by the planning model, edited here by the owner. */
function AcceptanceEditor({ api, card, reload }: { api: BoardApi; card: CardView; reload: () => Promise<unknown> }) {
  const toast = useToast();
  // The card is polled; the user's unsaved text wins over the server value (no cursor jump).
  const [draft, setDraft] = useState(initialDraft(card.acceptance));
  const synced = reconcileField(draft, card.acceptance);
  if (synced !== draft) setDraft(synced);
  const dirty = isDirty(synced);
  const ownEdit = !!card.acceptance.trim() && card.acceptance !== card.modelAcceptance;
  const save = async () => {
    try {
      await api.cardsUpdate({ card: card.id, acceptance: synced.local });
      void reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Field
      label="验收标准"
      hint={
        ownEdit
          ? "你改过验收标准：规划模型再改时会在下面的对话里以建议提出，由你决定是否采纳。"
          : "由规划模型起草，可以直接修改；独立验证按此逐条检查。"
      }
    >
      <TextField multiline value={synced.local} onChangeText={(v) => setDraft((d) => edit(d, v))} />
      {dirty ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn small variant="primary" label="保存验收标准" onPress={save} />
          <Btn small label="放弃修改" onPress={() => setDraft(discard(card.acceptance))} />
        </View>
      ) : null}
    </Field>
  );
}
