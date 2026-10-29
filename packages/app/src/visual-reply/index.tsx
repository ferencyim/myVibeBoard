import React, { useCallback, useEffect, useState } from "react";
import { Modal, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { PluginTheme } from "@getpaseo/plugin";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { Button } from "@/ui/button";
import { VisualReplyFrame } from "./frame";

export function VisualReply({
  serverId,
  agentId,
  data,
  theme,
}: {
  serverId: string;
  agentId: string;
  data: unknown;
  theme: PluginTheme;
}) {
  const client = useHostRuntimeClient(serverId);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [full, setFull] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const dimensions = useWindowDimensions();
  const value = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : "";
  const title = typeof value.title === "string" ? value.title : "可视化回复";
  const height =
    typeof value.height === "number" && Number.isInteger(value.height)
      ? Math.min(2000, Math.max(80, value.height))
      : 240;
  useEffect(() => {
    let active = true;
    setHtml(null);
    setFailed(false);
    if (!client || !attachmentId) {
      setFailed(true);
      return;
    }
    void client.invokePluginRpc("vibe-bots", "visual.read", { attachmentId }).then(
      (result) => {
        if (!active) return null;
        if (
          result &&
          typeof result === "object" &&
          "html" in result &&
          typeof result.html === "string"
        )
          setHtml(result.html);
        else setFailed(true);
        return null;
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client, attachmentId]);
  const open = useCallback(() => setFull(true), []);
  const close = useCallback(() => setFull(false), []);
  const applyDraft = useCallback(() => {
    if (draft !== null) {
      useDraftStore
        .getState()
        .editDraftText({ draftKey: buildDraftStoreKey({ serverId, agentId }), text: draft });
      setDraft(null);
    }
  }, [draft, serverId, agentId]);
  const content =
    html === null ? (
      <Text style={styles.text}>{failed ? "加载失败" : "正在加载…"}</Text>
    ) : (
      <VisualReplyFrame
        html={html}
        height={full ? Math.max(80, dimensions.height - 100) : height}
        onDraft={setDraft}
        theme={theme}
      />
    );
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.text}>{title}</Text>
        <Button onPress={open}>全屏查看</Button>
      </View>
      {content}
      {draft !== null ? <Button onPress={applyDraft}>填入草稿</Button> : null}
      <Modal visible={full} onRequestClose={close}>
        <View style={styles.full}>
          <Button onPress={close}>关闭</Button>
          {content}
        </View>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  header: { padding: theme.spacing[2], flexDirection: "row", justifyContent: "space-between" },
  text: { color: theme.colors.foreground },
  link: { color: theme.colors.accent },
  full: { flex: 1, backgroundColor: theme.colors.surface1, padding: theme.spacing[3] },
}));
