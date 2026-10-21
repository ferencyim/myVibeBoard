// Card group chat (WP-92): the owner, the master (planner) agent, the executor, the reviewer and
// scouts talk on the card. The master proposes card changes as suggestion cards the owner accepts
// or declines. The full event log stays in the timeline tab.

import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { AgentSession, CardEvent, CardView, PlanVersion } from "../../shared/vibe/contract";
import { errorMessage } from "../board/logic";
import { useLocalStatus, type BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { Btn, Chip, Field, Muted, TextField } from "../common/ui";
import {
  HANDOFF_REQUEST_BODY,
  chatItemsOf,
  handoffAnswering,
  headerActions,
  masterBusy,
  planReady,
  plannerSessionOf,
  proposalDiff,
  routeHint,
  sessionStatusLabel,
  type ChatItem,
  type MessageItem,
  type ProposalItem,
  type SystemItem,
} from "./logic";

const HANDOFF_WAIT_MS = 90_000;
const START_TEXT = "请阅读这张卡片，说说你的看法，并提出需要澄清的问题。";

export interface ChatProps {
  api: BoardApi;
  card: CardView;
  events: readonly CardEvent[];
  sessions: readonly AgentSession[];
  plans: readonly PlanVersion[];
  reload: () => void;
  onOpenVerification?: () => void;
}

export function Chat({ api, card, events, sessions, plans, reload, onOpenVerification }: ChatProps) {
  const { theme, compact } = useHost();
  const toast = useToast();
  const { offline } = useLocalStatus();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [handoffSlow, setHandoffSlow] = useState(false);
  const moved = useRef(false);

  const items = chatItemsOf(events);
  const session = plannerSessionOf(sessions);
  const isDraft = card.column === "draft";
  const latestPlan = plans.at(-1);
  const busy =
    masterBusy(items, card, sessions) ||
    (isDraft && (session?.state === "working" || session?.state === "starting"));
  const actions = headerActions(card);

  const send = async (message: string): Promise<boolean> => {
    const value = message.trim();
    if (!value || sending) return false;
    setSending(true);
    try {
      await api.chatSend({ card: card.id, text: value, ...(compact ? { actor: "phone" as const } : {}) });
      reload();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    const value = text;
    if (await send(value)) setText("");
  };

  const runAction = async (key: "review" | "dispatch") => {
    try {
      if (key === "review") await api.cardsRequestReview({ card: card.id });
      else await api.cardsDispatch({ card: card.id });
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

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
      const { event } = await api.eventsAdd({
        card: card.id,
        type: "note",
        authorKind: "user",
        author: "user",
        body: HANDOFF_REQUEST_BODY,
      });
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

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>群聊</Text>
        <Chip label={sessionStatusLabel(session)} />
        {latestPlan ? <Chip label={`方案 v${latestPlan.version}`} /> : null}
        {actions.map((a) => (
          <Btn
            key={a.key}
            small
            icon={a.key === "review" ? "Search" : "Play"}
            label={a.label}
            disabled={offline}
            onPress={() => runAction(a.key)}
          />
        ))}
      </View>

      {items.length === 0 ? (
        <View style={{ gap: 8 }}>
          <Muted size={13}>
            在这里与总 agent、执行 agent 讨论这张卡片。总 agent 想改标题/描述/验收标准时会给出建议，由你采纳。
          </Muted>
          {isDraft ? (
            <Btn
              variant="primary"
              icon="MessageSquare"
              label="开始讨论"
              disabled={sending}
              onPress={() => send(START_TEXT)}
            />
          ) : null}
        </View>
      ) : null}

      {items.map((item) => (
        <ChatRow
          key={item.id}
          item={item}
          card={card}
          api={api}
          reload={reload}
          offline={offline}
          onOpenVerification={onOpenVerification}
        />
      ))}
      {busy ? <Muted size={12}>总 agent 正在思考…</Muted> : null}

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

      <Field label="发言" hint={offline ? "离线，联网后发送" : routeHint(card, sessions)}>
        <TextField
          multiline
          value={text}
          onChangeText={setText}
          placeholder="补充信息、回答问题或提出修改…"
        />
      </Field>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Btn
          variant="primary"
          icon="Send"
          label={offline ? "发送（联网后送达）" : "发送"}
          disabled={sending || !text.trim()}
          onPress={submit}
        />
        {isDraft && items.length > 0 ? (
          <Btn
            icon="ArrowRight"
            label={handoffId ? "生成交接摘要…" : "转入待办"}
            disabled={!!handoffId || offline}
            onPress={requestHandoff}
          />
        ) : null}
        {handoffId && handoffSlow ? (
          <Btn small variant="ghost" label="不等摘要，直接转入" onPress={moveToTodo} />
        ) : null}
      </View>
    </View>
  );
}

function ChatRow({
  item,
  card,
  api,
  reload,
  offline,
  onOpenVerification,
}: {
  item: ChatItem;
  card: CardView;
  api: BoardApi;
  reload: () => void;
  offline: boolean;
  onOpenVerification?: () => void;
}) {
  if (item.kind === "proposal") {
    return <Proposal item={item} card={card} api={api} reload={reload} offline={offline} />;
  }
  if (item.kind === "system") return <SystemRow item={item} onOpenVerification={onOpenVerification} />;
  if (item.author === "system") {
    return <SystemRow item={{ kind: "system", id: item.id, text: item.text, at: item.at }} />;
  }
  return <Bubble item={item} />;
}

function SystemRow({ item, onOpenVerification }: { item: SystemItem; onOpenVerification?: () => void }) {
  return (
    <View style={{ alignSelf: "center", alignItems: "center", maxWidth: "92%", gap: 2 }}>
      <Muted size={11}>{item.text}</Muted>
      {item.link === "verification" && onOpenVerification ? (
        <Btn small variant="ghost" label="查看验证" onPress={onOpenVerification} />
      ) : null}
    </View>
  );
}

function Bubble({ item }: { item: MessageItem }) {
  const { theme, openAgent } = useHost();
  const [open, setOpen] = useState(false);
  const mine = item.author === "user";
  const tagColor =
    item.author === "executor"
      ? theme.colors.statusSuccess
      : item.author === "reviewer"
        ? theme.colors.statusWarning
        : item.author === "scout"
          ? theme.colors.foregroundMuted
          : theme.colors.accent;
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
        borderColor: item.error ? theme.colors.statusDanger : theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 1,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: mine ? theme.colors.border : tagColor,
          }}
        >
          <Text style={{ color: mine ? theme.colors.foreground : tagColor, fontSize: 11 }}>{item.label}</Text>
        </View>
        {item.msgKindLabel ? <Muted size={11}>{item.msgKindLabel}</Muted> : null}
        <Muted size={11}>
          {item.at ? item.at.replace("T", " ").slice(0, 16) : ""}
          {mine && !item.answered ? " · 等待回复" : ""}
          {item.planVersion ? ` · 已写入方案 v${item.planVersion}` : ""}
        </Muted>
      </View>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>
        {item.text}
      </Text>
      {open && item.detail ? (
        <Text
          selectable
          style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: "monospace" }}
        >
          {item.detail}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {item.detail ? (
          <Btn small variant="ghost" label={open ? "收起" : "展开详情"} onPress={() => setOpen(!open)} />
        ) : null}
        {item.agentId && openAgent ? (
          <Btn
            small
            variant="ghost"
            icon="ExternalLink"
            label="查看完整会话"
            onPress={() => openAgent({ agentId: item.agentId! })}
          />
        ) : null}
      </View>
    </View>
  );
}

function Proposal({
  item,
  card,
  api,
  reload,
  offline,
}: {
  item: ProposalItem;
  card: CardView;
  api: BoardApi;
  reload: () => void;
  offline: boolean;
}) {
  const { theme } = useHost();
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const diffs = proposalDiff(item, card);
  const pending = item.status === "pending";

  const resolve = async (accept: boolean) => {
    setWorking(true);
    try {
      if (accept) await api.proposalsAccept({ eventId: item.id });
      else await api.proposalsReject({ eventId: item.id });
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: pending ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface1,
        opacity: pending || item.status === "accepted" ? 1 : 0.7,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>
          总 agent 的修改建议
        </Text>
        <Chip label={item.statusLabel} />
      </View>
      {diffs.map((d) => (
        <View key={d.field} style={{ gap: 2 }}>
          <Muted size={11}>{d.label}</Muted>
          {d.before !== undefined ? (
            <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              改动前：{d.before || "（空）"}
            </Text>
          ) : null}
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>
            改动后：{d.after || "（空）"}
          </Text>
        </View>
      ))}
      {item.rationale ? <Muted size={12}>理由：{item.rationale}</Muted> : null}
      {pending ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn small variant="primary" label="采纳" disabled={offline || working} onPress={() => resolve(true)} />
            <Btn small label="不采纳" disabled={offline || working} onPress={() => resolve(false)} />
          </View>
          {offline ? <Muted size={11}>需在线才能采纳/不采纳</Muted> : null}
        </View>
      ) : null}
    </View>
  );
}
