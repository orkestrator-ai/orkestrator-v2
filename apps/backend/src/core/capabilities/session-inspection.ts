import {
  CAPABILITY_TARGET_STATUSES,
  CAPABILITY_VERIFICATION_LEVELS,
  type CapabilityTarget,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilityVerification } from "@orkestrator/protocol/capability-resources-api";
import { getCapabilityNodeEnvironmentObservationCommand } from "@orkestrator/protocol/contract/domains/capabilities";

import { parseLeafScopedReport, scopedEvidenceFromReport } from "./launch-authority.js";
import type { AccountEntryState, ScopedEvidence } from "./scoped-delivery.js";
import { parseTarget } from "./service-args.js";
import type { CapabilityServiceContext } from "./service-context.js";
import type { CapabilityLaunchRecord, CapabilityState } from "./types.js";

export function matchingCapabilityLaunch(state: CapabilityState, target: CapabilityTarget) {
  if (!target.sessionId) return undefined;
  const launch =
    state.launches[`${target.nodeId}|${target.sessionId}`] ?? state.launches[target.sessionId];
  if (
    launch?.target.nodeId !== target.nodeId ||
    launch.target.provider !== target.provider ||
    launch.target.environmentId !== target.environmentId
  )
    return undefined;
  return launch;
}

export async function localCapabilitySessionTarget(
  ctx: CapabilityServiceContext,
  target: CapabilityTarget,
  launch: CapabilityLaunchRecord | undefined,
): Promise<CapabilityTarget> {
  const environment = target.environmentId
    ? (await ctx.deps.scoped?.environments?.())?.find((entry) => entry.id === target.environmentId)
    : undefined;
  const { environmentIncarnation, accountHomeId, ...rest } = launch?.target ?? target;
  const incarnation =
    environment && environment.environmentType !== "local"
      ? (environment.containerId ?? environment.id)
      : environmentIncarnation;
  const account = accountHomeId ?? (await ctx.deps.sessionAccountHome?.(target));
  return {
    ...rest,
    ...(environment ? { projectId: environment.projectId } : {}),
    ...(incarnation ? { environmentIncarnation: incarnation } : {}),
    ...(account && !incarnation ? { accountHomeId: account } : {}),
  };
}

export interface InspectedCapabilitySession {
  target: CapabilityTarget;
  evidence?: ScopedEvidence;
  launch?: CapabilityLaunchRecord;
  remote?: {
    checks: CapabilityVerification["checks"];
  };
}

/** A session is inspected on its owning machine. Unavailable owners supply no file evidence. */
export async function inspectCapabilitySession(
  ctx: CapabilityServiceContext,
  state: CapabilityState,
  requested: CapabilityTarget,
  componentIds?: readonly string[],
): Promise<InspectedCapabilitySession> {
  let launch = matchingCapabilityLaunch(state, requested);
  const controllerId = await ctx.deps.selfId();
  if (requested.nodeId === controllerId) {
    const target = await localCapabilitySessionTarget(ctx, requested, launch);
    if (target.environmentIncarnation !== launch?.target.environmentIncarnation) launch = undefined;
    const evidence = await ctx.scoped.readEvidence(target);
    return { target, ...(evidence ? { evidence } : {}), ...(launch ? { launch } : {}) };
  }

  const remoteEnvironment = requested.environmentId
    ? (await ctx.deps.remoteEnvironments?.(requested.nodeId).catch(() => null))?.find(
        (entry) => entry.id === requested.environmentId,
      )
    : undefined;
  const target = launch?.target ?? {
    ...requested,
    ...(remoteEnvironment && remoteEnvironment.environmentType !== "local"
      ? { environmentIncarnation: remoteEnvironment.containerId ?? remoteEnvironment.id }
      : {}),
  };
  const link = ctx.deps.link(requested.nodeId);
  if (!link?.connected || !requested.environmentId || !requested.sessionId) {
    return { target, ...(launch ? { launch } : {}) };
  }
  const answer = await link
    .invokeCommand(getCapabilityNodeEnvironmentObservationCommand, {
      controllerId,
      epoch: state.epoch,
      environments: [
        {
          environmentId: requested.environmentId,
          capabilitySession: {
            requested,
            ...(componentIds ? { componentIds: [...componentIds] } : {}),
          },
        },
      ],
    })
    .catch(() => undefined);
  const row = (
    answer as
      | {
          capabilitySession?: {
            target?: CapabilityTarget;
            scoped?: unknown;
            account?: { entries?: Record<string, unknown>; observed?: Record<string, unknown> };
            checks?: CapabilityVerification["checks"];
          };
        }
      | undefined
  )?.capabilitySession;
  const owner = row?.target ? parseTarget(row.target, "") : undefined;
  if (
    !row ||
    !owner ||
    owner.nodeId !== requested.nodeId ||
    owner.environmentId !== requested.environmentId ||
    owner.provider !== requested.provider ||
    owner.sessionId !== requested.sessionId
  ) {
    return { target, ...(launch ? { launch } : {}) };
  }
  if (launch?.target.environmentIncarnation !== owner.environmentIncarnation) launch = undefined;
  const evidence = scopedEvidenceFromReport(state, owner, parseLeafScopedReport(row.scoped)) ?? {};
  if (owner.accountHomeId && row.account?.entries && row.account.observed) {
    const entries: Record<string, AccountEntryState> = {};
    for (const [id, value] of Object.entries(row.account.entries).slice(0, 32)) {
      if (
        value === "linked" ||
        value === "private" ||
        value === "missing" ||
        value === "foreign-link"
      )
        entries[id] = value;
    }
    const observed = new Map<string, string | null>();
    for (const receipt of Object.values(state.receipts)) {
      if (receipt.nodeId !== owner.nodeId || receipt.accountHomeId !== owner.accountHomeId)
        continue;
      const digest = row.account.observed[receipt.id];
      if (digest === null || (typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest))) {
        observed.set(receipt.id, digest);
      }
    }
    evidence.account = {
      accountHomeId: owner.accountHomeId,
      provider: owner.provider,
      entries,
      observed,
    };
  }
  const checks = Array.isArray(row.checks)
    ? row.checks
        .slice(0, componentIds?.length)
        .filter(
          (entry) =>
            entry &&
            componentIds?.includes(entry.componentId) &&
            ([...CAPABILITY_VERIFICATION_LEVELS, "unverified"] as readonly string[]).includes(
              entry.level,
            ) &&
            (CAPABILITY_TARGET_STATUSES as readonly string[]).includes(entry.status) &&
            typeof entry.detail === "string" &&
            entry.detail.length <= 512,
        )
    : undefined;
  return {
    target: owner,
    ...(evidence ? { evidence } : {}),
    ...(launch ? { launch } : {}),
    ...(checks ? { remote: { checks } } : {}),
  };
}
