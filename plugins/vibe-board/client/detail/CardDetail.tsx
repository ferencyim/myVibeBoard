// Card detail (WP-105): five tabs - 详情 (fields), 方案 (scout / planning model, the single plan,
// acceptance criteria, plan conversation), 执行 (executing / reviewing model, 立即执行, execution
// conversation), 验证 (review conclusions and evidence verification) and 时间线 (card events).
// 方案 / 执行 / 验证 carry an unread dot; opening the tab marks it read (synced to the phone).

import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import {
  isTabUnread,
  markReadPatch,
  type CardEvent,
  type CardView,
  type Preset,
  type Project,
  type Tag,
  type UnreadTab,
} from "../../shared/vibe/contract";
import { COLUMN_LABELS, errorMessage, evidenceDefault, userTargets } from "../board/logic";
import { queryKey, type BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { canPickFile, pickImage } from "../common/pick-file";
import { Btn, Check, Chip, Dot, Field, Muted, TextField } from "../common/ui";
import { Bubble } from "../planning/Chat";
import { ExecTab } from "../planning/ExecTab";
import { PlanTab } from "../planning/PlanTab";
import { reviewItemsOf } from "../planning/logic";
import { PrioritySelector, TagSelector } from "../presets/selectors";
import type { ProviderUsageLike } from "../presets/logic";
import { VerificationPanel } from "../verification/VerificationPanel";
import { discard, edit, initialDraft, isDirty, reconcileField } from "./draft";
import { EVENT_TYPE_LABELS, describeEvent } from "./events";

type Tab = "details" | UnreadTab | "timeline";
const TABS: readonly Tab[] = ["details", "plan", "exec", "verify", "timeline"];
const TAB_LABELS: Record<Tab, string> = {
  details: "详情",
  plan: "方案",
  exec: "执行",
  verify: "验证",
  timeline: "时间线",
};
const isUnreadTab = (t: Tab): t is UnreadTab => t === "plan" || t === "exec" || t === "verify";

export interface CardDetailProps {
  cardKey: string;
  api: BoardApi;
  projects: readonly Project[];
  presets: readonly Preset[];
  tags: readonly Tag[];
  usage: readonly ProviderUsageLike[] | null;
  projectColorOf: (projectId: string) => string;
  refresh: () => void;
  onClose: () => void;
}

export function CardDetail(props: CardDetailProps) {
  const { api, cardKey, refresh } = props;
  const { theme } = useHost();
  const [tab, setTab] = useState<Tab>("details");
  const marking = useRef<string | null>(null);
  const detail = useQuery({
    queryKey: queryKey("card", cardKey),
    queryFn: () => api.cardsGet({ card: cardKey }),
    refetchInterval: 3000,
  });
  const toast = useToast();
  const data = detail.data;
  const reload = () => {
    refresh();
    void detail.refetch();
  };
  const card = data?.card;

  // Opening a tab (and staying on it while new content arrives) marks it read. The read position
  // is the tab's newest content time, so a phone with a lagging clock still clears the dot.
  const readPatch = card && isUnreadTab(tab) ? markReadPatch(card, tab) : null;
  const readKey = card && readPatch ? `${card.id}:${JSON.stringify(readPatch)}` : null;
  useEffect(() => {
    if (!card || !readPatch || !readKey || marking.current === readKey) return;
    marking.current = readKey;
    api
      .cardsUpdate({ card: card.id, ...readPatch })
      .then(() => reload())
      .catch(() => {
        marking.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readKey]);

  if (!data || !card) {
    return (
      <View style={{ flex: 1, padding: 16, gap: 12 }}>
        <Btn label="返回" icon="ArrowLeft" onPress={props.onClose} />
        <Muted size={14}>{detail.error ? errorMessage(detail.error) : "加载中…"}</Muted>
      </View>
    );
  }
  const project = props.projects.find((p) => p.id === card.projectId);

  const move = async (to: CardView["column"]) => {
    try {
      await api.cardsMove({ card: card.id, to, actor: "user" });
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12 }}>
        <Btn small variant="ghost" icon="ArrowLeft" label="返回" onPress={props.onClose} />
        <Dot color={props.projectColorOf(card.projectId)} />
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{card.key}</Text>
        <Chip label={COLUMN_LABELS[card.column]} />
        <View style={{ flex: 1 }} />
        <Muted>{project?.name}</Muted>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
        <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8 }}>
          {TABS.map((t) => (
            <TabChip
              key={t}
              label={TAB_LABELS[t]}
              selected={tab === t}
              unread={isUnreadTab(t) && t !== tab && isTabUnread(card, t)}
              onPress={() => setTab(t)}
            />
          ))}
        </View>
      </ScrollView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 14 }}>
        {tab === "details" ? (
          <Details {...props} card={card} reload={reload} move={move} attachments={data.attachments} sessions={data.sessions} />
        ) : null}
        {tab === "plan" ? (
          <PlanTab
            api={api}
            card={card}
            events={data.events}
            sessions={data.sessions}
            presets={props.presets}
            reload={reload}
          />
        ) : null}
        {tab === "exec" ? (
          <ExecTab
            api={api}
            card={card}
            events={data.events}
            sessions={data.sessions}
            presets={props.presets}
            reload={reload}
            onOpenVerification={() => setTab("verify")}
          />
        ) : null}
        {tab === "verify" ? <VerifyTab api={api} card={card} events={data.events} reload={reload} /> : null}
        {tab === "timeline" ? (
          <Timeline api={api} card={card} events={data.events} reload={reload} />
        ) : null}
      </ScrollView>
    </View>
  );
}

/** A tab chip with an unread dot. */
function TabChip({
  label,
  selected,
  unread,
  onPress,
}: {
  label: string;
  selected: boolean;
  unread: boolean;
  onPress: () => void;
}) {
  const { theme } = useHost();
  return (
    <View>
      <Chip label={label} selected={selected} onPress={onPress} />
      {unread ? (
        <View accessibilityLabel={`${label}有新内容`} style={{ position: "absolute", top: -3, right: -3 }}>
          <Dot color={theme.colors.statusDanger} size={9} />
        </View>
      ) : null}
    </View>
  );
}

/** 验证: the reviewer's conclusions, then the evidence verification (WP-21). */
function VerifyTab({
  api,
  card,
  events,
  reload,
}: {
  api: BoardApi;
  card: CardView;
  events: readonly CardEvent[];
  reload: () => void;
}) {
  const reviews = reviewItemsOf(events);
  return (
    <View style={{ gap: 14 }}>
      <Field label="复核结论">
        {reviews.length === 0 ? (
          <Muted size={13}>
            {card.reviewerPresetId
              ? "还没有复核结果：执行完成后由复核模型 review。"
              : "这张卡片没有选复核模型（在执行页选择）。"}
          </Muted>
        ) : (
          <View style={{ gap: 8 }}>
            {reviews.map((item) => (
              <Bubble key={item.id} item={item} />
            ))}
          </View>
        )}
      </Field>
      <Field label="证据验证">
        <VerificationPanel api={api} card={card} reload={reload} />
      </Field>
    </View>
  );
}

function Details({
  card,
  api,
  tags,
  reload,
  move,
  attachments,
  sessions,
  onClose,
}: CardDetailProps & {
  card: CardView;
  reload: () => void;
  move: (to: CardView["column"]) => void;
  attachments: { id: string; filename: string; mimeType: string }[];
  sessions: { id: string; agentId: string; role: string; state: string; currentProvider: string }[];
}) {
  const { openAgent } = useHost();
  const toast = useToast();
  // The card is polled; edited fields keep the user's text, untouched ones follow the server.
  const [drafts, setDrafts] = useState({
    title: initialDraft(card.title),
    description: initialDraft(card.description),
  });
  const synced = {
    title: reconcileField(drafts.title, card.title),
    description: reconcileField(drafts.description, card.description),
  };
  if (synced.title !== drafts.title || synced.description !== drafts.description) {
    setDrafts(synced);
  }
  const title = synced.title.local;
  const description = synced.description.local;
  const setField = (field: keyof typeof drafts, value: string) =>
    setDrafts((d) => ({ ...d, [field]: edit(d[field], value) }));
  const dirty = isDirty(synced.title) || isDirty(synced.description);
  const discardEdits = () =>
    setDrafts({
      title: discard(card.title),
      description: discard(card.description),
    });

  const update = async (patch: Parameters<BoardApi["cardsUpdate"]>[0]) => {
    try {
      await api.cardsUpdate(patch);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const addImage = async () => {
    const file = await pickImage();
    if (!file) return;
    try {
      await api.attachmentsUpload({ card: card.id, ...file, asRefImage: true });
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const targets = userTargets(card.column);
  const imageAttachments = card.refImages.map(
    (id) => attachments.find((a) => a.id === id) ?? { id, filename: id, mimeType: "image/png" },
  );

  return (
    <>
      <Field label="标题">
        <TextField value={title} onChangeText={(v) => setField("title", v)} />
      </Field>
      <Field label="任务描述" hint="方案与验收标准在「方案」页。">
        <TextField multiline value={description} onChangeText={(v) => setField("description", v)} />
      </Field>
      {dirty ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn
            variant="primary"
            label="保存修改"
            onPress={() => update({ card: card.id, title, description })}
          />
          <Btn label="放弃修改" onPress={discardEdits} />
        </View>
      ) : null}

      <Field label="状态流转（仅限允许的移动）">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {targets.length === 0 ? <Muted>当前阶段由系统推进，无手动移动。</Muted> : null}
          {targets.map((to) => (
            <Btn key={to} small icon="ArrowRight" label={COLUMN_LABELS[to]} onPress={() => move(to)} />
          ))}
        </View>
      </Field>

      <Field label="优先级">
        <PrioritySelector value={card.priority} onChange={(priority) => update({ card: card.id, priority })} />
      </Field>
      <Field label="标签">
        <TagSelector
          tags={tags}
          value={card.tags}
          api={api}
          onTagsChanged={reload}
          onChange={(tagIds) => {
            // Tag changes reset the evidence default only when it was still at the old default.
            const wasDefault = card.needsEvidence === evidenceDefault(card.tags, tags);
            update({
              card: card.id,
              tagIds,
              ...(wasDefault ? { needsEvidence: evidenceDefault(tagIds, tags) } : {}),
            });
          }}
        />
      </Field>
      <Check
        label="需要验证证据（截图/录屏）"
        value={card.needsEvidence}
        onChange={(needsEvidence) => update({ card: card.id, needsEvidence })}
      />

      <Field label="参考图">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {imageAttachments.map((a) => (
            <RefImage
              key={a.id}
              api={api}
              attachmentId={a.id}
              onRemove={async () => {
                try {
                  await api.attachmentsDelete({ attachmentId: a.id });
                  reload();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            />
          ))}
          {canPickFile ? <Btn small icon="ImagePlus" label="添加图片" onPress={addImage} /> : null}
        </View>
        {imageAttachments.length === 0 && !canPickFile ? (
          <Muted>通过 CLI/MCP（vibe_attach）或桌面端添加。</Muted>
        ) : null}
      </Field>

      {sessions.length > 0 ? (
        <Field label="Agent 会话">
          {sessions.map((s) => (
            <View key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Muted size={13}>
                {s.role} · {s.currentProvider} · {s.state}
              </Muted>
              {openAgent ? (
                <Btn small variant="ghost" label="打开" onPress={() => openAgent({ agentId: s.agentId })} />
              ) : null}
            </View>
          ))}
        </Field>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Btn
          small
          icon="Archive"
          label="归档"
          onPress={async () => {
            try {
              await api.cardsArchive({ card: card.id });
              reload();
              onClose();
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        />
        <Btn
          small
          variant="danger"
          icon="Trash2"
          label="删除"
          onPress={async () => {
            try {
              await api.cardsDelete({ card: card.id });
              reload();
              onClose();
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        />
      </View>
    </>
  );
}

function RefImage({
  api,
  attachmentId,
  onRemove,
}: {
  api: BoardApi;
  attachmentId: string;
  onRemove: () => void;
}) {
  const { theme } = useHost();
  const image = useQuery({
    queryKey: queryKey("attachment", attachmentId),
    queryFn: () => api.attachmentsDownload({ attachmentId }),
    staleTime: Infinity,
    retry: false,
  });
  const uri = image.data
    ? `data:${image.data.attachment.mimeType};base64,${image.data.base64}`
    : null;
  return (
    <View style={{ width: 96, gap: 4 }}>
      <View
        style={{
          width: 96,
          height: 96,
          borderRadius: 8,
          overflow: "hidden",
          backgroundColor: theme.colors.surface2,
        }}
      >
        {uri ? <Image source={{ uri }} style={{ width: 96, height: 96 }} resizeMode="cover" /> : null}
      </View>
      <Pressable onPress={onRemove}>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>移除</Text>
      </Pressable>
    </View>
  );
}

function Timeline({
  api,
  card,
  events,
  reload,
}: {
  api: BoardApi;
  card: CardView;
  events: { id: string; type: keyof typeof EVENT_TYPE_LABELS; author: string; authorKind: string; body: unknown; createdAt: string }[];
  reload: () => void;
}) {
  const { theme } = useHost();
  const toast = useToast();
  const [text, setText] = useState("");
  const send = async () => {
    if (!text.trim()) return;
    try {
      await api.eventsAdd({ card: card.id, text, authorKind: "user", author: "user" });
      setText("");
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <View style={{ gap: 12 }}>
      {events.map((ev) => (
        <View
          key={ev.id}
          style={{
            gap: 2,
            paddingLeft: 10,
            borderLeftWidth: 2,
            borderLeftColor: ev.authorKind === "user" ? theme.colors.accent : theme.colors.border,
          }}
        >
          <Muted>
            {EVENT_TYPE_LABELS[ev.type]} · {ev.author || ev.authorKind} · {ev.createdAt.replace("T", " ").slice(0, 16)}
          </Muted>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {describeEvent(ev)}
          </Text>
        </View>
      ))}
      {events.length === 0 ? <Muted>暂无事件。</Muted> : null}
      <Field label="添加备注">
        <TextField multiline value={text} onChangeText={setText} />
      </Field>
      <Btn variant="primary" label="发送" disabled={!text.trim()} onPress={send} />
    </View>
  );
}
