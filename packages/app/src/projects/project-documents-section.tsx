import {
  getProjectDocumentCache,
  loadProjectDocumentCache,
  flushProjectDocuments,
} from "@/runtime/project-documents";
import { useCallback, useEffect, useMemo, useSyncExternalStore, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { type BriefDocumentEdit, type DocumentSnapshot } from "./document-cache";
// The host owns offline storage and this surface so a cold start never executes cached plugin code.
// The trusted vibe-board plugin owns daemon snapshots and merge delivery over the existing RPC channel.
export function ProjectDocumentsSection({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string;
}) {
  const cache = useMemo(() => getProjectDocumentCache(serverId, projectId), [serverId, projectId]);
  const state = useSyncExternalStore(cache.subscribe, cache.getSnapshot, cache.getSnapshot);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BriefDocumentEdit | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const client = useHostRuntimeClient(serverId);
  const host = useHostRuntimeSnapshot(serverId);
  const connected = host?.connectionStatus === "online";
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void loadProjectDocumentCache(cache).then(
      () => {
        if (alive) setLoaded(true);
        return undefined;
      },
      (e) => {
        if (alive) {
          setError(String(e));
          setLoaded(true);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [cache]);
  useEffect(() => {
    if (loaded && connected && client)
      void flushProjectDocuments().catch((e) => setError(String(e)));
  }, [loaded, connected, client]);
  const save = useCallback(async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      await cache.queue({
        id: "brief-" + Date.now() + "-" + Math.random().toString(36).slice(2),
        documents: [editing],
        createdAt: new Date().toISOString(),
      });
      setEditing(null);
      await flushProjectDocuments();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [cache, editing, saving]);
  const changeText = useCallback(
    (content: string) => setEditing((current) => (current ? { ...current, content } : null)),
    [],
  );
  const cancelEdit = useCallback(() => setEditing(null), []);
  const pendingCount = state.pending.length + state.outbox.length;
  return (
    <View style={styles.stack}>
      <SettingsSection title="项目简介">
        <Text style={styles.muted}>
          {pendingCount
            ? "待合并的简介修改：" + pendingCount + "。联网后由项目 agent 合并写回文件。"
            : "仓库 AGENTS.md 与 CLAUDE.md 是项目简介的真相源。"}
        </Text>
        {!connected ? (
          <Text style={styles.muted}>离线缓存；编辑将保存在本机，联网后交给项目 agent。</Text>
        ) : null}
        {!loaded ? <Text style={styles.muted}>正在读取本机缓存…</Text> : null}
        {error || state.syncError ? (
          <Text style={styles.muted}>{error ?? state.syncError}</Text>
        ) : null}
        {(["AGENTS.md", "CLAUDE.md"] as const).map((file) => (
          <BriefFile key={file} file={file} state={state} loaded={loaded} onEdit={setEditing} />
        ))}
        {editing ? (
          <View style={styles.stack}>
            <Text style={styles.label}>编辑 {editing.path}</Text>
            <EditingTextInput
              multiline
              key={editing.path}
              initialValue={editing.content}
              onChangeText={changeText}
              style={styles.input}
              accessibilityLabel={"项目简介 " + editing.path}
            />
            <Button size="sm" disabled={saving} onPress={save}>
              保存为待合并修改
            </Button>
            <Button variant="secondary" size="sm" disabled={saving} onPress={cancelEdit}>
              取消
            </Button>
          </View>
        ) : null}
      </SettingsSection>
      <SettingsSection title="项目文档">
        {!state.documents.length ? (
          <Text style={styles.muted}>尚无项目文档缓存；联网后自动同步。</Text>
        ) : null}
        {state.documents.map((doc) => (
          <DocumentButton key={doc.path} doc={doc} selected={selected} onSelect={setSelected} />
        ))}
        {selected
          ? state.documents
              .filter((d) => d.path === selected)
              .map((doc) => (
                <View key={doc.path} style={styles.stack}>
                  <Text style={styles.label}>{doc.path} · 只读</Text>
                  {doc.truncated ? (
                    <Text style={styles.muted}>
                      仅缓存前 64 KB；原文件共 {doc.totalBytes} 字节。
                    </Text>
                  ) : null}
                  <MarkdownRenderer text={doc.content || "（文件为空）"} />
                </View>
              ))
          : null}
      </SettingsSection>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  stack: { gap: 12 },
  label: { color: theme.colors.foreground, fontWeight: "600" },
  muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
  input: {
    minHeight: 180,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    padding: 12,
    borderRadius: 8,
  },
}));

function DocumentButton({
  doc,
  selected,
  onSelect,
}: {
  doc: DocumentSnapshot["documents"][number];
  selected: string | null;
  onSelect: (path: string | null) => void;
}) {
  const select = useCallback(
    () => onSelect(selected === doc.path ? null : doc.path),
    [doc.path, selected, onSelect],
  );
  return (
    <Button variant="ghost" size="sm" onPress={select}>
      {doc.path}
      {doc.truncated ? "（部分缓存）" : ""}
    </Button>
  );
}
function BriefFile({
  file,
  state,
  loaded,
  onEdit,
}: {
  file: "AGENTS.md" | "CLAUDE.md";
  state: DocumentSnapshot & { outbox: { documents: BriefDocumentEdit[] }[] };
  loaded: boolean;
  onEdit: (edit: BriefDocumentEdit) => void;
}) {
  const doc = state.documents.find((d) => d.path === file);
  const local = [...state.pending, ...state.outbox]
    .flatMap((c) => c.documents)
    .findLast((d) => d.path === file);
  const edit = useCallback(
    () =>
      onEdit({
        path: file,
        content: local?.content ?? doc?.content ?? "",
        baseRevision: doc?.revision ?? "",
      }),
    [file, local?.content, doc?.content, doc?.revision, onEdit],
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.label}>{file}</Text>
      {doc ? (
        <>
          <Text style={styles.muted}>
            同步于 {new Date(doc.syncedAt).toLocaleString()}
            {doc.truncated ? " · 仅缓存前 64 KB（文件共 " + doc.totalBytes + " 字节）" : ""}
          </Text>
          <MarkdownRenderer text={doc.content || "（文件为空）"} />
        </>
      ) : (
        <Text style={styles.muted}>尚无此文件的同步快照。</Text>
      )}
      {local ? <Text style={styles.muted}>此文件有待合并修改。</Text> : null}
      <Button variant="secondary" size="sm" disabled={!loaded || doc?.truncated} onPress={edit}>
        编辑 {file}
      </Button>
    </View>
  );
}
