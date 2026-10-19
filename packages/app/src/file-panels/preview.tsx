import type { ComponentProps } from "react";
import type { ExplorerFile } from "@/stores/session-store";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { FilePanel } from "./index";
import { BuiltinFilePanelPreview } from "./builtin";
import { PluginFilePanelHost } from "./plugin-host";
import { bytesDocument, textDocument } from "./document";

export function FilePanelPreview(
  props: Omit<ComponentProps<typeof BuiltinFilePanelPreview>, "panel"> & {
    panel: FilePanel;
    preview: ExplorerFile;
    location: WorkspaceFileLocation;
    navigationRevision: number;
    setText?: (text: string) => void;
  },
) {
  const { panel, preview } = props;
  if (!("plugin" in panel)) return <BuiltinFilePanelPreview {...props} panel={panel} />;
  let document;
  if (panel.document === "text") document = textDocument(props.content, props.setText);
  else if (preview.bytes && props.documentPreviewUri)
    document = bytesDocument(preview.bytes, props.documentPreviewUri);
  if (!document) return null;
  return (
    <PluginFilePanelHost
      workspaceRoot={props.workspaceRoot}
      panel={panel}
      preview={preview}
      location={props.location}
      navigationRevision={props.navigationRevision}
      document={document}
    />
  );
}
