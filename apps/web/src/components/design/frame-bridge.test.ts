import { KEYBOARD_SHORTCUTS_EVENT } from "@orkestrator/protocol/keyboard-shortcuts";
import { describe, expect, test } from "bun:test";
import { DesignFrameBridge } from "./frame-bridge";

describe("DesignFrameBridge", () => {
  test("bounds pending asks and rejects all of them on close", async () => {
    const target = { postMessage() {} } as unknown as Window;
    const bridge = new DesignFrameBridge(target, 10_000);
    const pending = Array.from({ length: 32 }, () => bridge.ask({ op: "hierarchy" }));
    await expect(bridge.ask({ op: "hierarchy" })).rejects.toThrow("busy");
    bridge.close();
    const results = await Promise.allSettled(pending);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect((results[0] as PromiseRejectedResult).reason.message).toBe("Frame closed");
  });

  test("expires an unanswered ask", async () => {
    const target = { postMessage() {} } as unknown as Window;
    const bridge = new DesignFrameBridge(target, 5);
    await expect(bridge.ask({ op: "hierarchy" })).rejects.toThrow("did not respond");
    bridge.close();
  });
});

describe("DesignFrameBridge lifecycle", () => {
  test("asks after close reject immediately and generations are distinct", async () => {
    const target = { postMessage() {} } as unknown as Window;
    const first = new DesignFrameBridge(target, 1000);
    const second = new DesignFrameBridge(target, 1000);
    expect(second.generation).toBeGreaterThan(first.generation);
    first.close();
    await expect(first.ask({ op: "serialize" })).rejects.toThrow("Frame closed");
    second.close();
  });

  test("an escape message from the frame routes to the owner, not to a pending ask", () => {
    let escaped = 0;
    const target = { postMessage() {} } as unknown as Window;
    const bridge = new DesignFrameBridge(target, 1000, () => escaped++);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: target as unknown as MessageEventSource,
        data: { channel: "orkestrator-design-escape" },
      }),
    );
    expect(escaped).toBe(1);
    bridge.close();
  });
});

test("only the owned, live design frame can forward the shortcuts chord", () => {
  let toggles = 0;
  const onToggle = () => toggles++;
  window.addEventListener(KEYBOARD_SHORTCUTS_EVENT, onToggle);
  const target = { postMessage() {} } as unknown as Window;
  const bridge = new DesignFrameBridge(target);
  const deliver = (source: Window) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: { channel: "orkestrator-design-shortcuts" },
      }),
    );
  try {
    deliver(window);
    expect(toggles).toBe(0);
    deliver(target);
    expect(toggles).toBe(1);
    bridge.close();
    deliver(target);
    expect(toggles).toBe(1);
  } finally {
    bridge.close();
    window.removeEventListener(KEYBOARD_SHORTCUTS_EVENT, onToggle);
  }
});
