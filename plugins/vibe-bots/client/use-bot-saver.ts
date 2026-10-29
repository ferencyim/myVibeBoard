import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { botsUpdateRpc, type BotViewSchema } from "../shared/rpc";
import type { BotPatch } from "../shared/vibe/contract/bots";
import { applyPatchToList, replaceBotInList } from "./profile-mapping";

export type BotView = z.infer<typeof BotViewSchema>;
export const BOT_LIST_KEY = ["vibe-bots", "list"] as const;
type BotList = { bots: BotView[] };

/**
 * Instant save: every patch is applied to the cached bot list first (the UI updates at once),
 * sent through a serial queue, and rolled back with an error message when the server refuses it.
 * The background refetch waits until the queue is empty so it cannot undo a newer optimistic value.
 */
export function useBotSaver(botId: string) {
  const update = useRpc(botsUpdateRpc);
  const client = useQueryClient();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inflight = useRef(0);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = useCallback((patch: BotPatch): Promise<boolean> => {
    const before = client.getQueryData<BotList>(BOT_LIST_KEY)?.bots.find((bot) => bot.id === botId);
    const previous: Record<string, unknown> = {};
    if (before) for (const key of Object.keys(patch)) previous[key] = (before as Record<string, unknown>)[key];
    client.setQueryData<BotList>(BOT_LIST_KEY, (list) => list && { bots: applyPatchToList(list.bots, botId, patch as Partial<BotView>) });
    setError("");
    inflight.current += 1;
    setPending(inflight.current);
    const run = queue.current.catch(() => undefined).then(async () => {
      try {
        const result = await update({ id: botId, patch });
        if (inflight.current === 1) client.setQueryData<BotList>(BOT_LIST_KEY, (list) => list && { bots: replaceBotInList(list.bots, result.bot) });
        return true;
      } catch (reason) {
        client.setQueryData<BotList>(BOT_LIST_KEY, (list) => list && { bots: applyPatchToList(list.bots, botId, previous as Partial<BotView>) });
        if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
        return false;
      } finally {
        inflight.current -= 1;
        if (mounted.current) setPending(inflight.current);
        if (inflight.current === 0) void client.invalidateQueries({ queryKey: ["vibe-bots"] });
      }
    });
    queue.current = run;
    return run;
  }, [client, update, botId]);
  const clearError = useCallback(() => setError(""), []);
  return { save, pending, error, clearError };
}

/**
 * A text field draft that saves on blur (and, with `debounceMs`, shortly after typing stops).
 * Server changes flow into the draft only while the user is not editing it, and everything
 * unsaved is flushed on unmount.
 */
export function useTextDraft(serverValue: string, save: (value: string) => void, options: { debounceMs?: number; accept?: (value: string) => boolean } = {}) {
  const { debounceMs, accept } = options;
  const [draft, setDraft] = useState(serverValue);
  const draftRef = useRef(serverValue);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ serverValue, save, accept });
  latest.current = { serverValue, save, accept };
  useEffect(() => {
    if (dirty.current) return;
    draftRef.current = serverValue;
    setDraft(serverValue);
  }, [serverValue]);
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = undefined; }
    if (!dirty.current) return;
    const value = draftRef.current;
    const { serverValue: current, save: doSave, accept: ok } = latest.current;
    if (ok && !ok(value)) return;
    dirty.current = false;
    if (value !== current) doSave(value);
  }, []);
  const change = useCallback((value: string) => {
    draftRef.current = value;
    dirty.current = true;
    setDraft(value);
    if (debounceMs) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, debounceMs);
    }
  }, [debounceMs, flush]);
  /** Throws away an invalid draft and shows the saved value again. */
  const reset = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = undefined; }
    dirty.current = false;
    draftRef.current = latest.current.serverValue;
    setDraft(latest.current.serverValue);
  }, []);
  useEffect(() => flush, [flush]);
  return { draft, change, flush, reset };
}
