// 会话汇总: every live session in one list. Sessions waiting for you (question / permission) are
// pinned on top, longest wait first, then errors, running, and just-finished ones. Works offline:
// the data comes from the phone's replica ("截至 hh:mm"), answers are queued and sent on reconnect.

import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { errorMessage } from "../board/logic";
import { useBoardApi, useBoardData, useLocalStatus, useRefresh, useSessionsData } from "../common/api";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Dot, Muted, TextField } from "../common/ui";
import {
  BUCKET_LABELS,
  ROLE_LABELS,
  asOfLabel,
  buildOverview,
  formatWait,
  type SessionBucket,
  type SessionRow,
} from "./logic";

export function SessionsScreen(props: PluginScreenProps) {
  return (
    <HostProvider
      value={{
        theme: props.theme,
        compact: props.layout.compact,
        openAgent: props.navigation ? (input) => props.navigation?.openAgent(input) : undefined,
      }}
    >
      <SessionsContent />
    </HostProvider>
  );
}

function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

interface QueuedReply {
  status: string;
  text: string;
  staleReason?: string;
}

function SessionsContent() {
  const { theme } = useHost();
  const { sessions, loading, error } = useSessionsData();
  const { cards } = useBoardData();
  const status = useLocalStatus();
  const now = useNow();
  const rows = useMemo(() => buildOverview(sessions, cards, now), [sessions, cards, now]);
  const queued = useMemo(() => new Map(status.replies.map((r) => [r.questionId, r])), [status.replies]);

  const groups = (["waiting", "error", "running", "finished"] as SessionBucket[])
    .map((bucket) => ({ bucket, rows: rows.filter((r) => r.bucket === bucket) }))
    .filter((g) => g.rows.length > 0);

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600", flex: 1 }}>会话汇总</Text>
        {status.offline ? (
          <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>离线 · {asOfLabel(status.asOf)}</Text>
        ) : null}
      </View>
      {status.offline ? <Muted>离线中：会话与提问只读，写好的回答会在重连后自动发送。</Muted> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>无法加载会话：{errorMessage(error)}</Text> : null}
      {!loading && !error && rows.length === 0 ? <Muted>现在没有进行中的会话。</Muted> : null}
      {groups.map((group) => (
        <View key={group.bucket} style={{ gap: 8 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
            {BUCKET_LABELS[group.bucket]} · {group.rows.length}
          </Text>
          {group.rows.map((row) => (
            <SessionItem
              key={row.session.id}
              row={row}
              offline={status.offline}
              queuedReply={row.question ? queued.get(row.question.requestId) : undefined}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function SessionItem({
  row,
  offline,
  queuedReply,
}: {
  row: SessionRow;
  offline: boolean;
  queuedReply?: QueuedReply;
}) {
  const { theme, openAgent } = useHost();
  const { session, card, bucket, question } = row;
  const color =
    bucket === "waiting" || bucket === "error"
      ? theme.colors.statusDanger
      : bucket === "running"
        ? theme.colors.accent
        : theme.colors.foregroundMuted;
  return (
    <View
      accessibilityLabel={`会话 ${card?.key ?? session.agentId}：${BUCKET_LABELS[bucket]}`}
      style={{
        borderRadius: 8,
        borderWidth: 1,
        borderColor: bucket === "waiting" ? theme.colors.statusDanger : theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 10,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Dot color={color} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {card?.key ?? "无卡片"} · {ROLE_LABELS[session.role]} · {session.currentProvider}
        </Text>
        <View style={{ flex: 1 }} />
        {bucket === "waiting" ? (
          <Text style={{ color, fontSize: 11, fontWeight: "600" }}>已等待 {formatWait(row.waitedMs)}</Text>
        ) : (
          <Text style={{ color, fontSize: 11 }}>{BUCKET_LABELS[bucket]}</Text>
        )}
      </View>
      {card ? (
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }} numberOfLines={2}>
          {card.title}
        </Text>
      ) : null}
      {bucket === "error" && session.errorMessage ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }} numberOfLines={3}>
          {session.errorMessage}
        </Text>
      ) : null}
      {question ? <QuestionBox row={row} offline={offline} queuedReply={queuedReply} /> : null}
      {openAgent && !offline ? (
        <View style={{ flexDirection: "row" }}>
          <Btn small icon="MessageSquare" label="打开会话" onPress={() => openAgent({ agentId: session.agentId })} />
        </View>
      ) : null}
    </View>
  );
}

function QuestionBox({
  row,
  offline,
  queuedReply,
}: {
  row: SessionRow;
  offline: boolean;
  queuedReply?: QueuedReply;
}) {
  const { theme } = useHost();
  const api = useBoardApi();
  const toast = useToast();
  const refresh = useRefresh();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { card, question } = row;
  if (!question || !card) return null;
  const isQuestion = question.kind === "question";
  const heading = question.questions.join("\n") || question.title || question.name || "agent 在等你确认";
  const waitingToSend = queuedReply?.status === "pending" || queuedReply?.status === "sending";

  const send = async (answer: string) => {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      const result = await api.replySend({
        id: `reply-${question.requestId}`,
        cardId: card.id,
        questionId: question.requestId,
        text: answer.trim(),
      });
      toast.show(result.sent ? "已发送" : "已暂存，重连后发送");
      setText("");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 6, padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{heading}</Text>
      {question.description ? <Muted>{question.description}</Muted> : null}
      {waitingToSend ? (
        <Muted>待发送（重连后确认问题仍未回答再发）：{queuedReply?.text}</Muted>
      ) : (
        <>
          <TextField
            value={text}
            onChangeText={setText}
            placeholder={isQuestion ? "输入回答" : "拒绝时可写原因"}
            editable={!busy}
          />
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {isQuestion ? (
              <Btn
                small
                variant="primary"
                label={offline ? "暂存回答" : "发送回答"}
                disabled={busy || !text.trim()}
                onPress={() => void send(text)}
              />
            ) : (
              <>
                <Btn
                  small
                  variant="primary"
                  label={offline ? "暂存批准" : "批准"}
                  disabled={busy}
                  onPress={() => void send("yes")}
                />
                <Btn
                  small
                  variant="danger"
                  label={offline ? "暂存拒绝" : "拒绝"}
                  disabled={busy}
                  onPress={() => void send(text.trim() || "no")}
                />
              </>
            )}
          </View>
        </>
      )}
    </View>
  );
}
