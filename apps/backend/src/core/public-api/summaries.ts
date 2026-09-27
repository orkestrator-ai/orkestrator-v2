import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  encodePublicSessionId,
  nativeTabLogicalSessionKey,
  type PublicEnvironmentSummary,
  type PublicProjectSummary,
  type PublicSessionActivity,
  type PublicSessionSummary,
} from "@orkestrator/protocol/public-api-resources";
import type { Environment, PersistedNativeAgentSession, Project } from "../models.js";
import { environmentSettingsRevision, projectRevision } from "./revisions.js";

/**
 * Allowlisted public projections. Anything not named here — initial prompts,
 * attachments, provider session IDs, request fingerprints, PIDs, raw
 * configuration — never leaves the backend through the public contract.
 */

export function publicProjectSummary(
  project: Project,
  environmentCount: number,
): PublicProjectSummary {
  return {
    id: project.id,
    name: project.name,
    gitUrl: project.gitUrl,
    localPath: project.localPath ?? null,
    folder: project.folder ?? null,
    addedAt: project.addedAt,
    order: project.order,
    revision: projectRevision(project),
    environmentCount,
  };
}

export function isEnvironmentReady(environment: Environment): boolean {
  return (
    environment.status === "running" &&
    (environment.setupPhase === "ready" ||
      environment.setupScriptsComplete === true ||
      environment.setupOverride === true)
  );
}

export function publicEnvironmentSummary(environment: Environment): PublicEnvironmentSummary {
  const startup = environment.startupAgentSession;
  const startupAgent = startup && isAgentPlatform(startup.agent) ? startup.agent : null;
  return {
    id: environment.id,
    projectId: environment.projectId,
    name: environment.name,
    branch: environment.branch,
    environmentType: environment.environmentType === "local" ? "local" : "container",
    status: environment.status,
    ready: isEnvironmentReady(environment),
    setup: {
      phase: environment.setupPhase ?? (environment.setupScriptsComplete ? "ready" : "pending"),
      complete: environment.setupPhase === "ready" || environment.setupScriptsComplete === true,
      overridden: environment.setupOverride === true,
      ...(environment.setupStartedAt ? { startedAt: environment.setupStartedAt } : {}),
      ...(environment.setupCompletedAt ? { completedAt: environment.setupCompletedAt } : {}),
    },
    lifecycle: {
      operation: environment.lifecycleOperation ?? null,
      error: environment.lifecycleError ?? null,
      deletionRequested: Boolean(environment.deletionRequestedAt),
    },
    activity: {
      state: environment.agentActivityState ?? null,
      hasUnreadWork: environment.hasUnreadWork === true,
    },
    pendingAgentLaunch: environment.pendingAgentLaunch === true,
    startupSession:
      startup && startupAgent
        ? {
            sessionId: encodePublicSessionId(environment.id, "startup-agent"),
            agent: startupAgent,
            status: startup.status,
            ...(startup.error ? { error: startup.error.slice(0, 500) } : {}),
          }
        : null,
    workspacePath:
      environment.environmentType === "local" ? (environment.worktreePath ?? null) : null,
    base: {
      branch: environment.delegationBaseBranch ?? null,
      commit: environment.createdFromCommit ?? environment.delegationBaseCommit ?? null,
    },
    pr: { url: environment.prUrl ?? null, state: environment.prState ?? null },
    createdAt: environment.createdAt,
    lastActivityAt: environment.lastActivityAt ?? null,
    settingsRevision: environmentSettingsRevision(environment),
  };
}

export interface NativeTabInfo {
  tabId: string;
  agent: AgentPlatform;
  title: string | null;
  hasProviderSession: boolean;
}

/** Native-agent tabs of a backend-owned pane layout. */
export function nativeTabsOfLayout(layout: unknown): NativeTabInfo[] {
  const tabs: NativeTabInfo[] = [];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const visit = (node: unknown, depth: number): void => {
    if (!isRecord(node) || depth > 64) return;
    if (node.kind === "leaf" && Array.isArray(node.tabs)) {
      for (const tab of node.tabs) {
        if (!isRecord(tab) || typeof tab.id !== "string" || tab.type !== "agent-native") continue;
        const native = isRecord(tab.nativeAgentData) ? tab.nativeAgentData : null;
        if (!native || !isAgentPlatform(native.platform)) continue;
        tabs.push({
          tabId: tab.id,
          agent: native.platform,
          title: typeof tab.displayTitle === "string" ? tab.displayTitle.slice(0, 200) : null,
          hasProviderSession: typeof native.sessionId === "string" && native.sessionId.length > 0,
        });
      }
      return;
    }
    if (node.kind === "split" && Array.isArray(node.children)) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  if (isRecord(layout)) visit(layout.root, 0);
  return tabs;
}

export function publicSessionSummary(
  environmentId: string,
  tab: NativeTabInfo,
  session: PersistedNativeAgentSession | null,
  activity: PublicSessionActivity,
  pendingInteractionCount: number | null,
): PublicSessionSummary {
  const pending = session?.pendingSteer
    ? { requestId: session.pendingSteer.requestId, kind: "steer" as const }
    : session?.pendingDispatch
      ? { requestId: session.pendingDispatch.requestId, kind: "prompt" as const }
      : null;
  const createdAt = session?.pendingDispatch?.createdAt;
  const parkedAgeMs = createdAt ? Date.now() - Date.parse(createdAt) : Number.POSITIVE_INFINITY;
  return {
    id: encodePublicSessionId(environmentId, tab.tabId),
    environmentId,
    tabId: tab.tabId,
    agent: tab.agent,
    title: tab.title,
    hasProviderSession: tab.hasProviderSession || Boolean(session?.providerSessionId),
    activity,
    latestRequestId: session?.dispatchedRequestIds?.at(-1) ?? null,
    recoverableDispatch: pending
      ? {
          ...pending,
          status:
            pending.kind === "prompt" && parkedAgeMs < 15_000 ? "reconciling" : "action-required",
        }
      : null,
    pendingInteractionCount,
    createdAt: session?.createdAt ?? null,
    updatedAt: session?.updatedAt ?? null,
  };
}

export function logicalKey(environmentId: string, tabId: string): string {
  return nativeTabLogicalSessionKey(environmentId, tabId);
}
