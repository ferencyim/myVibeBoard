import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { NavigationRow } from "@/components/ui/navigation-row";
import { EditingTextInput } from "@/components/ui/text-input";
import { flushProjectDocuments } from "@/runtime/project-documents";
import type { BriefDocumentEdit, DocumentSnapshot } from "./document-cache";
import {
  buildProjectDocumentRoute,
  buildProjectDocumentBackRoute,
  projectDocumentEntries,
  type ProjectDocumentPage,
} from "./document-navigation";
import { useProjectDocuments } from "./use-project-documents";

type Document = DocumentSnapshot["documents"][number];
type BriefPath = BriefDocumentEdit["path"];

export function ProjectDocumentsPage({
  serverId,
  projectId,
  page,
  path,
}: {
  serverId: string;
  projectId: string;
  page: ProjectDocumentPage;
  path?: string;
}) {
  const router = useRouter();
  const documents = useProjectDocuments(serverId, projectId);
  const { state, loaded, error, connected } = documents;
  const entries = projectDocumentEntries(state, connected);
  const back = useCallback(() => {
    router.dismissTo(buildProjectDocumentBackRoute(serverId, projectId, path));
  }, [router, serverId, projectId, path]);
  const selected = state.documents.find((doc) => doc.path === path);
  return (
    <View>
      <View style={styles.stack}>
        <Button variant="ghost" onPress={back} style={styles.backButton}>
          {path ? "返回项目文档" : "返回项目设置"}
        </Button>
        <Text style={styles.title}>{page === "brief" ? "项目简介" : (path ?? "项目文档")}</Text>
        <Text style={styles.muted}>
          {entries.syncStatus}
          {!connected ? "；离线编辑将保存在本机，联网后交给项目 agent 合并。" : ""}
        </Text>
        {!loaded ? <Text style={styles.muted}>正在读取本机缓存…</Text> : null}
        {error || state.syncError ? (
          <Text style={styles.error}>{error ?? state.syncError}</Text>
        ) : null}
        {page === "brief" && loaded ? <BriefPage documents={documents} /> : null}
        {page === "documents" &&
          !path &&
          (state.documents.length ? (
            state.documents.map((doc) => (
              <DocumentEntry key={doc.path} doc={doc} serverId={serverId} projectId={projectId} />
            ))
          ) : (
            <Text style={styles.muted}>尚无项目文档缓存；联网后自动同步。</Text>
          ))}
        {page === "documents" &&
          path &&
          (selected ? (
            <DocumentReader doc={selected} />
          ) : (
            <Text style={styles.muted}>尚无此文档的缓存。</Text>
          ))}
      </View>
    </View>
  );
}

function BriefPage({ documents }: { documents: ReturnType<typeof useProjectDocuments> }) {
  const [source, setSource] = useState<BriefPath>(() =>
    documents.state.documents.some((doc) => doc.path === "AGENTS.md") ? "AGENTS.md" : "CLAUDE.md",
  );
  const [drafts, setDrafts] = useState<Partial<Record<BriefPath, BriefDocumentEdit | null>>>({});
  const changeDraft = useCallback(
    (edit: BriefDocumentEdit | null) => setDrafts((current) => ({ ...current, [source]: edit })),
    [source],
  );
  const agents = useCallback(() => setSource("AGENTS.md"), []);
  const claude = useCallback(() => setSource("CLAUDE.md"), []);
  return (
    <View style={styles.stack}>
      <View style={styles.actions}>
        <Button variant={source === "AGENTS.md" ? "secondary" : "ghost"} onPress={agents}>
          AGENTS.md
        </Button>
        <Button variant={source === "CLAUDE.md" ? "secondary" : "ghost"} onPress={claude}>
          CLAUDE.md
        </Button>
      </View>
      <BriefEditor
        key={source}
        source={source}
        documents={documents}
        edit={drafts[source] ?? null}
        setEdit={changeDraft}
      />
    </View>
  );
}

function BriefEditor({
  source,
  documents,
  edit,
  setEdit,
}: {
  source: BriefPath;
  documents: ReturnType<typeof useProjectDocuments>;
  edit: BriefDocumentEdit | null;
  setEdit(edit: BriefDocumentEdit | null): void;
}) {
  const { state, cache, setError } = documents;
  const doc = state.documents.find((item) => item.path === source);
  const local = [...state.pending, ...state.outbox]
    .flatMap((change) => change.documents)
    .findLast((item) => item.path === source);
  const [preview, setPreview] = useState(!edit);
  const [saving, setSaving] = useState(false);
  const start = useCallback(() => {
    setEdit({
      path: source,
      content: local?.content ?? doc?.content ?? "",
      baseRevision: doc?.revision ?? "",
    });
    setPreview(false);
  }, [source, local?.content, doc?.content, doc?.revision, setEdit]);
  const change = useCallback(
    (content: string) => setEdit(edit ? { ...edit, content } : null),
    [edit, setEdit],
  );
  const togglePreview = useCallback(() => setPreview((current) => !current), []);
  const save = useCallback(async () => {
    if (!edit || saving) return;
    setSaving(true);
    setError(null);
    try {
      await cache.queue({
        id: `brief-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        documents: [edit],
        createdAt: new Date().toISOString(),
      });
      setEdit(null);
      setPreview(true);
      await flushProjectDocuments();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [cache, edit, saving, setError, setEdit]);
  return (
    <View style={styles.stack}>
      <Text style={styles.text}>
        来源文件：{source}
        {local ? " · 有待合并修改" : ""}
      </Text>
      {doc ? (
        <DocumentSyncInfo doc={doc} />
      ) : (
        <Text style={styles.muted}>尚无此文件的同步快照。</Text>
      )}
      <View style={styles.actions}>
        {!edit ? (
          <Button variant="secondary" disabled={doc?.truncated} onPress={start}>
            编辑 Markdown
          </Button>
        ) : (
          <>
            <Button variant="secondary" onPress={togglePreview}>
              {preview ? "编辑 Markdown" : "预览 Markdown"}
            </Button>
            <Button disabled={saving} loading={saving} onPress={save}>
              保存为待合并修改
            </Button>
          </>
        )}
      </View>
      {edit && !preview ? (
        <EditingTextInput
          multiline
          initialValue={edit.content}
          onChangeText={change}
          style={styles.input}
          accessibilityLabel={`项目简介 ${source}`}
        />
      ) : (
        <MarkdownRenderer
          text={edit?.content ?? local?.content ?? doc?.content ?? "（文件为空）"}
        />
      )}
    </View>
  );
}

function DocumentEntry({
  doc,
  serverId,
  projectId,
}: {
  doc: Document;
  serverId: string;
  projectId: string;
}) {
  const router = useRouter();
  const open = useCallback(
    () => router.push(buildProjectDocumentRoute(serverId, projectId, "documents", doc.path)),
    [router, serverId, projectId, doc.path],
  );
  return (
    <NavigationRow
      title={doc.path}
      description={`上次同步 ${new Date(doc.syncedAt).toLocaleString()}${doc.truncated ? " · 部分缓存" : ""}`}
      onPress={open}
    />
  );
}
function DocumentSyncInfo({ doc }: { doc: Document }) {
  return (
    <Text style={styles.muted}>
      上次同步 {new Date(doc.syncedAt).toLocaleString()}
      {doc.truncated ? ` · 仅缓存前 64 KiB（原文件 ${doc.totalBytes} 字节）` : ""}
    </Text>
  );
}
function DocumentReader({ doc }: { doc: Document }) {
  return (
    <View style={styles.stack}>
      <Text style={styles.text}>{doc.path} · 只读</Text>
      <DocumentSyncInfo doc={doc} />
      <MarkdownRenderer text={doc.content || "（文件为空）"} />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    lineHeight: theme.lineHeight.xl,
    fontWeight: theme.fontWeight.semibold,
  },
  backButton: { alignSelf: "flex-start", paddingHorizontal: 0 },
  stack: { gap: theme.spacing[3] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  input: {
    minHeight: 400,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    textAlignVertical: "top",
  },
}));
