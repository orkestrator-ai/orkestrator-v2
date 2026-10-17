import { describe, expect, test } from "bun:test";
import { withProviderSessionTeardownLock } from "./provider-session-ownership.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("provider session teardown lock", () => {
  test("serializes one session within one storage, and nothing else", async () => {
    const storage = {};
    const otherStorage = {};
    const order: string[] = [];
    const held = gate();
    const first = withProviderSessionTeardownLock(storage, "env-1", "grok", "s1", async () => {
      order.push("first:start");
      await held.opened;
      order.push("first:end");
    });
    const second = withProviderSessionTeardownLock(storage, "env-1", "grok", "s1", async () => {
      order.push("second");
    });
    // A different session, agent or storage does not wait for the held one.
    await withProviderSessionTeardownLock(storage, "env-1", "grok", "s2", async () => {
      order.push("other-session");
    });
    await withProviderSessionTeardownLock(storage, "env-1", "pi", "s1", async () => {
      order.push("other-agent");
    });
    await withProviderSessionTeardownLock(otherStorage, "env-1", "grok", "s1", async () => {
      order.push("other-storage");
    });
    held.open();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "first:start",
      "other-session",
      "other-agent",
      "other-storage",
      "first:end",
      "second",
    ]);
  });

  test("a failed holder still releases the lock", async () => {
    const storage = {};
    await expect(
      withProviderSessionTeardownLock(storage, "env-1", "grok", "s1", async () => {
        throw new Error("close failed");
      }),
    ).rejects.toThrow("close failed");
    await expect(
      withProviderSessionTeardownLock(storage, "env-1", "grok", "s1", async () => "next"),
    ).resolves.toBe("next");
  });
});
