/** Repeated background failures are useful, but their stacks and five-second repeats are not. */
export function createRetryErrorLogger(
  write: (message: string) => void,
  now: () => number = Date.now,
): (error: unknown) => void {
  const lastLogged = new Map<string, number>();
  return (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const time = now();
    const previous = lastLogged.get(message);
    if (previous !== undefined && time - previous < 60_000) return;
    lastLogged.delete(message);
    lastLogged.set(message, time);
    if (lastLogged.size > 100) lastLogged.delete(lastLogged.keys().next().value!);
    write(`vibe-scheduler: ${message}`);
  };
}
