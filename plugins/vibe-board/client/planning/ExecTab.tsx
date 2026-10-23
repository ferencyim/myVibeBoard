// 执行 tab (WP-105): pick the executing models, see which model is executing now, 立即执行
// (execution -> review if picked -> evidence verification), and the execution conversation (the
// executor's questions, round summaries and final summary; the owner replies here). WP-108: the
// reviewer moved to its own tab; 立即执行 needs a verification model (card, project or global).
// WP-106: the executing model is the main agent; sub-agents run the plan's subtasks on their own
// model or the sub-agent default; the subtask list shows their state and opens their sessions.

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
import {
  canExecute,
  chatItemsOf,
  chatTargets,
  defaultChoice,
  executingLabel,
  missingVerifier,
  runningWorkerOf,
  type ModelScope,
} from "./logic";
import { SubtaskList } from "./Subtasks";

export interface ExecTabProps {
  api: BoardApi;
  card: CardView;
  events: readonly CardEvent[];
  sessions: readonly AgentSession[];
  presets: readonly Preset[];
  /** Project / global default models (WP-108). */
  scope: ModelScope;
  reload: () => Promise<unknown>;
  onOpenVerification: () => void;
}

export function ExecTab({ api, card: serverCard, events, sessions, presets, scope, reload, onOpenVerification }: ExecTabProps) {
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
  const noVerifier = missingVerifier(card, scope);
  const subagentDefault = defaultChoice("subagent", scope);

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
      ? act(() => api.execSwitch({ card: card.id, presetId }), "已切换主代理模型，新模型会带着执行对话和方案接着做")
      : void updateCard({ presetId });

  return (
    <View style={{ gap: 14 }}>
      <ModelPicker
        label="主代理模型"
        presets={presets}
        value={card.presetId}
        fallback={defaultChoice("worker", scope)}
        hint={
          running
            ? "执行中换模型：新的主代理在同一个工作树接着统筹，带上执行对话、方案和子任务状态。"
            : "主代理统筹子任务的顺序与并行；没选时用项目或全局的默认模型。"
        }
        disabled={busy || offline}
        onChange={pickExecutor}
      />
      <ModelPicker
        label="子代理默认模型"
        presets={presets}
        value={card.subagentPresetId}
        {...(subagentDefault ? { fallback: subagentDefault } : { noneLabel: "同主代理模型" })}
        hint="子任务没有单独指定模型时用它；只影响之后启动的子代理。"
        onChange={(subagentPresetId) => void updateCard({ subagentPresetId })}
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
      <SubtaskList card={card} presets={presets} sessions={sessions} />
      {canExecute(card) ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Btn
            variant="primary"
            icon="Play"
            label="立即执行"
            disabled={busy || offline}
            onPress={() => {
              if (noVerifier) {
                toast.error("每张卡都要验证：请先在验证页选择验证模型");
                onOpenVerification();
                return;
              }
              void act(() => api.execStart({ card: card.id }), `已开始执行 ${card.key}`);
            }}
          />
          {noVerifier ? <Muted size={12}>还没有验证模型：执行前先在「验证」页选一个（或设置默认验证模型）。</Muted> : null}
        </View>
      ) : null}

      <Conversation
        api={api}
        card={card}
        thread="exec"
        items={items}
        busyText={running?.state === "working" || running?.state === "starting" ? "主代理正在工作…" : null}
        emptyText="执行对话：主代理和子代理的提问、阶段小结和完成总结都在这里；复核结论在「复核」页。"
        composerHint={
          running
            ? "消息会转给主代理；它在等你回答时，这条消息就是回答。"
            : card.column === "done"
              ? "卡片已完成，发言只作记录。"
              : "主代理这一轮已结束时，消息会把它唤回来继续。"
        }
        placeholder="回答主代理或子代理的问题，或补充要求…"
        targets={chatTargets(card)}
        reload={reload}
        onOpenVerification={onOpenVerification}
      />
    </View>
  );
}
