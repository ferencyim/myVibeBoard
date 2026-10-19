import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { DocumentFrame } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";

const fallbackStyle = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
} as const;

export function PdfPanel({ document, file, theme, layout }: PluginFilePanelProps) {
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  if (document.kind !== "bytes") return null;
  if (layout.platform === "android") {
    return (
      <View style={fallbackStyle}>
        <Text style={textStyle}>
          {file.name} ({Math.round(file.size / 1024)} KB). Android cannot render PDF inline.
        </Text>
      </View>
    );
  }
  return <DocumentFrame url={document.url} testID="pdf-panel" />;
}
