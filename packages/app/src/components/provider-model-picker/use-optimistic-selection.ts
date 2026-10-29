import { useCallback, useEffect, useMemo, useState } from "react";
import type { PickerThinking } from "@/components/provider-model-picker/picker-panel";

const PENDING_TIMEOUT_MS = 60_000;

interface PendingSelection {
  provider: string;
  model: string;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/**
 * Runs `action`, and calls `onFailure` if it throws or returns a promise that rejects. The picker
 * uses it so the UI can show the new value first and roll back when the request fails.
 */
export function runWithRollback(action: () => unknown, onFailure: () => void): void {
  try {
    const result = action();
    if (isThenable(result)) result.then(undefined, onFailure);
  } catch {
    onFailure();
  }
}

/**
 * Optimistic model / effort selection. The button label follows the user's pick immediately; the
 * overlay is dropped once the parent's value changes, after a timeout, or when the request fails.
 */
export function useOptimisticSelection(input: {
  selectedProvider: string;
  selectedModel: string;
  thinking: PickerThinking | null;
  onSelect: (provider: string, modelId: string) => void | Promise<unknown>;
  onFailure: (message: string) => void;
}) {
  const { selectedProvider, selectedModel, thinking, onSelect, onFailure } = input;
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [pendingThinking, setPendingThinking] = useState<string | null>(null);

  useEffect(() => {
    setPending(null);
  }, [selectedProvider, selectedModel]);
  useEffect(() => {
    setPendingThinking(null);
  }, [thinking?.selectedId]);
  useEffect(() => {
    if (!pending && !pendingThinking) return undefined;
    const timer = setTimeout(() => {
      setPending(null);
      setPendingThinking(null);
    }, PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending, pendingThinking]);

  const effectiveThinking = useMemo<PickerThinking | null>(() => {
    if (!thinking) return null;
    return {
      ...thinking,
      selectedId: pendingThinking ?? thinking.selectedId,
      onSelect: (id) => {
        setPendingThinking(id);
        runWithRollback(
          () => thinking.onSelect(id),
          () => {
            setPendingThinking(null);
            onFailure("切换思考强度失败");
          },
        );
      },
    };
  }, [onFailure, pendingThinking, thinking]);

  const pick = useCallback(
    (provider: string, modelId: string) => {
      setPending({ provider, model: modelId });
      runWithRollback(
        () => onSelect(provider, modelId),
        () => {
          setPending(null);
          onFailure("切换模型失败");
        },
      );
    },
    [onFailure, onSelect],
  );

  return {
    provider: pending?.provider ?? selectedProvider,
    model: pending?.model ?? selectedModel,
    thinking: effectiveThinking,
    pick,
  };
}
