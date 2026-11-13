import { expect, test, setSystemTime } from "bun:test";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { CACHE_TTL_MS, createPlanUsageCache } from "./plan-usage/cache.js";
import {
  cachedPlanUsage,
  readProjectUsageLimits,
  turnOutcomeFailureKind,
} from "./agent-usage-limits.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { resumeAfterSwitch } from "./control-mcp/account-tools.js";
import type { Environment, PersistedNativeAgentSession } from "./models.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");

function session(
  environmentId: string,
  tabId: string,
  outcomes: PersistedNativeAgentSession["turnOutcomes"],
  extra: Partial<PersistedNativeAgentSession> = {},
): PersistedNativeAgentSession {
  return {
    key: `${environmentId}:${tabId}`,
    environmentId,
    agent: "codex",
    logicalSessionKey: `env-${environmentId}:${tabId}`,
    turnOutcomes: outcomes,
    ...extra,
  } as unknown as PersistedNativeAgentSession;
}

const failed = (error: string, observedAt = "2026-10-30T11:00:00.000Z") => ({
  requestId: `r-${observedAt}`,
  outcome: "failed" as const,
  error,
  observedAt,
});

test("lists only tabs of the project whose newest recorded turn hit a usage limit", async () => {
  const environments = [
    { id: "env-a", projectId: "p", name: "A" },
    { id: "env-b", projectId: "p", name: "B" },
  ] as unknown as Environment[];
  const sessions = [
    // Limited.
    session("env-a", "tab-1", [failed("You've hit your usage limit. Try again at 3:05 PM.")]),
    // Limited earlier, then a turn completed: cleared.
    session("env-a", "tab-2", [
      failed("usageLimitExceeded", "2026-10-30T10:00:00.000Z"),
      { requestId: "ok", outcome: "completed", observedAt: "2026-10-30T11:00:00.000Z" },
    ]),
    // A different failure.
    session("env-b", "tab-3", [failed("Overloaded")]),
    // Another project's environment.
    session("env-other", "tab-4", [failed("usage limit reached")]),
    // A coordinator's own session.
    session("env-b", "tab-5", [failed("usage limit reached")], {
      owner: { kind: "coordinator", projectId: "p", coordinatorId: "c" },
    } as Partial<PersistedNativeAgentSession>),
    // Never dispatched anything.
    session("env-b", "tab-6", undefined),
  ];
  const limits = await readProjectUsageLimits(
    {
      storage: {
        getEnvironmentsByProject: async (projectId) =>
          environments.filter((environment) => environment.projectId === projectId),
        listNativeAgentSessions: async () => sessions,
      },
      planUsage: () => undefined,
      now: () => NOW,
    },
    "p",
  );
  expect(limits.limitedTabs).toEqual([
    {
      environmentId: "env-a",
      environmentName: "A",
      tabId: "tab-1",
      agent: "codex",
      observedAt: "2026-10-30T11:00:00.000Z",
      error: "You've hit your usage limit. Try again at 3:05 PM.",
      resetHint: "3:05 PM",
      signal: "text",
    },
  ]);
  expect(limits.activeAccounts).toEqual([]);
});

test("a bridge's structured usage-limit kind lists the tab whatever the error says", async () => {
  const environments = [{ id: "env-a", projectId: "p", name: "A" }] as unknown as Environment[];
  const sessions = [
    // Reworded by the provider: only the structured kind says it is a limit.
    session("env-a", "tab-1", [{ ...failed("Your plan is paused."), failureKind: "usage-limit" }]),
    // An older bridge or record: no kind, the text still classifies.
    session("env-a", "tab-2", [failed("You've hit your limit · resets 3pm")], { agent: "claude" }),
    // No kind and no limit wording: not listed.
    session("env-a", "tab-3", [failed("Your plan is paused.")]),
  ];
  const limits = await readProjectUsageLimits(
    {
      storage: {
        getEnvironmentsByProject: async () => environments,
        listNativeAgentSessions: async () => sessions,
      },
      planUsage: () => undefined,
      now: () => NOW,
    },
    "p",
  );
  expect(limits.limitedTabs.map((tab) => [tab.tabId, tab.signal, tab.resetHint])).toEqual([
    ["tab-1", "provider", undefined],
    ["tab-2", "text", "3pm"],
  ]);
});

test("the recorded kind is the bridge's when it sent one, else leaves text classification to readers", () => {
  const before = compatibilityPathUsage.snapshot().paths["usage-limit.text-classified"]?.count;
  expect(turnOutcomeFailureKind("codex", "Your plan is paused.", "usage-limit")).toBe(
    "usage-limit",
  );
  expect(turnOutcomeFailureKind("codex", "Overloaded", undefined)).toBeUndefined();
  // An older Claude or Codex bridge: classified by text, and counted.
  expect(turnOutcomeFailureKind("claude", "You've hit your limit", undefined)).toBeUndefined();
  // Grok has no structured signal; its text path is not a compatibility path.
  expect(turnOutcomeFailureKind("grok", "USAGE_EXHAUSTED", undefined)).toBeUndefined();
  const after = compatibilityPathUsage.snapshot().paths["usage-limit.text-classified"]?.count;
  expect((after ?? 0) - (before ?? 0)).toBe(1);
});

test("reports each platform's cached reading with the windows that are used up", async () => {
  const snapshots: Partial<Record<string, PlanUsageSnapshot>> = {
    claude: {
      platform: "claude",
      status: "ok",
      fetchedAt: "2026-10-30T11:55:00.000Z",
      windows: [
        { window: "five_hour", usedPercent: 100, resetsAt: "2026-10-30T14:00:00.000Z" },
        { window: "seven_day", usedPercent: 60, resetsAt: "2026-11-02T00:00:00.000Z" },
      ],
    },
    codex: {
      platform: "codex",
      status: "error",
      fetchedAt: "2026-10-30T11:55:00.000Z",
      windows: [],
      message: "Usage could not be read",
    },
  };
  const limits = await readProjectUsageLimits(
    {
      storage: {
        getEnvironmentsByProject: async () => [],
        listNativeAgentSessions: async () => [],
      },
      planUsage: (platform) => snapshots[platform],
      now: () => NOW,
    },
    "p",
  );
  expect(limits.activeAccounts).toEqual([
    {
      platform: "claude",
      fetchedAt: "2026-10-30T11:55:00.000Z",
      stale: false,
      exhaustedWindows: [
        {
          window: "five_hour",
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: "2026-10-30T14:00:00.000Z",
        },
      ],
      windows: [
        {
          window: "five_hour",
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: "2026-10-30T14:00:00.000Z",
        },
        {
          window: "seven_day",
          usedPercent: 60,
          remainingPercent: 40,
          resetsAt: "2026-11-02T00:00:00.000Z",
        },
      ],
    },
  ]);
});

test("cache expiry serves lastOk as stale without changing fetchedAt", async () => {
  setSystemTime(NOW);
  const cache = createPlanUsageCache();
  try {
    const snapshot: PlanUsageSnapshot = {
      platform: "claude",
      status: "ok",
      fetchedAt: new Date(NOW).toISOString(),
      windows: [{ window: "quota", usedPercent: 40 }],
    };
    cache.store("claude", snapshot, CACHE_TTL_MS);
    const sources = {
      storage: {
        getEnvironmentsByProject: async () => [],
        listNativeAgentSessions: async () => [],
      },
      planUsage: cachedPlanUsage(cache),
    };
    expect((await readProjectUsageLimits(sources, "p")).activeAccounts[0]?.stale).toBe(false);
    setSystemTime(NOW + CACHE_TTL_MS + 1);
    expect(cache.peek("claude")).toBeUndefined();
    expect((await readProjectUsageLimits(sources, "p")).activeAccounts[0]).toMatchObject({
      stale: true,
      fetchedAt: snapshot.fetchedAt,
    });
    expect(cache.lastOk("claude")).toBe(snapshot);
  } finally {
    setSystemTime();
  }
});

test("after a switch the coordinator is told to resume exactly the limited tabs", () => {
  const tab = { environmentId: "env-a", environmentName: "A", tabId: "tab-1" };
  expect(resumeAfterSwitch([tab])).toEqual({
    limitedTabs: [tab],
    resumeStep: expect.stringContaining("Only these tabs"),
  });
  expect(resumeAfterSwitch([])).toEqual({
    limitedTabs: [],
    resumeStep: expect.stringContaining("nothing to resume"),
  });
  // Unreadable: the coordinator reads them itself rather than guessing.
  expect(resumeAfterSwitch(undefined)).toEqual({
    resumeStep: expect.stringContaining("Call get_usage_limits"),
  });
});
