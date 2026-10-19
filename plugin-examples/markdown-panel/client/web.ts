import type { PluginFilePanelProps, PluginTextDocument } from "@getpaseo/plugin/client";
import type { EditorView, EditorViewConfig } from "@codemirror/view";
import { Platform } from "react-native";

/** DOM code stays here; native never evaluates the editor dependencies. */
export function mountEditor(
  parent: unknown,
  document: PluginTextDocument,
  theme: PluginFilePanelProps["theme"],
  onChange: (text: string) => void,
) {
  if (Platform.OS !== "web" || !parent) return null;
  const { EditorState } = require("@codemirror/state") as typeof import("@codemirror/state");
  const { EditorView, keymap, lineNumbers } =
    require("@codemirror/view") as typeof import("@codemirror/view");
  const { defaultKeymap, history, historyKeymap } =
    require("@codemirror/commands") as typeof import("@codemirror/commands");
  const { markdown } =
    require("@codemirror/lang-markdown") as typeof import("@codemirror/lang-markdown");
  const { syntaxHighlighting, defaultHighlightStyle } =
    require("@codemirror/language") as typeof import("@codemirror/language");
  let applyingHostText = false;
  const view: EditorView = new EditorView({
    parent: parent as EditorViewConfig["parent"],
    state: EditorState.create({
      doc: document.text,
      extensions: [
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorState.readOnly.of(!document.editable),
        EditorView.editable.of(document.editable),
        EditorView.contentAttributes.of({ "aria-label": "Rich Markdown editor" }),
        EditorView.theme({
          "&": {
            height: "100%",
            color: theme.colors.foreground,
            backgroundColor: theme.colors.surface0,
          },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { padding: "16px", caretColor: theme.colors.foreground },
          ".cm-gutters": {
            backgroundColor: theme.colors.surface0,
            color: theme.colors.foregroundMuted,
            border: "none",
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingHostText) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    setText(text: string) {
      if (view.state.doc.toString() === text) return;
      applyingHostText = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      } finally {
        applyingHostText = false;
      }
    },
    destroy() {
      view.destroy();
    },
  };
}
