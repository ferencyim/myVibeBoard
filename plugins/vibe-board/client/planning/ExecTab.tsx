// 执行 tab (WP-105): pick the executing and reviewing models, see which model is executing now,
// 立即执行 (execution -> review if picked -> evidence verification), and the execution conversation
// (the executor's questions, round summaries and final summary; the owner replies here).

import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Text, View } from "react-native";
import type { AgentSession, CardEvent, CardView, Preset } from "../../shared/vibe/contract";
import { errorMessage } from "../board/logic";
import { useLocalStatus, type BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { Btn, Muted } from "../common/ui";
import { useOptimisticCard } from "../detail/optimistic";
import { Conversation } from "./Chat";
import { ModelPicker } from "./ModelPicker";
import { canExecute, chatItemsOf, executingLabel, runningWorkerOf } from "./logic";

export interface ExecTabProps {
  api: BoardApi;
  card: CardView;
  events: readonly CardEvent[];
  sessions: readonly AgentSession[];
  presets: readonly Preset[];
  reload: () => Promise<unknown>;
  onOpenVerification: () => void;
}

export function ExecTab({ api, card: serverCard, events, sessions, presets, reload, onOpenVerification }: ExecTabProps) {
  const { theme } = useHost();
  const toast = useToast();
  // Picks show at once (WP-104 optimistic.ts); handing a running card to another model is not optimistic.
  const { card, update: updateCard } = useOptimisticCard(
    serverCard,
    (patch) => api.cardsUpdate({ card: serverCard.id, ...patch }),
    reload,
    (e) => toast.error(errorMessage(e)),
  );
  const { offline } = useLocalStatus();
  const [busy, setBusy] = useState(false);
  const items = chatItemsOf(events, "exec");
  const running = runningWorkerOf(sessions);
  const executing = executingLabel(sessions, presets, card);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.show(done, { variant: "success" });
      void reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pickExecutor = (presetId: string | null) =>
    running && presetId
      ? act(() => api.execSwitch({ card: card.id, presetId }), "已切换执行模型，新模型会带着执行对话和方案接着做")
      : void updateCard({ presetId });

  return (
    <View style={{ gap: 14 }}>
      <ModelPicker
        label="执行模型"
        role="worker"
        presets={presets}
        value={card.presetId}
        hint={running ? "执行中换模型：新模型在同一个工作树接着做，带上执行对话、方案和验收标准。" : "没选时用项目的默认预设。"}
        disabled={busy || offline}
        onChange={pickExecutor}
      />
      <ModelPicker
        label="复核模型"
        role="reviewer"
        presets={presets}
        value={card.reviewerPresetId}
        noneLabel="不复核"
        hint="执行完成后先由它 review 代码改动；发现严重问题会自动退回执行模型修改，然后再做证据验证。"
        onChange={(reviewerPresetId) => void updateCard({ reviewerPresetId })}
      />
      <View
        style={{
          gap: 4,
          padding: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: executing ? theme.colors.statusSuccess : theme.colors.border,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
          {executing ? `正在执行：${executing}` : "当前没有模型在执行这张卡片。"}
        </Text>
        {!card.plan?.description.trim() && canExecute(card) ? (
          <Muted size={12}>这张卡片还没有方案：执行模型只会拿到任务描述和验收标准。</Muted>
        ) : null}
      </View>
      {canExecute(card) ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Btn
            variant="primary"
            icon="Play"
            label="立即执行"
            disabled={busy || offline}
            onPress={() => act(() => api.execStart({ card: card.id }), `已开始执行 ${card.key}`)}
          />
        </View>
      ) : null}

      <Conversation
        api={api}
        card={card}
        thread="exec"
        items={items}
        busyText={running?.state === "working" || running?.state === "starting" ? "执行模型正在工作…" : null}
        emptyText="执行对话：执行模型的提问、阶段小结、完成总结和复核结论都在这里。"
        composerHint={
          running
            ? "消息会转给正在执行的模型；它在等你回答时，这条消息就是回答。"
            : card.column === "done"
              ? "卡片已完成，发言只作记录。"
              : "执行模型这一轮已结束时，消息会把它唤回来继续。"
        }
        placeholder="回答执行模型的问题或补充要求…"
        reload={reload}
        onOpenVerification={onOpenVerification}
      />
    </View>
  );
}
