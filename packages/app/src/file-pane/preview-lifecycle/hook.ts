import { useEffect, useState, useSyncExternalStore } from "react";
import { resolveFilePreviewPanel, type FilePanel } from "@/file-panels";
import type { LiveFileSnapshot } from "../live-file/model";
import {
  createFilePanePreview,
  FilePreviewLifecycleModel,
  type FilePreviewLifecycleSnapshot,
} from "./model";

/** Bridges the raw-file owner to the preview preparation owner. */
export function useFilePreview(input: {
  targetKey: string | null;
  liveFileSnapshot: LiveFileSnapshot;
  path: string;
  candidates: readonly FilePanel[];
  associations: Readonly<Record<string, string>>;
}): FilePreviewLifecycleSnapshot {
  const [model] = useState(() => new FilePreviewLifecycleModel(createFilePanePreview));
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const { targetKey, liveFileSnapshot } = input;
  const panel = resolveFilePreviewPanel({
    file:
      liveFileSnapshot.observation?.status === "ready" ? liveFileSnapshot.observation.file : null,
    path: input.path,
    candidates: input.candidates,
    associations: input.associations,
  });

  useEffect(() => {
    model.setSource({ targetKey, liveFileSnapshot, panel });
  }, [liveFileSnapshot, model, targetKey, panel]);

  return snapshot;
}
