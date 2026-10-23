import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import React, { useState, useMemo, useCallback } from "react";
import { Image, Pressable, Text, View, type TextStyle } from "react-native";
import {
  taskVerifyGetRpc,
  taskVerifySummarySchema,
  type taskVerificationDetailSchema,
} from "../shared/task-rpc";
import { verifyEvidenceRpc } from "../shared/rpc";
import type { EvidenceFile } from "../shared/vibe/contract";
import type { z } from "zod";
const layout = { padding: 12, gap: 8 };
const section = { gap: 6 };
const imageStyle = { width: "100%" as const, height: 260 };
function EvidenceRow({
  file,
  onOpen,
  color,
}: {
  file: EvidenceFile;
  onOpen: (id: string) => Promise<void>;
  color: TextStyle;
}) {
  const open = useCallback(() => void onOpen(file.id), [file.id, onOpen]);
  return (
    <Pressable accessibilityRole="button" onPress={open}>
      <Text style={color}>
        {file.kind} · {file.path.split(/[\\/]/).at(-1)}
      </Text>
    </Pressable>
  );
}
export function TaskVerifySummary({
  item,
  theme,
}: PluginTimelineItemProps<z.infer<typeof taskVerifySummarySchema>>) {
  const get = useRpc(taskVerifyGetRpc);
  const evidence = useRpc(verifyEvidenceRpc);
  const [detail, setDetail] = useState<z.infer<typeof taskVerificationDetailSchema> | null>(null);
  const [error, setError] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const color = useMemo(() => ({ color: theme.colors.foreground }), [theme.colors.foreground]);
  const imageSource = useMemo(() => (image ? { uri: image } : undefined), [image]);
  const toggle = useCallback(async () => {
    setError("");
    if (detail) {
      setDetail(null);
      return;
    }
    try {
      const result = await get({
        workspaceId: item.data.workspaceId,
        verificationId: item.data.verificationId,
      });
      setDetail(result.detail);
      if (!result.detail) setError("尚无验证报告");
    } catch (failure) {
      setError(String(failure));
    }
  }, [detail, get, item.data.workspaceId, item.data.verificationId]);
  const openEvidence = useCallback(
    async (id: string) => {
      setError("");
      try {
        const result = await evidence({ evidenceId: id });
        if (result.mimeType.startsWith("image/")) {
          setImage("data:" + result.mimeType + ";base64," + result.base64);
          setText(null);
          return;
        }
        if (result.mimeType.startsWith("text/") || result.mimeType === "application/json") {
          setText(decodeURIComponent(escape(atob(result.base64))));
          setImage(null);
          return;
        }
        setError("此证据请在主机查看：" + result.evidence.path);
      } catch (failure) {
        setError(String(failure));
      }
    },
    [evidence],
  );
  return (
    <View style={layout}>
      <Text style={color}>{item.data.text}</Text>
      {item.data.verificationId ? (
        <Pressable accessibilityRole="button" onPress={toggle}>
          <Text style={color}>{detail ? "收起验证报告" : "查看验证报告与证据"}</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={color}>{error}</Text> : null}
      {detail ? (
        <View style={section}>
          <Text style={color}>提交：{detail.verification.commitHash}</Text>
          {detail.items.map((check) => (
            <Text key={check.id} style={color}>
              {check.judgement ?? "存疑"} · {check.checkText}：{check.note}
            </Text>
          ))}
          {detail.notes.map((note) => (
            <Text key={note} style={color}>
              {note}
            </Text>
          ))}
          {detail.evidence.map((file) => (
            <EvidenceRow key={file.id} file={file} onOpen={openEvidence} color={color} />
          ))}
        </View>
      ) : null}
      {imageSource ? <Image source={imageSource} resizeMode="contain" style={imageStyle} /> : null}
      {text ? (
        <Text selectable style={color}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}
