/** Schedule background convergence after the server starts accepting requests. */
export function scheduleStartupReconciliation(run: () => void): () => void {
  const timer = setTimeout(run, 30_000);
  timer.unref();
  return () => clearTimeout(timer);
}
