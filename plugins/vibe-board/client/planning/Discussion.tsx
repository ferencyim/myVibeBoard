// Draft discussion tab (WP-33): talk to the card's planning session, watch plan versions appear,
// and hand the card over to todo (the owner's decision; the agent only hints "ready").

import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { AgentSession, CardEvent, CardView, PlanVersion } from "../../shared/vibe/contract";
import { errorMessage } from "../board/logic";
import type { BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { Btn, Chip, Field, Muted, TextField } from "../common/ui";
import {
  HANDOFF_REQUEST_BODY,
  discussionOf,
  handoffAnswering,
  planReady,
  plannerSessionOf,
  sessionStatusLabel,
  userMessageBody,
  waitingForPlanner,
  type DiscussionItem,
} from "./logic";

const OUTBOX_RETRY_MS = 5000;
const HANDOFF_WAIT_MS = 90_000;
const START_TEXT = "请阅读这张卡片，说说你的看法，并提出需要澄清的问题。";

export interface DiscussionProps {
  api: BoardApi;
  card: CardView;
  events: readonly CardEvent[];
  sessions: readonly AgentSession[];
  plans: readonly PlanVersion[];
  reload: () => void;
}

export function Discussion({ api, card, events, sessions, plans, reload }: DiscussionProps) {
  const { theme } = useHost();
  const toast = useToast();
  const [text, setText] = useState("");
  // Replies written while the board cannot be reached are kept here and sent when it is back.
  const [outbox, setOutbox] = useState<string[]>([]);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [handoffSlow, setHandoffSlow] = useState(false);
  const moved = useRef(false);

  const items = discussionOf(events);
  const session = plannerSessionOf(sessions);
  const isDraft = card.column === "draft";
  const latestPlan = plans.at(-1);
  const busy =
    waitingForPlanner(items) || session?.state === "working" || session?.state === "starting";

  const post = (body: unknown) =>
    api.eventsAdd({ card: card.id, type: "note", authorKind: "user", author: "user", body });

  const send = async (message: string) => {
    const value = message.trim();
    if (!value) return;
    try {
      await post(userMessageBody(value));
      reload();
    } catch {
      setOutbox((o) => [...o, value]);
    }
  };

  // Offline outbox: retry the oldest queued reply until it gets through, keeping the order.
  useEffect(() => {
    if (outbox.length === 0) return;
    const timer = setInterval(async () => {
      const [first] = outbox;
      if (first === undefined) return;
      try {
        await post(userMessageBody(first));
        setOutbox((o) => o.slice(1));
        reload();
      } catch {
        // still offline
      }
    }, OUTBOX_RETRY_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbox]);

  const moveToTodo = async () => {
    if (moved.current) return;
    moved.current = true;
    try {
      await api.cardsMove({ card: card.id, to: "todo", actor: "user" });
      reload();
    } catch (e) {
      moved.current = false;
      toast.error(errorMessage(e));
    } finally {
      setHandoffId(null);
      setHandoffSlow(false);
    }
  };

  // Hand-off: ask for the summary first and move the card once the planner has written it, so
  // the executing agent's brief can quote it.
  const requestHandoff = async () => {
    try {
      const { event } = await post(HANDOFF_REQUEST_BODY);
      moved.current = false;
      setHandoffId(event.id);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  useEffect(() => {
    if (handoffId && handoffAnswering(events, handoffId)) void moveToTodo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, handoffId]);
  useEffect(() => {
    if (!handoffId) return;
    const timer = setTimeout(() => setHandoffSlow(true), HANDOFF_WAIT_MS);
    return () => clearTimeout(timer);
  }, [handoffId]);

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    await send(value);
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>草稿讨论</Text>
        <Chip label={sessionStatusLabel(session)} />
        {latestPlan ? <Chip label={`方案 v${latestPlan.version}`} /> : null}
      </View>

      {items.length === 0 ? (
        <View style={{ gap: 8 }}>
          <Muted size={13}>
            与总 agent 的规划会话来回讨论，直到方案完善。每轮共识会写回「方案」页签（版本历史），转入待办由你决定。
          </Muted>
          {isDraft ? (
            <Btn variant="primary" icon="MessageSquare" label="开始讨论" onPress={() => send(START_TEXT)} />
          ) : null}
        </View>
      ) : null}

      {items.map((item) => (
        <Bubble key={item.id} item={item} />
      ))}
      {outbox.map((m, i) => (
        <Bubble
          key={`outbox-${i}`}
          item={{ id: `outbox-${i}`, kind: "user", text: m, at: "", answered: false }}
          queued
        />
      ))}
      {outbox.length > 0 ? (
        <Muted size={12}>离线中：{outbox.length} 条回复已暂存，连上后自动发送。</Muted>
      ) : null}
      {busy && outbox.length === 0 ? <Muted size={12}>总 agent 正在思考…</Muted> : null}

      {isDraft && planReady(items) && !handoffId ? (
        <View
          style={{
            padding: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.accent,
            gap: 6,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>总 agent 认为方案已可执行。</Text>
          <Muted size={12}>它不会自己移动卡片：确认后点「转入待办」。</Muted>
        </View>
      ) : null}

      {isDraft ? (
        <>
          <Field label="回复" hint="断网时可以先写，连上后自动发送。">
            <TextField
              multiline
              value={text}
              onChangeText={setText}
              placeholder="补充信息、回答问题或提出修改…"
            />
          </Field>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="primary" icon="Send" label="发送" disabled={!text.trim()} onPress={submit} />
            {items.length > 0 ? (
              <Btn
                icon="ArrowRight"
                label={handoffId ? "生成交接摘要…" : "转入待办"}
                disabled={!!handoffId}
                onPress={requestHandoff}
              />
            ) : null}
            {handoffId && handoffSlow ? (
              <Btn small variant="ghost" label="不等摘要，直接转入" onPress={moveToTodo} />
            ) : null}
          </View>
        </>
      ) : (
        <Muted size={12}>卡片已不在草稿列，讨论已归档（只读）。移回草稿后发送消息可继续讨论。</Muted>
      )}
    </View>
  );
}

function Bubble({ item, queued }: { item: DiscussionItem; queued?: boolean }) {
  const { theme } = useHost();
  const [open, setOpen] = useState(false);
  const mine = item.kind === "user";
  const collapsible = item.kind === "research" || item.kind === "handoff";
  const label =
    item.kind === "user"
      ? "我"
      : item.kind === "planner"
        ? "总 agent"
        : item.kind === "research"
          ? "子 agent 调研"
          : "交接摘要";
  const body =
    collapsible && !open
      ? `${item.text.slice(0, 140)}${item.text.length > 140 ? "…" : ""}`
      : item.text;
  return (
    <View
      style={{
        alignSelf: mine ? "flex-end" : "flex-start",
        maxWidth: "92%",
        gap: 4,
        padding: 10,
        borderRadius: 10,
        backgroundColor: mine ? theme.colors.surface2 : theme.colors.surface1,
        borderWidth: 1,
        borderColor:
          item.kind === "planner" && item.error ? theme.colors.statusDanger : theme.colors.border,
        opacity: queued ? 0.6 : 1,
      }}
    >
      <Muted size={11}>
        {label}
        {item.at ? ` · ${item.at.replace("T", " ").slice(0, 16)}` : ""}
        {queued ? " · 待发送" : ""}
        {item.kind === "user" && !item.answered && !queued ? " · 等待回复" : ""}
        {item.kind === "planner" && item.planVersion ? ` · 已写入方案 v${item.planVersion}` : ""}
      </Muted>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>
        {body}
      </Text>
      {collapsible ? (
        <Btn small variant="ghost" label={open ? "收起" : "展开"} onPress={() => setOpen(!open)} />
      ) : null}
      {item.kind === "handoff" && item.path ? <Muted size={11}>{item.path}</Muted> : null}
    </View>
  );
}
