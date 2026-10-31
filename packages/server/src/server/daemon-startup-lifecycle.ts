/** Wait for in-flight startup before stopping; a failed listen still needs cleanup. */
export async function stopDaemonAfterStartup<T extends { stop(): Promise<void> }>(
  initialization: Promise<T>,
  getStart: () => Promise<void> | null,
): Promise<void> {
  const daemon = await initialization;
  try {
    await getStart();
  } catch {
    // start() can fail after acquiring resources, so still call stop().
  }
  await daemon.stop();
}
