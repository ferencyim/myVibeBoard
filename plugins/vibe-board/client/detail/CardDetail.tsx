// Card detail: fields, preset/tag/priority pickers, reference images, timeline, plan versions,
// the draft discussion tab (WP-33) and a placeholder for the verification result tab (WP-21).

import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { type CardView, type Preset, type Project, type Tag } from "../../shared/vibe/contract";
import { ReviewerSelect } from "../board/ReviewerSelect";
import { COLUMN_LABELS, errorMessage, evidenceDefault, userTargets } from "../board/logic";
import { queryKey, type BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { canPickFile, pickImage } from "../common/pick-file";
import { Btn, Check, Chip, Dot, Field, Muted, TextField } from "../common/ui";
import { Chat } from "../planning/Chat";
import { PresetSelector, PrioritySelector, TagSelector } from "../presets/selectors";
import type { ProviderUsageLike } from "../presets/logic";
import { VerificationPanel } from "../verification/VerificationPanel";
import { discard, edit, initialDraft, isDirty, reconcileField } from "./draft";
import { EVENT_TYPE_LABELS, describeEvent } from "./events";
import { useOptimisticCard } from "./optimistic";

type Tab = "details" | "chat" | "timeline" | "plans" | "verification";
const TAB_LABELS: Record<Tab, string> = {
  details: "详情",
  chat: "群聊",
  timeline: "时间线",
  plans: "方案",
  verification: "验证",
};

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
  const detail = useQuery({
    queryKey: queryKey("card", cardKey),
    queryFn: () => api.cardsGet({ card: cardKey }),
    refetchInterval: 3000,
  });
  const toast = useToast();
  const data = detail.data;
  const reload = () => {
    refresh();
    return detail.refetch();
  };

  if (!data) {
    return (
      <View style={{ flex: 1, padding: 16, gap: 12 }}>
        <Btn label="返回" icon="ArrowLeft" onPress={props.onClose} />
        <Muted size={14}>{detail.error ? errorMessage(detail.error) : "加载中…"}</Muted>
      </View>
    );
  }
  const card = data.card;
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
        <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 12, paddingBottom: 8 }}>
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <Chip key={t} label={TAB_LABELS[t]} selected={tab === t} onPress={() => setTab(t)} />
          ))}
        </View>
      </ScrollView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 14 }}>
        {tab === "details" ? (
          <Details {...props} card={card} reload={reload} move={move} attachments={data.attachments} sessions={data.sessions} />
        ) : null}
        {tab === "timeline" ? (
          <Timeline api={api} card={card} events={data.events} reload={reload} />
        ) : null}
        {tab === "plans" ? <Plans plans={data.plans} /> : null}
        {tab === "chat" ? (
          <Chat
            api={api}
            card={card}
            events={data.events}
            sessions={data.sessions}
            plans={data.plans}
            reload={reload}
            onOpenVerification={() => setTab("verification")}
          />
        ) : null}
        {tab === "verification" ? (
          <VerificationPanel api={api} card={card} reload={reload} />
        ) : null}
      </ScrollView>
    </View>
  );
}

function Placeholder({ title, text }: { title: string; text: string }) {
  const { theme } = useHost();
  return (
    <View
      style={{
        padding: 16,
        gap: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{title}</Text>
      <Muted size={13}>{text}</Muted>
    </View>
  );
}

function Details({
  card: serverCard,
  api,
  presets,
  tags,
  usage,
  reload,
  move,
  attachments,
  sessions,
  onClose,
}: CardDetailProps & {
  card: CardView;
  reload: () => Promise<unknown>;
  move: (to: CardView["column"]) => void;
  attachments: { id: string; filename: string; mimeType: string }[];
  sessions: { id: string; agentId: string; role: string; state: string; currentProvider: string }[];
}) {
  const { openAgent } = useHost();
  const toast = useToast();
  // Picks show at once; the write and the refetch happen in the background (see optimistic.ts).
  const { card, update: updateCard } = useOptimisticCard(
    serverCard,
    (patch) => api.cardsUpdate({ card: serverCard.id, ...patch }),
    reload,
    (e) => toast.error(errorMessage(e)),
  );
  const update = (patch: Omit<Parameters<BoardApi["cardsUpdate"]>[0], "card">) => {
    void updateCard(patch);
  };

  // The card is polled; edited fields keep the user's text, untouched ones follow the server.
  const [drafts, setDrafts] = useState({
    title: initialDraft(card.title),
    description: initialDraft(card.description),
    acceptance: initialDraft(card.acceptance),
  });
  const synced = {
    title: reconcileField(drafts.title, card.title),
    description: reconcileField(drafts.description, card.description),
    acceptance: reconcileField(drafts.acceptance, card.acceptance),
  };
  if (
    synced.title !== drafts.title ||
    synced.description !== drafts.description ||
    synced.acceptance !== drafts.acceptance
  ) {
    setDrafts(synced);
  }
  const title = synced.title.local;
  const description = synced.description.local;
  const acceptance = synced.acceptance.local;
  const setField = (field: keyof typeof drafts, value: string) =>
    setDrafts((d) => ({ ...d, [field]: edit(d[field], value) }));
  const dirty = isDirty(synced.title) || isDirty(synced.description) || isDirty(synced.acceptance);
  const discardEdits = () =>
    setDrafts({
      title: discard(card.title),
      description: discard(card.description),
      acceptance: discard(card.acceptance),
    });

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
      <Field label="描述">
        <TextField multiline value={description} onChangeText={(v) => setField("description", v)} />
      </Field>
      <Field label="验收标准" hint="独立验证 agent 按此逐条检查。">
        <TextField multiline value={acceptance} onChangeText={(v) => setField("acceptance", v)} />
      </Field>
      {dirty ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn
            variant="primary"
            label="保存修改"
            onPress={() => update({ title, description, acceptance })}
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
        <PrioritySelector value={card.priority} onChange={(priority) => update({ priority })} />
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
              tagIds,
              ...(wasDefault ? { needsEvidence: evidenceDefault(tagIds, tags) } : {}),
            });
          }}
        />
      </Field>
      <Check
        label="需要验证证据（截图/录屏）"
        value={card.needsEvidence}
        onChange={(needsEvidence) => update({ needsEvidence })}
      />
      <Field label="执行 Agent 预设" hint="未预选时采用总 agent 的推荐。">
        <PresetSelector
          presets={presets}
          value={card.presetId}
          suggestedId={card.suggestedPresetId}
          usage={usage}
          onChange={(presetId) => update({ presetId })}
        />
      </Field>

      <Field label="复核模型" hint="任务完成后由该模型 review 代码改动；发现严重问题会自动退回执行 agent。">
        <ReviewerSelect
          presets={presets}
          value={card.reviewerPresetId}
          onChange={(reviewerPresetId) => update({ reviewerPresetId })}
        />
      </Field>

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

function Plans({
  plans,
}: {
  plans: {
    id: string;
    version: number;
    createdAt: string;
    snapshot: { description: string; checks: { text: string }[]; subCards: { title: string }[]; notes?: string };
  }[];
}) {
  const { theme } = useHost();
  const [open, setOpen] = useState<string | null>(plans[plans.length - 1]?.id ?? null);
  if (plans.length === 0) return <Muted size={13}>还没有方案版本（由讨论会话写回）。</Muted>;
  return (
    <View style={{ gap: 10 }}>
      {[...plans].reverse().map((p) => (
        <View key={p.id} style={{ gap: 6 }}>
          <Chip
            label={`v${p.version} · ${p.createdAt.replace("T", " ").slice(0, 16)}`}
            selected={open === p.id}
            onPress={() => setOpen(open === p.id ? null : p.id)}
          />
          {open === p.id ? (
            <View style={{ gap: 6, paddingLeft: 8 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{p.snapshot.description}</Text>
              {p.snapshot.checks.map((c, i) => (
                <Text key={i} style={{ color: theme.colors.foreground, fontSize: 13 }}>
                  ☐ {c.text}
                </Text>
              ))}
              {p.snapshot.subCards.map((s, i) => (
                <Muted key={i} size={13}>
                  子卡：{s.title}
                </Muted>
              ))}
              {p.snapshot.notes ? <Muted size={13}>{p.snapshot.notes}</Muted> : null}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}
