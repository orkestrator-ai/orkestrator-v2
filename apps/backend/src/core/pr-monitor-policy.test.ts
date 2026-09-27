import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PR_MONITOR_POLICY,
  PrCooldownScopes,
  backgroundDelay,
  classifyPrDetectionFailure,
  detectionPriority,
  resolvePrMonitorPolicy,
  type DelayInput,
} from "./pr-monitor-policy.js";
import { CommandFailedError } from "./shell.js";

const policy = DEFAULT_PR_MONITOR_POLICY;

function delay(overrides: Partial<DelayInput>): number {
  return backgroundDelay(
    {
      policy: "open",
      mode: "normal",
      consecutiveErrors: 0,
      repairFailures: 0,
      restored: false,
      random: 0,
      ...overrides,
    },
    policy,
  );
}

describe("PR monitor policy", () => {
  test("preserves the open and pending cadences exactly", () => {
    expect(delay({ policy: "open", random: 0.99 })).toBe(20_000);
    expect(delay({ policy: "create-pending", mode: "create-pending", random: 0.99 })).toBe(5_000);
    expect(delay({ policy: "merge-pending", mode: "merge-pending", random: 0.99 })).toBe(1_000);
    // Restoration jitter applies to ordinary entries only, never to pending intent.
    expect(
      delay({ policy: "merge-pending", mode: "merge-pending", restored: true, random: 0.99 }),
    ).toBe(1_000);
    expect(delay({ policy: "open", restored: true, random: 0.5 })).toBe(30_000);
  });

  test("terminal discovery runs once per period with bounded jitter; restoration spreads it", () => {
    expect(delay({ policy: "terminal-discovery" })).toBe(300_000);
    expect(delay({ policy: "terminal-discovery", random: 0.999 })).toBeLessThan(330_000);
    expect(delay({ policy: "terminal-discovery", restored: true, random: 0 })).toBe(20_000);
    expect(delay({ policy: "terminal-discovery", restored: true, random: 0.5 })).toBe(150_000);
    // Detection errors never make a quiet entry faster than its period.
    expect(delay({ policy: "terminal-discovery", consecutiveErrors: 3 })).toBe(300_000);
  });

  test("terminal repair backs off on its own failures, capped at five minutes", () => {
    expect(delay({ policy: "terminal-repair" })).toBe(20_000);
    expect(delay({ policy: "terminal-repair", repairFailures: 1 })).toBe(40_000);
    expect(delay({ policy: "terminal-repair", repairFailures: 9 })).toBe(300_000);
    expect(delay({ policy: "terminal-repair", repairFailures: 9, random: 0.999 })).toBeLessThan(
      330_000,
    );
  });

  test("error jitter is bounded by ratio and ceiling", () => {
    expect(delay({ consecutiveErrors: 1, random: 0.999 })).toBeLessThan(44_000);
    expect(delay({ consecutiveErrors: 5, random: 0.999 })).toBeLessThan(330_000);
    expect(delay({ consecutiveErrors: 5, random: 0.999 })).toBeGreaterThanOrEqual(300_000);
  });

  test("admission priority puts user intent first and quiet terminal discovery last", () => {
    expect(detectionPriority("terminal-discovery", "interactive", false)).toBe("interactive");
    expect(detectionPriority("merge-pending", null, false)).toBe("interactive");
    expect(detectionPriority("create-pending", null, false)).toBe("interactive");
    expect(detectionPriority("open", null, true)).toBe("recovery");
    expect(detectionPriority("terminal-discovery", "completion", false)).toBe("progress");
    expect(detectionPriority("provisional", null, false)).toBe("progress");
    expect(detectionPriority("open", null, false)).toBe("discovery");
    expect(detectionPriority("terminal-discovery", null, false)).toBe("maintenance");
  });

  test("classifies rate limits, timeouts and ordinary failures without keeping text", () => {
    expect(
      classifyPrDetectionFailure(new Error("GraphQL: API rate limit exceeded for user")),
    ).toEqual({ kind: "rate-limited", retryAfterMs: null });
    expect(
      classifyPrDetectionFailure(
        new Error("You have exceeded a secondary rate limit. Please wait a few minutes"),
      ),
    ).toEqual({ kind: "rate-limited", retryAfterMs: null });
    expect(classifyPrDetectionFailure(new Error("HTTP 429: Too Many Requests"))).toEqual({
      kind: "rate-limited",
      retryAfterMs: null,
    });
    expect(
      classifyPrDetectionFailure(Object.assign(new Error("slow down"), { retryAfterMs: 5_000 })),
    ).toEqual({ kind: "rate-limited", retryAfterMs: 5_000 });
    expect(
      classifyPrDetectionFailure(
        new CommandFailedError("Command failed", { timedOut: true, executableMissing: false }),
      ),
    ).toEqual({ kind: "timeout" });
    expect(classifyPrDetectionFailure(new Error("HTTP 404: Not Found"))).toEqual({
      kind: "failed",
    });
    expect(classifyPrDetectionFailure(undefined)).toEqual({ kind: "failed" });
  });

  test("invalid policy overrides fall back and the discovery period never undercuts open cadence", () => {
    const resolved = resolvePrMonitorPolicy({
      terminalDiscoveryIntervalMs: 1_000,
      terminalDiscoveryJitterMs: Number.NaN,
      maxReconciliationKeys: 0,
      errorJitterRatio: 5,
    });
    expect(resolved.terminalDiscoveryIntervalMs).toBe(20_000);
    expect(resolved.terminalDiscoveryJitterMs).toBe(policy.terminalDiscoveryJitterMs);
    expect(resolved.maxReconciliationKeys).toBe(policy.maxReconciliationKeys);
    expect(resolved.errorJitterRatio).toBe(1);
  });

  test("cooldown scopes are bounded, prune expired entries and never shorten a cooldown", () => {
    const scopes = new PrCooldownScopes(2);
    scopes.set("a", 1_000, 0);
    scopes.set("a", 500, 0);
    expect(scopes.remaining("a", 0)).toBe(1_000);
    scopes.set("b", 2_000, 0);
    scopes.set("c", 3_000, 0);
    expect(scopes.size).toBe(2);
    expect(scopes.remaining("a", 0)).toBe(0);
    expect(scopes.remaining(null, 0)).toBe(0);
    scopes.set("d", 5_000, 2_500);
    expect(scopes.remaining("b", 2_500)).toBe(0);
    expect(scopes.remaining("c", 2_500)).toBe(500);
    expect(scopes.remaining("d", 2_500)).toBe(2_500);
  });
});
