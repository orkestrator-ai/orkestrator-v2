import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  normalizeUsageIdentity,
  type UsageIdentity,
} from "@orkestrator/protocol/agent-account-shared-usage";
import type {
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

import { AgentAccountAutoSwitcher } from "./agent-accounts-auto-switch.js";
import { AgentAccountSharedUsage } from "./agent-accounts-shared-usage.js";
import { shareAndMergeUsage } from "./agent-accounts-usage-sharing.js";
import { eventSink } from "./backend-emit.js";
import type { CommandContext } from "./commands-context.js";

/**
 * Automatic switching on the newest reading of each login from any machine
 * (docs/architecture/agent-accounts.md, "Shared readings"). `readUsage` is the
 * real merge (`shareAndMergeUsage`) over a fake local reader, so the switcher
 * sees exactly what `readAgentAccountUsage` would answer.
 */

const NOW = Date.parse("2026-11-08T12:00:00Z");
const MINUTE = 60_000;
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function weekly(used: number, resetsInHours: number, minutesAgo = 0, stale = false) {
  return {
    platform: "claude",
    status: "ok",
    windows: [{ window: "seven_day", usedPercent: used, resetsAt: inHours(resetsInHours) }],
    ...(stale ? { stale: true } : {}),
    fetchedAt: new Date(NOW - minutesAgo * MINUTE).toISOString(),
  } satisfies PlanUsageSnapshot;
}

async function harness(options: {
  /** What this machine reads for each account before a renewal, and after one. */
  local: Record<string, { before: PlanUsageSnapshot; after?: PlanUsageSnapshot }>;
}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ork-auto-switch-shared-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const context = {
    storage: { agentAccounts: { agentAccountsDirectory: () => dir } },
    runtime: { accounts: { sharedUsage: new AgentAccountSharedUsage() } },
    emit: eventSink(() => undefined),
    nodes: {
      selfIdentity: async () => "bk_omarchy",
      selfProfile: async () => ({ displayName: "omarchy-hp" }),
    },
  } as unknown as CommandContext;
  const identities: Record<string, UsageIdentity> = {
    trading: normalizeUsageIdentity("claude", "618BTrading@gmail.com", "org-1")!,
    dev: normalizeUsageIdentity("claude", "arktechdev@example.com", "org-2")!,
  };
  const summaries = Object.keys(options.local).map(
    (id): AgentAccountSummary => ({
      id,
      platform: "claude",
      label: id,
      isDefault: false,
      isActive: false,
      signedIn: true,
      identity: { email: identities[id]!.email },
    }),
  );
  const state = { active: "trading" };
  const renewed = new Set<string>();
  const renewLogin = mock(async (_platform: AgentAccountPlatform, accountId: string) => {
    renewed.add(accountId);
    return true;
  });
  const snapshot = (): AgentAccountsSnapshot => ({
    accounts: summaries,
    active: { claude: state.active, codex: "default" },
    autoSwitch: { claude: { mode: "automatic", includedAccountIds: Object.keys(options.local) } },
  });
  const switcher = new AgentAccountAutoSwitcher({
    settings: async () => ({ claude: { enabled: true, excludedEmails: [] } }),
    snapshot: async () => snapshot(),
    readUsage: async (_platform, accountId) => {
      const entry = options.local[accountId]!;
      const local = renewed.has(accountId) ? (entry.after ?? entry.before) : entry.before;
      return shareAndMergeUsage(context, identities[accountId], local, NOW);
    },
    renewLogin,
    switchAccount: async (_platform, accountId) => {
      state.active = accountId;
      return true;
    },
    sessionAccount: async () => null,
    bridgeBusy: async () => false,
    notify: () => undefined,
    now: () => NOW,
  });
  /** Another machine read `id`'s login `minutesAgo`, and the command node shared it here. */
  const sharedFromBeelink = (id: string, reading: PlanUsageSnapshot) =>
    context.runtime.accounts.sharedUsage.record(
      dir,
      [
        {
          identity: identities[id]!,
          windows: reading.windows,
          fetchedAt: reading.fetchedAt,
          source: { nodeId: "bk_beelink", nodeName: "beelink" },
        },
      ],
      NOW,
    );
  return { switcher, state, renewLogin, sharedFromBeelink };
}

describe("automatic switching on shared readings", () => {
  test("a fresh reading from another machine counts as fresh, so no renewal is needed", async () => {
    // The active login is at its weekly threshold. The other login's token has
    // lapsed here, so its own reading is the one from two and a half days ago.
    const h = await harness({
      local: {
        trading: { before: weekly(99, 10) },
        dev: { before: weekly(31, 20, 2.5 * 24 * 60, true), after: weekly(31, 20) },
      },
    });
    await h.sharedFromBeelink("dev", weekly(45, 20, 1));
    await h.switcher.evaluate("claude");
    expect(h.renewLogin).not.toHaveBeenCalled();
    expect(h.state.active).toBe("dev");
  });

  test("a fresh shared reading that the login is used up keeps the machine off it", async () => {
    // On 2026-11-08 omarchy-hp moved on a 2.5-day-old 31% reading of a login
    // another machine had just read at 100%.
    const h = await harness({
      local: {
        trading: { before: weekly(99, 10) },
        dev: { before: weekly(31, 20, 2.5 * 24 * 60, true), after: weekly(31, 20) },
      },
    });
    await h.sharedFromBeelink("dev", weekly(100, 20, 1));
    await h.switcher.evaluate("claude");
    expect(h.renewLogin).not.toHaveBeenCalled();
    expect(h.state.active).toBe("trading");
  });

  test("with no fresh reading anywhere, the login is still renewed before a switch", async () => {
    const h = await harness({
      local: {
        trading: { before: weekly(99, 10) },
        dev: { before: weekly(31, 20, 2.5 * 24 * 60, true), after: weekly(50, 20) },
      },
    });
    // Another machine read it too, but not within the switcher's five minutes.
    await h.sharedFromBeelink("dev", weekly(40, 20, 45));
    await h.switcher.evaluate("claude");
    expect(h.renewLogin.mock.calls.map(([, accountId]) => accountId)).toEqual(["dev"]);
    expect(h.state.active).toBe("dev");
  });
});
