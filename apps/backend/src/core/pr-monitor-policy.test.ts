import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PR_MONITOR_POLICY,
  PrCooldownScopes,
  backgroundDelay,
  classifyPrDetectionFailure,
  detectionPriority,
  isPrNetworkFailure,
  networkHold,
  rateLimitCooldown,
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
  test("a quiet open PR polls at the quiet cadence, never while errors back off", () => {
    expect(delay({ quiet: true })).toBe(policy.quietIntervalMs);
    expect(delay({ quiet: true, random: 0.5 })).toBe(
      policy.quietIntervalMs + Math.floor(0.5 * policy.quietJitterMs),
    );
    expect(delay({ quiet: true, consecutiveErrors: 1 })).toBe(40_000);
    // Only an open PR can be quiet.
    expect(delay({ policy: "create-pending", mode: "create-pending", quiet: true })).toBe(5_000);
    expect(resolvePrMonitorPolicy({ quietIntervalMs: 1 }).quietIntervalMs).toBe(20_000);
  });

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

  test("recognises a check that could not reach GitHub, and nothing else", () => {
    const network = (error: unknown) =>
      isPrNetworkFailure(error, classifyPrDetectionFailure(error));
    expect(
      network(
        new CommandFailedError("error connecting to api.github.com", {
          stderr: "error connecting to api.github.com\ncheck your internet connection",
          exitCode: 1,
        }),
      ),
    ).toBe(true);
    expect(network(new Error("dial tcp: lookup api.github.com: i/o timeout"))).toBe(true);
    expect(network(new CommandFailedError("Command failed", { timedOut: true }))).toBe(true);
    // Refusals and ordinary failures are not outages.
    expect(network(new Error("GraphQL: API rate limit exceeded for user"))).toBe(false);
    expect(network(new Error("HTTP 404: Not Found"))).toBe(false);
    expect(network(new CommandFailedError("Command failed", { exitCode: 1 }))).toBe(false);
    expect(network(undefined)).toBe(false);
  });

  test("a network hold doubles per failure in a row up to its cap", () => {
    expect(networkHold(0, policy)).toBe(30_000);
    expect(networkHold(1, policy)).toBe(30_000);
    expect(networkHold(2, policy)).toBe(60_000);
    expect(networkHold(4, policy)).toBe(240_000);
    expect(networkHold(5, policy)).toBe(300_000);
    expect(networkHold(40, policy)).toBe(300_000);
    expect(
      resolvePrMonitorPolicy({ networkHoldMs: 10_000, networkHoldMaxMs: 1 }).networkHoldMaxMs,
    ).toBe(10_000);
  });

  test("a scope is released only by a check that started after its latest strike", () => {
    const scopes = new PrCooldownScopes(4);
    scopes.strike("local", 3, 5);
    scopes.set("local", 1_000, 0);
    expect(scopes.release("local", 5, 0)).toBe(false);
    expect(scopes.remaining("local", 0)).toBe(1_000);
    // Reports that a hold still running ended, so its postponed checks resume.
    expect(scopes.release("local", 6, 0)).toBe(true);
    expect(scopes.remaining("local", 0)).toBe(0);
    // With the strike gone, the next failure starts afresh.
    expect(scopes.strike("local", 7, 7)).toBe(1);
    // Releasing a scope with no hold, or one already run out, ends nothing.
    expect(scopes.release("local", 8, 0)).toBe(false);
    scopes.set("local", 2_000, 1_000);
    expect(scopes.release("local", 9, 2_000)).toBe(false);
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

  test("rate-limit cooldowns double per rate limit in a row, capped; boundary timing wins", () => {
    expect([1, 2, 3, 4, 5, 6].map((strikes) => rateLimitCooldown(null, strikes, policy))).toEqual([
      2 * 60_000,
      4 * 60_000,
      8 * 60_000,
      16 * 60_000,
      30 * 60_000,
      30 * 60_000,
    ]);
    expect(rateLimitCooldown(null, 0, policy)).toBe(2 * 60_000);
    expect(rateLimitCooldown(7 * 60_000, 5, policy)).toBe(7 * 60_000);
    expect(rateLimitCooldown(3 * 60 * 60_000, 1, policy)).toBe(policy.maxRetryAfterMs);
    // The cap never undercuts the base cooldown.
    const longBase = resolvePrMonitorPolicy({
      rateLimitCooldownMs: 40 * 60_000,
      rateLimitCooldownMaxMs: 60_000,
    });
    expect(rateLimitCooldown(null, 3, longBase)).toBe(40 * 60_000);
  });

  test("cooldown scopes count rate limits in a row per scope, bounded", () => {
    const scopes = new PrCooldownScopes(2);
    expect(scopes.strike("a")).toBe(1);
    expect(scopes.strike("a")).toBe(2);
    expect(scopes.strike("b")).toBe(1);
    scopes.clearStrikes("a");
    expect(scopes.strike("a")).toBe(1);
    // A third scope evicts the least recently struck one.
    expect(scopes.strike("c")).toBe(1);
    expect(scopes.strike("b")).toBe(1);
    scopes.clear();
    expect(scopes.strike("c")).toBe(1);
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
