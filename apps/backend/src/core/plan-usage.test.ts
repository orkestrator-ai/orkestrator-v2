import { describe, expect, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import {
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  CURSOR_API_BASE,
  claudePlanWindows,
  codexPlanWindows,
  createPlanUsageReader,
  normalizeAccountWindows,
  OPENCODE_USAGE_URL,
  openCodePlanWindows,
} from "./plan-usage.js";

function contextWithGlobal(global: Record<string, unknown> = {}): CommandContext {
  return {
    storage: {
      loadConfig: async () => ({ global }),
      getDataDir: () => "/tmp/orkestrator-plan-usage",
    },
  } as unknown as CommandContext;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A JWT whose only meaningful claim is the expiry this test needs. */
function tokenExpiringAt(epochSeconds: number, claims: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ exp: epochSeconds, ...claims })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
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

describe("claudePlanWindows", () => {
  test("labels the known windows and keeps their period length", () => {
    const windows = claudePlanWindows({
      five_hour: { utilization: 37.2, resets_at: "2026-09-11T22:00:00.000Z" },
      seven_day: { utilization: 61.8, resets_at: "2026-09-15T00:00:00.000Z" },
      account_uuid: "3f0b",
      extra_usage: { enabled: true },
    });
    expect(windows).toEqual([
      {
        window: "five_hour",
        label: "5-hour limit",
        usedPercent: 37.2,
        resetsAt: "2026-09-11T22:00:00.000Z",
        windowMinutes: 300,
      },
      {
        window: "seven_day",
        label: "Weekly limit",
        usedPercent: 61.8,
        resetsAt: "2026-09-15T00:00:00.000Z",
        windowMinutes: 10_080,
      },
    ]);
  });

  test("keeps an unknown window the endpoint starts reporting", () => {
    const windows = claudePlanWindows({ fiveHourOpus: { utilization: 4 } });
    expect(windows).toEqual([
      { window: "five_hour_opus", label: "Five hour opus", usedPercent: 4 },
    ]);
  });

  test("returns nothing for a payload with no utilization anywhere", () => {
    expect(claudePlanWindows({ organization: { name: "acme" } })).toEqual([]);
    expect(claudePlanWindows("nope")).toEqual([]);
  });
});

describe("codexPlanWindows", () => {
  test("maps both limit slots, the plan name and a credit balance", () => {
    const { windows, plan } = codexPlanWindows(
      {
        rate_limits: {
          limit_name: "Plus",
          primary: { used_percent: 25, window_minutes: 300, resets_in_seconds: 600 },
          secondary: { used_percent: 18, window_minutes: 10_080, resets_at: 1_779_826_837 },
          credits: { balance: "$4.20" },
        },
        plan_type: "plus",
      },
      Date.UTC(2026, 8, 11, 18, 0, 0),
    );
    expect(plan).toBe("plus");
    expect(windows).toEqual([
      {
        window: "primary",
        label: "Plus",
        usedPercent: 25,
        resetsAt: "2026-09-11T18:10:00.000Z",
        windowMinutes: 300,
      },
      {
        window: "secondary",
        label: "Weekly limit",
        usedPercent: 18,
        resetsAt: new Date(1_779_826_837_000).toISOString(),
        windowMinutes: 10_080,
      },
      { window: "credits", label: "Credits", creditBalance: "$4.20" },
    ]);
  });

  test("reads the app-server spelling of the same snapshot", () => {
    const { windows } = codexPlanWindows(
      { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 1_440 } } },
      0,
    );
    expect(windows).toEqual([
      { window: "primary", label: "Daily limit", usedPercent: 5, windowMinutes: 1_440 },
    ]);
  });

  test("returns nothing for a payload with no windows", () => {
    expect(codexPlanWindows({ rate_limits: {} }, 0).windows).toEqual([]);
    expect(codexPlanWindows(undefined, 0).windows).toEqual([]);
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

describe("createPlanUsageReader", () => {
  test("reports unavailable for a platform that has no plan read", async () => {
    const reader = createPlanUsageReader();
    const snapshot = await reader(contextWithGlobal(), "pi");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.windows).toEqual([]);
  });

  test("asks for a key when OpenCode has none", async () => {
    const reader = createPlanUsageReader();
    const snapshot = await reader(contextWithGlobal(), "opencode");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.message).toContain("API key");
  });

  test("reads OpenCode usage with the stored key and caches the result", async () => {
    let calls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      calls += 1;
      expect(String(input)).toBe(OPENCODE_USAGE_URL);
      return jsonResponse({ usage: { rolling: { status: "ok", percent: 9 } } });
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
      return jsonResponse({ usage: { rolling: { status: "ok", percent: calls } } });
    }) as unknown as typeof fetch;
    const reader = createPlanUsageReader({ fetchImpl, now: () => 1_700_000_000_000 });
    const context = contextWithGlobal({ openCodeZenApiKey: "zen-key" });
    const first = await reader(context, "opencode");
    expect(await reader(context, "opencode")).toBe(first);
    expect(calls).toBe(1);

    const forced = await reader(context, "opencode", { force: true });
    expect(forced.windows[0]?.usedPercent).toBe(2);
    expect(calls).toBe(2);
  });

  test("re-reads once the two-minute cache window has passed", async () => {
    let calls = 0;
    let clock = 1_700_000_000_000;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ usage: { rolling: { status: "ok", percent: calls } } });
    }) as unknown as typeof fetch;
    const reader = createPlanUsageReader({ fetchImpl, now: () => clock });
    const context = contextWithGlobal({ openCodeZenApiKey: "zen-key" });
    await reader(context, "opencode");
    clock += 119_000;
    await reader(context, "opencode");
    expect(calls).toBe(1);
    clock += 2_000;
    await reader(context, "opencode");
    expect(calls).toBe(2);
  });

  test("reports an error snapshot when the upstream request fails", async () => {
    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const reader = createPlanUsageReader({ fetchImpl });
    const snapshot = await reader(contextWithGlobal({ openCodeZenApiKey: "zen-key" }), "opencode");
    expect(snapshot.status).toBe("error");
    expect(snapshot.windows).toEqual([]);
  });

  test("reads Claude's plan from the OAuth usage endpoint", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse({ five_hour: { utilization: 37.2 } });
    }) as unknown as typeof fetch;
    const reader = createPlanUsageReader({
      fetchImpl,
      now: () => 1_700_000_000_000,
      credentials: { claude: async () => "oauth-token" },
    });
    const snapshot = await reader(contextWithGlobal(), "claude");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.windows[0]?.label).toBe("5-hour limit");
    expect(seen[0]?.url).toBe(CLAUDE_USAGE_URL);
    expect(seen[0]?.headers.Authorization).toBe("Bearer oauth-token");
    expect(seen[0]?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  test("asks for a Claude sign-in rather than requesting without one", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const reader = createPlanUsageReader({
      fetchImpl,
      credentials: { claude: async () => undefined },
    });
    const snapshot = await reader(contextWithGlobal(), "claude");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.message).toMatch(/Sign in to Claude/);
    expect(calls).toBe(0);
  });

  test("respects the host Claude credential opt-out", async () => {
    const reader = createPlanUsageReader({
      credentials: {
        claude: async () => {
          throw new Error("credentials must not be read when the opt-out is set");
        },
      },
    });
    const snapshot = await reader(contextWithGlobal({ useHostClaudeCredentials: false }), "claude");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.message).toMatch(/turned off/);
  });

  test("reports a rejected Claude token as a sign-in to redo", async () => {
    const fetchImpl = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const reader = createPlanUsageReader({
      fetchImpl,
      credentials: { claude: async () => "stale-token" },
    });
    const snapshot = await reader(contextWithGlobal(), "claude");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.message).toMatch(/Sign in again/);
  });

  test("reads Codex usage with the account its stored token names", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(CODEX_USAGE_URL);
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({
        rate_limits: { primary: { used_percent: 25, window_minutes: 300 } },
      });
    }) as unknown as typeof fetch;
    const auth = JSON.stringify({
      tokens: {
        access_token: tokenExpiringAt(2_000_000_000),
        id_token: tokenExpiringAt(2_000_000_000, {
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-7" },
        }),
      },
    });
    const reader = createPlanUsageReader({
      fetchImpl,
      now: () => 1_700_000_000_000,
      credentials: { codex: async () => auth },
    });
    const snapshot = await reader(contextWithGlobal(), "codex");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.windows[0]?.usedPercent).toBe(25);
    expect(seen[0]?.["ChatGPT-Account-Id"]).toBe("acct-7");
  });

  test("treats an expired Codex token as a sign-in to refresh", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const auth = JSON.stringify({ tokens: { access_token: tokenExpiringAt(1_600_000_000) } });
    const reader = createPlanUsageReader({
      fetchImpl,
      now: () => 1_700_000_000_000,
      credentials: { codex: async () => auth },
    });
    const snapshot = await reader(contextWithGlobal(), "codex");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.message).toMatch(/expired/);
    expect(calls).toBe(0);
  });

  test("exchanges the Cursor key once and reuses the dashboard token", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/auth/exchange_user_api_key")) {
        return jsonResponse({ accessToken: tokenExpiringAt(2_000_000_000) });
      }
      return jsonResponse({
        planUsage: { autoPercentUsed: 40, apiPercentUsed: 5 },
        billingCycleStart: 1_756_000_000_000,
        billingCycleEnd: 1_758_000_000_000,
      });
    }) as unknown as typeof fetch;
    const reader = createPlanUsageReader({
      fetchImpl,
      now: () => 1_700_000_000_000,
      credentials: { cursor: async () => "cursor-key" },
    });
    const context = contextWithGlobal();
    const snapshot = await reader(context, "cursor");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.windows.map((window) => window.usedPercent)).toEqual([40, 5]);
    await reader(context, "cursor", { force: true });
    expect(urls).toEqual([
      `${CURSOR_API_BASE}/auth/exchange_user_api_key`,
      `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
      `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
    ]);
  });

  test("coalesces concurrent reads of the same platform", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ usage: { rolling: { status: "ok", percent: 3 } } });
    }) as unknown as typeof fetch;
    const reader = createPlanUsageReader({ fetchImpl });
    const context = contextWithGlobal({ openCodeZenApiKey: "zen-key" });
    const [first, second] = await Promise.all([
      reader(context, "opencode"),
      reader(context, "opencode"),
    ]);
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });
});

describe("recordSessionWindows", () => {
  test("serves a running session's windows instead of reading the provider", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    let clock = 1_700_000_000_000;
    const reader = createPlanUsageReader({
      fetchImpl,
      now: () => clock,
      credentials: { claude: async () => "oauth-token" },
    });
    reader.recordSessionWindows("claude", [
      { window: "five_hour", label: "5-hour limit", usedPercent: 12 },
    ]);
    const snapshot = await reader(contextWithGlobal(), "claude");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.windows[0]?.usedPercent).toBe(12);
    expect(calls).toBe(0);

    clock += 121_000;
    await reader(contextWithGlobal(), "claude");
    expect(calls).toBe(1);
  });

  test("a changed session snapshot defers the next read by a full window", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ five_hour: { utilization: 99 } });
    }) as unknown as typeof fetch;
    let clock = 1_700_000_000_000;
    const reader = createPlanUsageReader({
      fetchImpl,
      now: () => clock,
      credentials: { claude: async () => "oauth-token" },
    });
    reader.recordSessionWindows("claude", [{ window: "five_hour", usedPercent: 12 }]);
    clock += 119_000;
    reader.recordSessionWindows("claude", [{ window: "five_hour", usedPercent: 18 }]);
    clock += 2_000;
    const snapshot = await reader(contextWithGlobal(), "claude");
    expect(snapshot.windows[0]?.usedPercent).toBe(18);
    expect(calls).toBe(0);
  });

  test("an unchanged repeat does not hold the provider read off forever", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ five_hour: { utilization: 99 } });
    }) as unknown as typeof fetch;
    let clock = 1_700_000_000_000;
    const reader = createPlanUsageReader({
      fetchImpl,
      now: () => clock,
      credentials: { claude: async () => "oauth-token" },
    });
    const windows = [{ window: "five_hour", usedPercent: 12 }];
    reader.recordSessionWindows("claude", windows);
    clock += 119_000;
    reader.recordSessionWindows("claude", [...windows]);
    clock += 2_000;
    const snapshot = await reader(contextWithGlobal(), "claude");
    expect(snapshot.windows[0]?.usedPercent).toBe(99);
    expect(calls).toBe(1);
  });

  test("keeps only Cursor's plan rows, not a session's own spend", async () => {
    const reader = createPlanUsageReader({
      now: () => 1_700_000_000_000,
      credentials: { cursor: async () => undefined },
    });
    reader.recordSessionWindows("cursor", [
      { window: "session", label: "This session", spendUsd: 0.4 },
      { window: "cursor-internal-auto", label: "Cursor Models", usedPercent: 40 },
    ]);
    const snapshot = await reader(contextWithGlobal(), "cursor");
    expect(snapshot.windows).toEqual([
      { window: "cursor-internal-auto", label: "Cursor Models", usedPercent: 40 },
    ]);
  });

  test("ignores a session on a platform with no plan read", async () => {
    const reader = createPlanUsageReader({ now: () => 1_700_000_000_000 });
    reader.recordSessionWindows("pi", [{ window: "primary", usedPercent: 10 }]);
    const snapshot = await reader(contextWithGlobal(), "pi");
    expect(snapshot.status).toBe("unavailable");
  });
});
