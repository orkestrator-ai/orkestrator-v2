import { describe, expect, spyOn, test } from "bun:test";
import { onAppShortcut } from "@/lib/app-shortcuts";
import { DesignFrameBridge } from "./frame-bridge";

describe("DesignFrameBridge", () => {
  test("bounds pending asks and rejects all of them on close", async () => {
    const target = { postMessage() {} } as unknown as Window;
    const bridge = new DesignFrameBridge(target, 10_000).open();
    const pending = Array.from({ length: 32 }, () => bridge.ask({ op: "hierarchy" }));
    await expect(bridge.ask({ op: "hierarchy" })).rejects.toThrow("busy");
    bridge.close();
    const results = await Promise.allSettled(pending);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect((results[0] as PromiseRejectedResult).reason.message).toBe("Frame closed");
  });

  test("expires an unanswered ask", async () => {
    const target = { postMessage() {} } as unknown as Window;
    const bridge = new DesignFrameBridge(target, 5).open();
    await expect(bridge.ask({ op: "hierarchy" })).rejects.toThrow("did not respond");
    bridge.close();
  });
});

describe("DesignFrameBridge lifecycle", () => {
  test("listens only from open() until close(), and refuses asks before open", async () => {
    const target = { postMessage() {} } as unknown as Window;
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const record =
      (into: unknown[]) => (type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (type === "message") into.push(listener);
      };
    const add = spyOn(window, "addEventListener").mockImplementation(record(added));
    const remove = spyOn(window, "removeEventListener").mockImplementation(record(removed));
    try {
      const bridge = new DesignFrameBridge(target, 1000);
      expect(added).toHaveLength(0);
      await expect(bridge.ask({ op: "serialize" })).rejects.toThrow("not open");
      expect(bridge.open().open()).toBe(bridge);
      expect(added).toHaveLength(1);
      bridge.close();
      expect(removed).toEqual(added);
      bridge.open();
      expect(added).toHaveLength(1);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  test("close() lets go of the frame's window while the bridge itself is still held", () => {
    // A stale render can keep a closed bridge reachable (to-do 7820 (retired)); the
    // window, and with it the culled frame, must not stay with it.
    let bridge: DesignFrameBridge | null = null;
    const watched = (() => {
      const target = { postMessage() {} } as unknown as Window;
      bridge = new DesignFrameBridge(target, 1000).open();
      return new WeakRef(target);
    })();
    Bun.gc(true);
    expect(watched.deref()).toBeDefined();
    bridge!.close();
    Bun.gc(true);
    expect(watched.deref()).toBeUndefined();
    expect(bridge!.closed).toBe(true);
  });

  test("asks after close reject immediately and generations are distinct", async () => {
    const target = { postMessage() {} } as unknown as Window;
    const first = new DesignFrameBridge(target, 1000).open();
    const second = new DesignFrameBridge(target, 1000).open();
    expect(second.generation).toBeGreaterThan(first.generation);
    first.close();
    await expect(first.ask({ op: "serialize" })).rejects.toThrow("Frame closed");
    second.close();
  });

  test("an escape message from the frame routes to the owner, not to a pending ask", () => {
    let escaped = 0;
    const target = { postMessage() {} } as unknown as Window;
    const bridge = new DesignFrameBridge(target, 1000, () => escaped++).open();
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

test("only the owned, live design frame can forward app shortcuts", () => {
  const forwarded: string[] = [];
  const stops = (["show-shortcuts", "search-projects"] as const).map((id) =>
    onAppShortcut(id, () => forwarded.push(id)),
  );
  const target = { postMessage() {} } as unknown as Window;
  const bridge = new DesignFrameBridge(target).open();
  const deliver = (source: Window, shortcut: unknown) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: { channel: "orkestrator-design-shortcuts", shortcut },
      }),
    );
  try {
    deliver(window, "show-shortcuts");
    expect(forwarded).toEqual([]);
    deliver(target, "show-shortcuts");
    deliver(target, "search-projects");
    deliver(target, "close-tab");
    expect(forwarded).toEqual(["show-shortcuts", "search-projects"]);
    bridge.close();
    deliver(target, "show-shortcuts");
    expect(forwarded).toHaveLength(2);
  } finally {
    bridge.close();
    for (const stop of stops) stop();
  }
});
