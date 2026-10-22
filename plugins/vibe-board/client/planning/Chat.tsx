// A card conversation (WP-105): the plan conversation (owner, planning model, scout model, the
// planner's suggestions) or the execution conversation (owner, executing model, reviewer, status
// lines). Only key messages; "查看完整会话" opens the agent session with every tool call.

import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Text, View } from "react-native";
import type { CardView, ChatThread } from "../../shared/vibe/contract";
import { errorMessage } from "../board/logic";
import { useLocalStatus, type BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { Btn, Chip, Field, Muted, TextField } from "../common/ui";
import {
  proposalDiff,
  type ChatItem,
  type MessageItem,
  type ProposalItem,
  type SystemItem,
} from "./logic";

export interface ConversationProps {
  api: BoardApi;
  card: CardView;
  thread: ChatThread;
  items: readonly ChatItem[];
  /** Shown under the list while the other side works on an answer. */
  busyText?: string | null;
  emptyText: string;
  composerHint: string;
  placeholder: string;
  reload: () => void;
  onOpenVerification?: () => void;
}

export function Conversation(props: ConversationProps) {
  const { api, card, thread, items, reload } = props;
  const { compact } = useHost();
  const toast = useToast();
  const { offline } = useLocalStatus();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await api.chatSend({ card: card.id, text: value, thread, ...(compact ? { actor: "phone" as const } : {}) });
      setText("");
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      {items.length === 0 ? <Muted size={13}>{props.emptyText}</Muted> : null}
      {items.map((item) => (
        <ChatRow
          key={item.id}
          item={item}
          card={card}
          api={api}
          reload={reload}
          offline={offline}
          onOpenVerification={props.onOpenVerification}
        />
      ))}
      {props.busyText ? <Muted size={12}>{props.busyText}</Muted> : null}
      <Field label="发言" hint={offline ? "离线，联网后发送" : props.composerHint}>
        <TextField multiline value={text} onChangeText={setText} placeholder={props.placeholder} />
      </Field>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Btn
          variant="primary"
          icon="Send"
          label={offline ? "发送（联网后送达）" : "发送"}
          disabled={sending || !text.trim()}
          onPress={submit}
        />
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

export function Bubble({ item }: { item: MessageItem }) {
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
        </Muted>
      </View>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>
        {item.text}
      </Text>
      {open && item.detail ? (
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: "monospace" }}>
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
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>规划模型的修改建议</Text>
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
