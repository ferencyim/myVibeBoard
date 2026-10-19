// "Verification result" block at the end of a card: one-line conclusion, then every check with its
// judgement, evidence thumbnails (provenance under each) and the user's decision buttons.
// Data comes from vibe-board's own vibe.verify.* RPCs (a plugin UI can only call its own plugin).

import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Image, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { EvidenceFile, VerificationItem } from "../../shared/vibe/contract";
import { errorMessage } from "../board/logic";
import { queryKey, type BoardApi } from "../common/api";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Chip, Field, Muted, TextField } from "../common/ui";
import {
  EVIDENCE_KIND_LABELS,
  HEADLINES,
  JUDGEMENT_LABELS,
  canDecide,
  checkRejection,
  conclusionOf,
  countsLine,
  dataUri,
  evidenceForItem,
  fileName,
  formatTime,
  judgementOf,
  needsAttention,
  previewKind,
  provenance,
  shortHash,
  simulatedNotice,
  textExcerpt,
  unattachedEvidence,
  type Conclusion,
} from "./logic";

const THUMB_W = 112;
const THUMB_H = 152;

function useTone() {
  const { theme } = useHost();
  return (c: Conclusion | "pending") =>
    c === "pass"
      ? theme.colors.statusSuccess
      : c === "fail"
        ? theme.colors.statusDanger
        : c === "doubt"
          ? theme.colors.statusWarning
          : theme.colors.foregroundMuted;
}

export interface VerificationPanelProps {
  api: BoardApi;
  card: { id: string; key: string; column: string };
  /** Refresh the card/board after a decision. */
  reload: () => void;
}

export function VerificationPanel({ api, card, reload }: VerificationPanelProps) {
  const { theme } = useHost();
  const toast = useToast();
  const tone = useTone();
  const [picked, setPicked] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<EvidenceFile | null>(null);

  const list = useQuery({
    queryKey: queryKey("verify-list", card.id),
    queryFn: () => api.verifyList({ card: card.id }),
    refetchInterval: 5000,
  });
  const result = useQuery({
    queryKey: queryKey("verify", card.id, picked),
    queryFn: () => api.verifyGet({ card: card.id, ...(picked ? { verificationId: picked } : {}) }),
    refetchInterval: 3000,
  });
  const detail = result.data?.detail ?? null;
  const history = list.data?.verifications ?? [];

  if (!detail) {
    return (
      <Muted size={13}>
        {result.error ? errorMessage(result.error) : result.isLoading ? "加载中…" : "这张卡片还没有验证结果。"}
      </Muted>
    );
  }

  const conclusion = conclusionOf(detail);
  const finished = conclusion !== "running";
  const latest = history.length === 0 || detail.verification.id === history[history.length - 1]?.id;
  const decidable = canDecide(card.column) && latest;
  const notice = simulatedNotice(detail.evidence);
  const loose = unattachedEvidence(detail.items, detail.evidence);

  const act = async (fn: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    try {
      await fn();
      done?.();
      reload();
      void result.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const submitReject = () => {
    const check = checkRejection(comment);
    if (!check.ok) return toast.error(check.message);
    void act(
      () => api.verifyReject({ card: card.id, comment: check.comment }),
      () => {
        setRejecting(false);
        setComment("");
        toast.show("已驳回，意见会发给执行 agent");
      },
    );
  };

  return (
    <View style={{ gap: 12 }}>
      <View
        style={{
          gap: 4,
          padding: 12,
          borderRadius: 8,
          borderWidth: 1,
          borderLeftWidth: 4,
          borderColor: theme.colors.border,
          borderLeftColor: tone(conclusion),
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Text accessibilityRole="header" style={{ color: tone(conclusion), fontSize: 16, fontWeight: "700" }}>
          {HEADLINES[conclusion]}
        </Text>
        <Muted size={12}>{countsLine(detail.items)}</Muted>
        <Muted size={12}>
          {formatTime(detail.verification.startedAt)} · commit {shortHash(detail.verification.commitHash)} ·{" "}
          {detail.verification.mode === "tests_only" ? "仅测试/lint" : "含取证"}
        </Muted>
      </View>

      {history.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {history.map((v, i) => (
              <Chip
                key={v.id}
                label={`第 ${i + 1} 次 · ${v.conclusion ? JUDGEMENT_LABELS[v.conclusion] : "进行中"}`}
                selected={v.id === detail.verification.id}
                onPress={() => setPicked(i === history.length - 1 ? null : v.id)}
              />
            ))}
          </View>
        </ScrollView>
      ) : null}

      {notice ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{notice}</Text> : null}
      {detail.notes.map((n, i) => (
        <Muted key={i} size={12}>
          注：{n}
        </Muted>
      ))}

      {detail.items.length === 0 ? <Muted size={13}>没有检查项。</Muted> : null}
      {detail.items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          finished={finished}
          evidence={evidenceForItem(item, detail.evidence)}
          api={api}
          onOpen={setViewer}
        />
      ))}

      {loose.length > 0 ? (
        <Field label="其它证据">
          <EvidenceStrip evidence={loose} api={api} onOpen={setViewer} />
        </Field>
      ) : null}

      {decidable ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Btn
              variant="primary"
              icon="Check"
              label="通过"
              disabled={busy}
              onPress={() => act(() => api.verifyApprove({ card: card.id }))}
            />
            <Btn icon="X" label="驳回" disabled={busy} onPress={() => setRejecting(!rejecting)} />
            <Btn
              icon="RefreshCw"
              label="重新验证"
              disabled={busy || !finished}
              onPress={() =>
                act(
                  () => api.verifyRerun({ card: card.id }),
                  () => toast.show("已请求重新验证"),
                )
              }
            />
          </View>
          {rejecting ? (
            <View style={{ gap: 8 }}>
              <TextField
                multiline
                value={comment}
                onChangeText={setComment}
                placeholder="一句驳回意见，会发给执行 agent"
              />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Btn variant="danger" label="提交驳回" disabled={busy || !comment.trim()} onPress={submitReject} />
                <Btn variant="ghost" label="取消" onPress={() => setRejecting(false)} />
              </View>
            </View>
          ) : null}
        </View>
      ) : card.column === "done" ? (
        <Muted size={12}>卡片已通过。</Muted>
      ) : null}

      <Viewer evidence={viewer} api={api} onClose={() => setViewer(null)} />
    </View>
  );
}

function ItemRow({
  item,
  finished,
  evidence,
  api,
  onOpen,
}: {
  item: VerificationItem;
  finished: boolean;
  evidence: EvidenceFile[];
  api: BoardApi;
  onOpen: (e: EvidenceFile) => void;
}) {
  const { theme } = useHost();
  const tone = useTone();
  const j = judgementOf(item, finished);
  const attention = needsAttention(item, finished);
  return (
    <View
      style={{
        gap: 6,
        padding: 10,
        borderRadius: 8,
        borderWidth: attention ? 2 : 1,
        borderColor: attention ? tone(j) : theme.colors.border,
        backgroundColor: attention ? theme.colors.surface2 : theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: tone(j) }}>
          <Text style={{ color: theme.colors.surface0, fontSize: 11, fontWeight: "700" }}>
            {j === "pending" ? "待判" : JUDGEMENT_LABELS[j]}
          </Text>
        </View>
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 14 }}>{item.checkText}</Text>
      </View>
      {item.method ? <Muted size={11}>方法：{item.method}</Muted> : null}
      {item.note ? <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{item.note}</Text> : null}
      {evidence.length > 0 ? <EvidenceStrip evidence={evidence} api={api} onOpen={onOpen} /> : null}
    </View>
  );
}

function EvidenceStrip({
  evidence,
  api,
  onOpen,
}: {
  evidence: EvidenceFile[];
  api: BoardApi;
  onOpen: (e: EvidenceFile) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {evidence.map((e) => (
        <EvidenceTile key={e.id} evidence={e} api={api} onOpen={onOpen} />
      ))}
    </View>
  );
}

/** Thumbnail (fetched lazily when the tile mounts; the original loads only in the viewer). */
function EvidenceTile({
  evidence,
  api,
  onOpen,
}: {
  evidence: EvidenceFile;
  api: BoardApi;
  onOpen: (e: EvidenceFile) => void;
}) {
  const { theme } = useHost();
  const kind = previewKind(evidence);
  const visual = kind === "image" || kind === "gif";
  const thumb = useQuery({
    queryKey: queryKey("evidence", evidence.id, "thumb"),
    queryFn: () => api.verifyEvidence({ evidenceId: evidence.id, thumb: true }),
    enabled: visual,
    staleTime: Infinity,
    retry: false,
  });
  const uri = thumb.data ? dataUri(thumb.data.mimeType, thumb.data.base64) : null;
  const iconName = kind === "video" ? "Video" : kind === "text" ? "FileText" : "File";
  return (
    <View style={{ width: THUMB_W, gap: 3 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`查看证据 ${fileName(evidence.path)}`}
        onPress={() => onOpen(evidence)}
        style={{
          width: THUMB_W,
          height: THUMB_H,
          borderRadius: 8,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: evidence.simulated ? theme.colors.statusWarning : theme.colors.border,
          backgroundColor: theme.colors.surface2,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {visual && uri ? (
          <Image source={{ uri }} style={{ width: THUMB_W, height: THUMB_H }} resizeMode="contain" />
        ) : (
          <View style={{ alignItems: "center", gap: 6, padding: 6 }}>
            <Icon name={visual && thumb.error ? "ImageOff" : iconName} size={24} color={theme.colors.foregroundMuted} />
            <Muted size={11}>{visual ? (thumb.error ? "文件已不存在" : "加载中…") : fileName(evidence.path)}</Muted>
          </View>
        )}
      </Pressable>
      <Muted size={11}>{EVIDENCE_KIND_LABELS[evidence.kind]}</Muted>
      <Muted size={10}>{provenance(evidence)}</Muted>
    </View>
  );
}

/** Enlarged evidence: the original image/GIF, a text excerpt, or the host path for videos. */
function Viewer({
  evidence,
  api,
  onClose,
}: {
  evidence: EvidenceFile | null;
  api: BoardApi;
  onClose: () => void;
}) {
  // Modal content renders in a host portal, outside our context tree: bridge the host value.
  const host = useHost();
  if (!evidence) return null;
  return (
    <Modal title={fileName(evidence.path)} open onOpenChange={(o) => !o && onClose()}>
      <Modal.Content>
        <HostProvider value={host}>
          <ViewerBody evidence={evidence} api={api} />
        </HostProvider>
      </Modal.Content>
    </Modal>
  );
}

function ViewerBody({ evidence, api }: { evidence: EvidenceFile; api: BoardApi }) {
  const { theme } = useHost();
  const { height } = useWindowDimensions();
  const kind = previewKind(evidence);
  const full = useQuery({
    queryKey: queryKey("evidence", evidence.id, "full"),
    queryFn: () => api.verifyEvidence({ evidenceId: evidence.id }),
    enabled: kind !== "video",
    staleTime: Infinity,
    retry: false,
  });
  const imageHeight = Math.max(240, Math.round(height * 0.6));
  return (
    <View style={{ gap: 10 }}>
      {full.data && (kind === "image" || kind === "gif") ? (
        <Image
          source={{ uri: dataUri(full.data.mimeType, full.data.base64) }}
          style={{ width: "100%", height: imageHeight, backgroundColor: theme.colors.surface2 }}
          resizeMode="contain"
        />
      ) : null}
      {full.data && kind === "text" ? <TextExcerpt base64={full.data.base64} /> : null}
      {full.isLoading ? <Muted size={13}>加载中…</Muted> : null}
      {full.error ? <Muted size={13}>{errorMessage(full.error)}</Muted> : null}
      {kind === "video" ? <Muted size={13}>录屏文件较大，不经 RPC 传输。请在运行 daemon 的主机上打开：</Muted> : null}
      {kind === "video" || full.error ? <Muted size={12}>{evidence.path}</Muted> : null}
      <Muted size={12}>
        {EVIDENCE_KIND_LABELS[evidence.kind]} · {provenance(evidence)}
      </Muted>
    </View>
  );
}

function TextExcerpt({ base64 }: { base64: string }) {
  const { theme } = useHost();
  const { text, truncated } = textExcerpt(base64);
  return (
    <View style={{ gap: 4 }}>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}>
        {text}
      </Text>
      {truncated ? <Muted size={11}>（仅显示开头部分）</Muted> : null}
    </View>
  );
}
