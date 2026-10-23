import { useEffect, useState, useSyncExternalStore } from "react";
import { firstMessageOutbox } from "@/runtime/first-message-outbox";
import { toErrorMessage } from "@/utils/error-messages";

export function useFirstMessageOutbox() {
  const entries = useSyncExternalStore(
    firstMessageOutbox.subscribe,
    firstMessageOutbox.getSnapshot,
    firstMessageOutbox.getSnapshot,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void firstMessageOutbox.hydrate().catch((hydrateError) => {
      if (active) setError(toErrorMessage(hydrateError));
    });
    return () => {
      active = false;
    };
  }, []);
  return { entries, error };
}
