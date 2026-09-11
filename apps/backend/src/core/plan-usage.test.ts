import { describe, expect, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import {
  bridgeAccountWindows,
  createPlanUsageReader,
  normalizeAccountWindows,
  OPENCODE_USAGE_URL,
  openCodePlanWindows,
} from "./plan-usage.js";

function contextWithGlobal(global: Record<string, unknown>): CommandContext {
  return {
    storage: {
      loadConfig: async () => ({ global }),
    },
  } as unknown as CommandContext;
}

describe("openCodePlanWindows", () => {
  test("maps each status-ok window to a used-percent account window", () => {
    const windows = openCodePlanWindows({
      usage: {
        rolling: { status: "ok", percent: 9, resetsAt: "2026-09-11T18:32:00.000Z" },
        weekly: { status: "ok", percent: 12, resetsAt: "2026-09-15T00:00:00.000Z" },
        monthly: { status: "ok", percent: 6, resetsAt: "2026-10-01T00:00:00.000Z" },
      },
    });
    expect(windows.map((window) => window.window)).toEqual(["rolling", "weekly", "monthly"]);
    expect(windows[0]?.usedPercent).toBe(9);
    expect(windows[0]?.label).toBe("Rolling");
    expect(windows[1]?.resetsAt).toBe("2026-09-15T00:00:00.000Z");
  });

  test("omits a window the provider did not report as ok", () => {
    const windows = openCodePlanWindows({
      usage: {
        rolling: { status: "error", percent: 9, resetsAt: "2026-09-11T18:32:00.000Z" },
        weekly: { status: "ok", percent: 12 },
      },
    });
    expect(windows.map((window) => window.window)).toEqual(["weekly"]);
  });

  test("returns nothing for a malformed payload", () => {
    expect(openCodePlanWindows(undefined)).toEqual([]);
    expect(openCodePlanWindows({ usage: null })).toEqual([]);
    expect(openCodePlanWindows({ usage: "nope" })).toEqual([]);
  });
});

describe("normalizeAccountWindows", () => {
  test("keeps known fields and drops entries without a window id", () => {
    const windows = normalizeAccountWindows([
      { window: "primary", label: "Weekly", usedPercent: 42, resetsAt: 1_800_000_000 },
      { label: "No id" },
      "nope",
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.window).toBe("primary");
    expect(windows[0]?.usedPercent).toBe(42);
    expect(windows[0]?.resetsAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  test("drops an out-of-range reset timestamp without discarding the window", () => {
    const windows = normalizeAccountWindows([
      { window: "primary", label: "Weekly", usedPercent: 20, resetsAt: 1e16 },
      { window: "secondary", label: "Rolling", usedPercent: 5, resetsAt: "not-a-date" },
    ]);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ window: "primary", label: "Weekly", usedPercent: 20 });
    expect(windows[1]).toEqual({ window: "secondary", label: "Rolling", usedPercent: 5 });
  });
});

describe("bridgeAccountWindows", () => {
  test("maps an authoritative account array, including an empty one", () => {
    expect(bridgeAccountWindows({ account: [] })).toEqual([]);
    expect(bridgeAccountWindows({ account: [{ window: "primary", usedPercent: 40 }] })).toEqual([
      { window: "primary", usedPercent: 40 },
    ]);
  });

  test("reports a soft-empty read as null rather than an unmetered plan", () => {
    expect(bridgeAccountWindows({ account: null })).toBeNull();
    expect(bridgeAccountWindows({})).toBeNull();
    expect(bridgeAccountWindows(undefined)).toBeNull();
  });
});

describe("createPlanUsageReader", () => {
  test("reports unavailable for a platform that has no plan read", async () => {
    const reader = createPlanUsageReader();
    const snapshot = await reader(contextWithGlobal({}), "pi");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.windows).toEqual([]);
  });

  test("asks for a key when OpenCode has none", async () => {
    const reader = createPlanUsageReader();
    const snapshot = await reader(contextWithGlobal({}), "opencode");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.message).toContain("API key");
  });

  test("reads OpenCode usage with the stored key and caches the result", async () => {
    let calls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      calls += 1;
      expect(String(input)).toBe(OPENCODE_USAGE_URL);
      return new Response(
        JSON.stringify({
          usage: { rolling: { status: "ok", percent: 9 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const reader = createPlanUsageReader({ fetchImpl, now: () => 1_700_000_000_000 });
    const context = contextWithGlobal({ openCodeZenApiKey: "zen-key" });
    const first = await reader(context, "opencode");
    const second = await reader(context, "opencode");
    expect(first.status).toBe("ok");
    expect(first.windows[0]?.usedPercent).toBe(9);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  test("bypasses the cache when a refresh forces a re-read", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ usage: { rolling: { status: "ok", percent: calls } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const reader = createPlanUsageReader({ fetchImpl, now: () => 1_700_000_000_000 });
    const context = contextWithGlobal({ openCodeZenApiKey: "zen-key" });
    const first = await reader(context, "opencode");
    const cached = await reader(context, "opencode");
    expect(cached).toBe(first);
    expect(calls).toBe(1);

    const forced = await reader(context, "opencode", { force: true });
    expect(forced.windows[0]?.usedPercent).toBe(2);
    expect(calls).toBe(2);
  });

  test("reports an error snapshot when the upstream request fails", async () => {
    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const reader = createPlanUsageReader({ fetchImpl });
    const snapshot = await reader(contextWithGlobal({ openCodeZenApiKey: "zen-key" }), "opencode");
    expect(snapshot.status).toBe("error");
    expect(snapshot.windows).toEqual([]);
  });
});
