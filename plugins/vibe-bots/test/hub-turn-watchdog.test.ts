import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoAgentHandle, PaseoAgentTimelineEvent } from "@getpaseo/client";
import { armHubTurnWatchdog, HUB_TURN_IDLE_TIMEOUT_MS, stopHubTurnWatchdogs } from "../server/hub-turn-watchdog";

function fixture(id: string) {
  let listener: ((event: PaseoAgentTimelineEvent) => void) | undefined;
  const snapshot = { activeTurn: { turnId: "turn-1" }, lastUserMessageAt: "original", pendingPermissions: [] as unknown[] };
  const unsubscribe = Object.assign(vi.fn(), { ready: Promise.resolve() });
  const cancelRun = vi.fn().mockResolvedValue(undefined);
  const handle = {
    id, timeline: { subscribe: (fn: typeof listener) => { listener = fn; return unsubscribe; } },
    refresh: vi.fn().mockResolvedValue(undefined), current: () => snapshot, cancelRun,
  } as unknown as PaseoAgentHandle;
  return { handle, snapshot, unsubscribe, cancelRun, emit: (type: string) => listener?.({ agentId: id, event: { type } } as PaseoAgentTimelineEvent) };
}

async function settle() { await vi.advanceTimersByTimeAsync(0); }

describe("中枢轮次无进展保护", () => {
  afterEach(() => { stopHubTurnWatchdogs(); vi.useRealTimers(); vi.restoreAllMocks(); });
  it("只在同一轮连续无进展超时后取消并报告", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture("idle");
    const notify = vi.fn();
    armHubTurnWatchdog(f.handle, notify);
    await settle();
    await vi.advanceTimersByTimeAsync(HUB_TURN_IDLE_TIMEOUT_MS - 1);
    expect(f.cancelRun).not.toHaveBeenCalled();
    f.emit("timeline");
    await vi.advanceTimersByTimeAsync(HUB_TURN_IDLE_TIMEOUT_MS - 1);
    expect(f.cancelRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.cancelRun).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("无进展"));
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("待审批时继续等待；换轮或用户追加消息后不取消", async () => {
    vi.useFakeTimers();
    const permission = fixture("permission");
    permission.snapshot.pendingPermissions.push({});
    armHubTurnWatchdog(permission.handle);
    await settle();
    await vi.advanceTimersByTimeAsync(HUB_TURN_IDLE_TIMEOUT_MS);
    expect(permission.cancelRun).not.toHaveBeenCalled();
    permission.snapshot.activeTurn.turnId = "turn-2";
    await vi.advanceTimersByTimeAsync(HUB_TURN_IDLE_TIMEOUT_MS);
    expect(permission.cancelRun).not.toHaveBeenCalled();
    expect(permission.unsubscribe).toHaveBeenCalledTimes(1);
    const changed = fixture("changed");
    armHubTurnWatchdog(changed.handle);
    await settle();
    changed.snapshot.lastUserMessageAt = "later";
    await vi.advanceTimersByTimeAsync(HUB_TURN_IDLE_TIMEOUT_MS);
    expect(changed.cancelRun).not.toHaveBeenCalled();
    expect(changed.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("收到轮次结束事件时立即释放监听", async () => {
    vi.useFakeTimers();
    const f = fixture("finished");
    armHubTurnWatchdog(f.handle);
    await settle();
    f.emit("turn_completed");
    await vi.advanceTimersByTimeAsync(HUB_TURN_IDLE_TIMEOUT_MS);
    expect(f.cancelRun).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("订阅建立卡住时限时重试，恢复观察前不取消", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture("retry");
    const subscribe = f.handle.timeline.subscribe;
    const hung = Object.assign(vi.fn(), { ready: new Promise<void>(() => {}) });
    const subscribeMock = vi.spyOn(f.handle.timeline, "subscribe").mockReturnValueOnce(hung).mockImplementation(subscribe);
    armHubTurnWatchdog(f.handle);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(hung).toHaveBeenCalledTimes(1);
    expect(f.cancelRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HUB_TURN_IDLE_TIMEOUT_MS);
    expect(f.cancelRun).toHaveBeenCalledTimes(1);
  });
});
