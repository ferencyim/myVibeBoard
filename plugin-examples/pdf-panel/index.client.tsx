import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PdfPanel } from "./client/pdf-panel";

export default function contribute(client: PluginClientContext) {
  client.addFilePanel({
    id: "pdf",
    title: "PDF",
    icon: "FileText",
    files: { extensions: ["pdf"] },
    document: "bytes",
    maxBytes: 50 * 1024 * 1024,
    Component: PdfPanel,
  });
  return () => {};
}
