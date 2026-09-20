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
