export function statusRetryDelay(failureIndex: number): number {
  return [2_000, 5_000, 15_000, 30_000][Math.min(failureIndex, 3)]!;
}

export function statusFailureMessage(hasData: boolean): string {
  return hasData ? "状态更新失败，正在重试…" : "状态读取失败，正在重试…";
}

export function hostReconnected(previous: string | undefined, current: string | undefined): boolean {
  return previous !== "online" && current === "online";
}
