// "需求文档" section of the project edit panel: view (read-only) / edit / save-and-commit.

import * as hostUi from "@getpaseo/plugin/client/react-native";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { errorMessage } from "../board/logic";
import { queryKey, type BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { Btn, Field, Muted, TextField } from "../common/ui";
import { requirementsSaveMessage } from "./logic";

// Hosts older than v0.12.1 have no Markdown component; the document then shows as monospace text.
const HostMarkdown = (hostUi as { Markdown?: React.ComponentType<{ text: string }> }).Markdown;

export function RequirementsPanel({ api, projectId }: { api: BoardApi; projectId: string }) {
  const { theme } = useHost();
  const toast = useToast();
  const doc = useQuery({
    queryKey: queryKey("requirements", projectId),
    queryFn: () => api.requirementsGet({ project: projectId }),
    retry: false,
    staleTime: 30_000,
  });
  const [draft, setDraft] = useState<string | null>(null); // null = viewing
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    try {
      const saved = await api.requirementsSave({ project: projectId, content: draft });
      setResult(requirementsSaveMessage(saved));
      setDraft(null);
      await doc.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label={`需求文档${doc.data ? `（${doc.data.path}）` : ""}`}>
      {doc.isLoading ? <Muted>读取中…</Muted> : null}
      {doc.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{errorMessage(doc.error)}</Text> : null}
      {doc.data && !doc.data.exists && draft === null ? <Muted>尚未创建，保存后会新建并提交</Muted> : null}
      {draft !== null ? (
        <TextField
          multiline
          autoCapitalize="none"
          value={draft}
          onChangeText={setDraft}
          style={{ minHeight: 240, fontFamily: "monospace", fontSize: 12 }}
        />
      ) : doc.data?.exists ? (
        <View style={{ padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface1, maxHeight: 280, overflow: "hidden" }}>
          {HostMarkdown && doc.data.content ? (
            <HostMarkdown text={doc.data.content} />
          ) : (
            <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12 }}>
              {doc.data.content || "（空文件）"}
            </Text>
          )}
        </View>
      ) : null}
      {result ? <Muted>{result}</Muted> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {draft === null ? (
          <Btn small label="编辑" disabled={!doc.data} onPress={() => { setResult(null); setDraft(doc.data?.content ?? ""); }} />
        ) : (
          <>
            <Btn small variant="primary" label={busy ? "保存中…" : "保存并提交"} disabled={busy} onPress={save} />
            <Btn small label="取消" disabled={busy} onPress={() => setDraft(null)} />
          </>
        )}
      </View>
    </Field>
  );
}
