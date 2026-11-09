/**
 * This machine's side of shared usage readings (docs/architecture/agent-accounts.md,
 * "Shared readings"): every fresh reading it takes of a matchable login is kept
 * as that login's newest reading and announced, and every account's usage is
 * answered with the newer of its own reading and the shared one.
 *
 * The leaf-side commands a command node calls over its link,
 * `collect_shared_usage_readings` and `apply_shared_usage_readings`, are here
 * too. The command node's side is `nodes/node-usage-sync.ts`.
 *
 * Nothing here sees a credential: identities are provider, email and
 * organisation id, and readings are rebuilt from usage fields only.
 */
import { agentUsageReadingsChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import {
  newestPlanUsage,
  parseSharedUsageReadings,
  planUsageSnapshotFromSharedReading,
  sharedUsageReadingFromSnapshot,
  usageIdentityKey,
  type SharedUsageCollect,
  type SharedUsageReading,
  type UsageIdentity,
} from "@orkestrator/protocol/agent-account-shared-usage";
import type { PlanUsageReadingSource, PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { createLogger } from "@orkestrator/protocol/logger";

import type { CommandContext } from "./commands-context.js";

const log = createLogger("agent-accounts");

/** Stands in for the node identity of a backend that has no node service (tests, tools). */
const STANDALONE_SOURCE: PlanUsageReadingSource = { nodeId: "local", nodeName: "This machine" };

function accountsRoot(context: CommandContext): string {
  return context.storage.agentAccounts.agentAccountsDirectory();
}

/** This machine, as the source of the readings it takes. */
export async function usageReadingSource(context: CommandContext): Promise<PlanUsageReadingSource> {
  const nodes = context.nodes;
  if (!nodes) return STANDALONE_SOURCE;
  try {
    const [nodeId, profile] = await Promise.all([nodes.selfIdentity(), nodes.selfProfile()]);
    return { nodeId, nodeName: profile.displayName || nodeId };
  } catch {
    return STANDALONE_SOURCE;
  }
}

function announce(
  context: CommandContext,
  identities: Iterable<UsageIdentity>,
  origin: "local" | "shared",
): void {
  const byPlatform = new Map<AgentAccountPlatform, Set<string>>();
  for (const identity of identities) {
    let emails = byPlatform.get(identity.platform);
    if (!emails) byPlatform.set(identity.platform, (emails = new Set()));
    emails.add(identity.email);
  }
  for (const [platform, emails] of byPlatform) {
    context.emit(agentUsageReadingsChangedEvent, { platform, origin, emails: Array.from(emails) });
  }
  if (origin === "local") context.usageSync?.noteLocalChange();
}

/**
 * Keep a fresh reading this machine took as its login's newest, and answer
 * the newer of `snapshot` and the login's shared reading. `snapshot` is what
 * this machine would otherwise answer: a fresh reading, a last known one
 * marked stale, or a failure. A login with no matchable identity is answered
 * as it is.
 */
export async function shareAndMergeUsage(
  context: CommandContext,
  identity: UsageIdentity | undefined,
  snapshot: PlanUsageSnapshot,
  now: number,
): Promise<PlanUsageSnapshot> {
  if (!identity) return snapshot;
  const root = accountsRoot(context);
  const store = context.runtime.accounts.sharedUsage;
  const source = await usageReadingSource(context);
  const reading = sharedUsageReadingFromSnapshot(identity, snapshot, source, now);
  if (reading) {
    try {
      const kept = await store.record(root, [reading], now);
      if (kept.length > 0) announce(context, [identity], "local");
    } catch {
      log.warn("shared-usage.record-failed", { platform: identity.platform });
    }
  }
  const shared = await store.get(root, identity).catch(() => undefined);
  return newestPlanUsage(
    snapshot,
    shared ? planUsageSnapshotFromSharedReading(shared, source.nodeId, now) : undefined,
  );
}

/** `collect_shared_usage_readings`: this machine's logins and its newest reading of each. */
export async function collectSharedUsageReadings(
  context: CommandContext,
  identities: readonly UsageIdentity[],
): Promise<SharedUsageCollect> {
  const keys = new Set(identities.map(usageIdentityKey));
  const readings = (await context.runtime.accounts.sharedUsage.all(accountsRoot(context))).filter(
    (reading) => keys.has(usageIdentityKey(reading.identity)),
  );
  return { identities: [...identities], readings };
}

/**
 * `apply_shared_usage_readings`: keep each reading newer than this machine's
 * for a login it has. Settings is told to read again; the command node is not
 * told, because it sent them.
 */
export async function applySharedUsageReadings(
  context: CommandContext,
  identities: readonly UsageIdentity[],
  readings: unknown,
  now: number = Date.now(),
): Promise<{ applied: number }> {
  const kept = await context.runtime.accounts.sharedUsage.record(
    accountsRoot(context),
    parseSharedUsageReadings(readings, now),
    now,
    new Set(identities.map(usageIdentityKey)),
  );
  if (kept.length > 0) {
    announce(
      context,
      kept.map((reading) => reading.identity),
      "shared",
    );
  }
  return { applied: kept.length };
}

/**
 * A command node's own store is the central copy: it keeps every identity, so
 * a machine that reconnects while the one that read a login is offline still
 * gets the reading.
 */
export async function recordCentralUsageReadings(
  context: CommandContext,
  readings: readonly SharedUsageReading[],
  ownIdentities: readonly UsageIdentity[],
  now: number = Date.now(),
): Promise<number> {
  const kept = await context.runtime.accounts.sharedUsage.record(
    accountsRoot(context),
    readings,
    now,
  );
  const own = new Set(ownIdentities.map(usageIdentityKey));
  const shown = kept.filter((reading) => own.has(usageIdentityKey(reading.identity)));
  if (shown.length > 0) {
    announce(
      context,
      shown.map((reading) => reading.identity),
      "shared",
    );
  }
  return kept.length;
}

/** Every reading a command node holds centrally. */
export function centralUsageReadings(context: CommandContext): Promise<SharedUsageReading[]> {
  return context.runtime.accounts.sharedUsage.all(accountsRoot(context));
}
