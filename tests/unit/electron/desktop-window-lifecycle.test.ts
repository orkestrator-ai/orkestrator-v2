import { describe, expect, mock, test } from "bun:test";
import {
  browserPreviewPartitionForWindow,
  cleanupFailedDesktopWindow,
  DesktopWindowRequestGate,
  DesktopWindowSlotAllocator,
  rendererPartitionForWindow,
} from "../../../apps/desktop/electron/desktop-window-lifecycle";

describe("desktop window lifecycle", () => {
  test("queues new-window requests until startup marks IPC ready", () => {
    const gate = new DesktopWindowRequestGate();
    expect(gate.request()).toBe(false);
    expect(gate.request()).toBe(false);
    expect(gate.markReady()).toBe(2);
    expect(gate.request()).toBe(true);
    expect(gate.markReady()).toBe(0);
  });

  test("bounds slots and safely reuses released positions", () => {
    const slots = new DesktopWindowSlotAllocator(2);
    expect(slots.allocate()).toBe(1);
    expect(slots.allocate()).toBe(2);
    expect(() => slots.allocate()).toThrow("up to 2 open windows");
    slots.release(1);
    expect(slots.allocate()).toBe(1);
  });

  test("partitions persistent sessions by both slot and connection", () => {
    expect(rendererPartitionForWindow(1, "local", true)).toBeUndefined();
    const rendererA = rendererPartitionForWindow(2, "remote-a", false);
    const rendererB = rendererPartitionForWindow(2, "remote-b", false);
    const previewA = browserPreviewPartitionForWindow(2, "remote-a");
    const previewB = browserPreviewPartitionForWindow(2, "remote-b");

    expect(rendererA).toStartWith("persist:orkestrator-renderer-2-");
    expect(rendererA).not.toBe(rendererB);
    expect(previewA).not.toBe(previewB);
    expect(previewA).not.toBe(rendererA);
  });

  test("destroys allocated windows and directly cleans unregistered failures", () => {
    const destroy = mock(() => undefined);
    const releaseScope = mock(() => undefined);
    const releaseSlot = mock(() => undefined);
    cleanupFailedDesktopWindow({
      window: { isDestroyed: () => false, destroy },
      registered: false,
      releaseScope,
      releaseSlot,
    });

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(releaseScope).toHaveBeenCalledTimes(1);
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  test("leaves registered cleanup to the closed handler", () => {
    const destroy = mock(() => undefined);
    const releaseScope = mock(() => undefined);
    const releaseSlot = mock(() => undefined);
    cleanupFailedDesktopWindow({
      window: { isDestroyed: () => false, destroy },
      registered: true,
      releaseScope,
      releaseSlot,
    });

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(releaseScope).not.toHaveBeenCalled();
    expect(releaseSlot).not.toHaveBeenCalled();
  });
});
