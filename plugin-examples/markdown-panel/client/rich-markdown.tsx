import type { PluginFilePanelProps, PluginTextDocument } from "@getpaseo/plugin/client";
import { useLayoutEffect, useMemo, useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { mountEditor } from "./web";

interface TextPanelProps {
  document: PluginTextDocument;
  theme: PluginFilePanelProps["theme"];
}

const editorStyle = { flex: 1, minHeight: 0 };

function MarkdownEditor({ document, theme }: TextPanelProps) {
  const parent = useRef<View>(null);
  const editor = useRef<ReturnType<typeof mountEditor>>(null);
  const currentDocument = useRef(document);
  currentDocument.current = document;

  useLayoutEffect(() => {
    editor.current = mountEditor(parent.current, currentDocument.current, theme, (text) => {
      currentDocument.current.setText(text);
    });
    return () => {
      editor.current?.destroy();
      editor.current = null;
    };
  }, [theme, document.editable]);

  useLayoutEffect(() => {
    editor.current?.setText(document.text);
  }, [document.text]);

  return <View ref={parent} style={editorStyle} />;
}

export function RichMarkdownPanel({ document, theme, layout }: PluginFilePanelProps) {
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      text: { color: theme.colors.foreground, padding: 16 },
    }),
    [theme],
  );
  if (document.kind !== "text") return null;
  if (layout.platform === "web") return <MarkdownEditor document={document} theme={theme} />;
  return (
    <ScrollView style={styles.screen}>
      <Text selectable style={styles.text}>
        {document.text}
      </Text>
    </ScrollView>
  );
}
