import { usePaseo, useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, ScrollView, Text, View, type TextStyle } from "react-native";
import { verifyEvidenceRpc } from "../../shared/rpc/verify";
import { taskConversationPanelRpc } from "../../shared/task-conversation";
import { dataUri, textExcerpt } from "../verification/logic";
import { findReportEvidence, type ReportSummary as ReportSummaryData } from "./report-summary";

export function ReportSummary({
  item,
  agentId,
  theme,
  layout,
}: PluginTimelineItemProps<ReportSummaryData>) {
  const report = item.data;
  const paseo = usePaseo();
  const readPanel = useRpc(taskConversationPanelRpc);
  const readEvidence = useRpc(verifyEvidenceRpc);
  const [expanded, setExpanded] = useState(false);
  const [evidenceName, setEvidenceName] = useState<string | null>(null);
  const evidence = useMutation({
    mutationFn: async (name: string) => {
      const evidenceId = await findReportEvidence({
        paseo,
        conversationId: agentId,
        messageId: report.messageId,
        name,
        readArtifacts: async (workspaceId) =>
          (await readPanel({ workspaceId, conversationId: agentId })).artifacts,
      });
      return readEvidence({ evidenceId });
    },
    retry: false,
  });
  const styles = useMemo(() => {
    const text = { color: theme.colors.foreground, fontSize: 14 };
    return {
      text,
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      link: { color: theme.colors.accent, fontSize: 13 },
      heading: { ...text, fontWeight: "600" as const },
      code: { ...text, fontFamily: "monospace" },
      error: { color: theme.colors.statusDanger },
      root: { padding: layout.compact ? 12 : 16, gap: 10 },
      check: { gap: 5, paddingTop: 4 },
      scroll: { maxHeight: 600 },
      content: { gap: 10 },
      image: { width: "100%" as const, height: 380 },
    };
  }, [theme, layout.compact]);
  const { mutate } = evidence;
  const openEvidence = useCallback(
    (name: string) => {
      setEvidenceName(name);
      mutate(name);
    },
    [mutate],
  );
  const toggleDetails = useCallback(() => setExpanded((value) => !value), []);
  const modalChange = useCallback((open: boolean) => {
    if (!open) setEvidenceName(null);
  }, []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const file = evidence.data;
  const imageSource = useMemo(
    () => ({ uri: file ? dataUri(file.mimeType, file.base64) : "" }),
    [file],
  );
  let preview: ReactNode = null;
  if (file?.mimeType.startsWith("image/"))
    preview = <Image source={imageSource} style={styles.image} resizeMode="contain" />;
  else if (file && (file.mimeType.startsWith("text/") || file.mimeType === "application/json"))
    preview = (
      <Text selectable style={styles.code}>
        {textExcerpt(file.base64, 32000).text}
      </Text>
    );
  else if (file) preview = <Text style={styles.muted}>请在守护进程所在主机打开此文件。</Text>;
  return (
    <View style={styles.root} testID="task-report-summary">
      <Text style={styles.heading}>
        {report.title}：{report.conclusion}
      </Text>
      {report.summary ? (
        <Text selectable style={styles.text}>
          {report.summary}
        </Text>
      ) : null}
      {report.checks.length === 0 ? (
        <Text style={styles.muted}>未列出具体问题或检查项。</Text>
      ) : null}
      {report.checks.map((check) => (
        <View key={check.label} style={styles.check}>
          <Text style={styles.heading}>{check.label}</Text>
          {check.note ? (
            <Text selectable style={styles.text}>
              {check.note}
            </Text>
          ) : null}
          {[...new Set(check.evidence)].map((name) => (
            <EvidenceLink key={name} name={name} onOpen={openEvidence} style={styles.link} />
          ))}
        </View>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        onPress={toggleDetails}
      >
        <Text style={styles.link}>{expanded ? "收起详情" : "详情"}</Text>
      </Pressable>
      {expanded ? (
        <Text selectable style={styles.code}>
          {report.rawText}
        </Text>
      ) : null}
      <Modal title={evidenceName ?? "证据"} open={evidenceName !== null} onOpenChange={modalChange}>
        <Modal.Content>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            {evidence.isPending ? <Text style={styles.muted}>正在读取此轮证据…</Text> : null}
            {evidence.error ? (
              <Text selectable style={styles.error}>
                {evidence.error instanceof Error ? evidence.error.message : String(evidence.error)}
              </Text>
            ) : null}
            {file && !evidence.isPending && !evidence.error ? (
              <>
                {preview}
                <Text selectable style={styles.muted}>
                  {file.evidence.path}
                </Text>
                <Text style={styles.muted}>
                  提交：{file.evidence.commitHash ?? "未记录"} · {file.evidence.capturedAt}
                </Text>
              </>
            ) : null}
          </ScrollView>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function EvidenceLink({
  name,
  onOpen,
  style,
}: {
  name: string;
  onOpen(name: string): void;
  style: TextStyle;
}) {
  const open = useCallback(() => onOpen(name), [name, onOpen]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`查看证据 ${name}`} onPress={open}>
      <Text style={style}>证据：{name}</Text>
    </Pressable>
  );
}
