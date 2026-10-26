/**
 * Opaque management targets: one provider, seen from the backend user or from
 * one environment.
 *
 * A target id carries no path. It names the provider, and for an environment
 * its id plus an incarnation derived from its creation time, so a stale id can
 * never address a replacement environment that happens to reuse a name. A
 * backend-user id is bound to this backend's instance identity, so an id minted
 * by another backend (a remote one the client also talks to) is refused rather
 * than silently addressing this backend's user files.
 */

import { createHash } from "node:crypto";

import {
  AGENT_PLATFORMS,
  isAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { mcpFailure, type McpTargetContext } from "@orkestrator/protocol/mcp-management";

import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";

import type { Environment, Project } from "../models.js";
import { resolveEnvironmentExecutionPolicy } from "../native-agent-execution-policy.js";
import type { PreviewServicesStorage } from "../storage-preview-services.js";
import type { TargetContextInfo } from "./types.js";

export interface TargetStorage {
  getEnvironment(id: string): Promise<Environment | null>;
  getProject(id: string): Promise<Project | null>;
  previewServices: Pick<PreviewServicesStorage, "getPreviewBackendIdentity">;
}

export interface ResolvedTarget {
  targetId: string;
  provider: AgentPlatform;
  info: TargetContextInfo;
  context: McpTargetContext;
  environment?: Environment;
  readOnlyReason?: string;
  /** Container targets: `/workspace` is a persistent volume, so project files survive rebuilds. */
  persistentWorkspace?: boolean;
}

const PREFIX = "mcp1";

function incarnation(environment: Environment): string {
  return createHash("sha256")
    .update(`${environment.id}\u0000${environment.createdAt}`)
    .digest("base64url")
    .slice(0, 10);
}

function backendBinding(instanceId: string): string {
  return createHash("sha256")
    .update(`mcp-target\u0000${instanceId}`)
    .digest("base64url")
    .slice(0, 12);
}

export function backendTargetId(provider: AgentPlatform, instanceId: string): string {
  return `${PREFIX}~${provider}~backend~${backendBinding(instanceId)}`;
}

export function environmentTargetId(provider: AgentPlatform, environment: Environment): string {
  return `${PREFIX}~${provider}~env~${environment.id}~${incarnation(environment)}`;
}

export const CONTAINER_NOT_CREATED_REASON =
  "This environment has no container yet; start it to edit its configuration.";

function backendTarget(provider: AgentPlatform, instanceId: string): ResolvedTarget {
  return {
    targetId: backendTargetId(provider, instanceId),
    provider,
    info: { kind: "backend", location: "backend-host" },
    context: {
      kind: "backend",
      location: "backend-host",
      locationLabel: "This backend's user account",
    },
  };
}

async function environmentTarget(
  provider: AgentPlatform,
  environment: Environment,
  storage: TargetStorage,
): Promise<ResolvedTarget> {
  const project = await storage.getProject(environment.projectId).catch(() => null);
  const local = environment.environmentType === "local";
  const info: TargetContextInfo = {
    kind: "environment",
    environmentId: environment.id,
    environmentName: environment.name,
    projectId: environment.projectId,
    projectName: project?.name,
    location: local ? "local-worktree" : "container",
    worktreePath: local ? environment.worktreePath : undefined,
    containerId: local ? undefined : (environment.containerId ?? undefined),
    environmentStatus: environment.status,
    ...(local
      ? {
          projectResources: resolveEnvironmentExecutionPolicy(environment, "interactive-native")
            .projectResources,
        }
      : {}),
  };
  let readOnlyReason: string | undefined;
  if (!local && !environment.containerId) readOnlyReason = CONTAINER_NOT_CREATED_REASON;
  else if (local && !environment.worktreePath)
    readOnlyReason = "This environment has no worktree yet.";
  const lifecycle = local ? null : parseContainerLifecycle(environment.containerLifecycle);
  return {
    targetId: environmentTargetId(provider, environment),
    provider,
    info,
    environment,
    readOnlyReason,
    ...(lifecycle
      ? {
          persistentWorkspace:
            lifecycle.supported && lifecycle.record.storage.format === "volume-v1",
        }
      : {}),
    context: {
      kind: "environment",
      environmentId: environment.id,
      environmentName: environment.name,
      projectId: environment.projectId,
      projectName: project?.name,
      location: info.location,
      locationLabel: local
        ? `Worktree of ${environment.name} on this backend`
        : `Container of ${environment.name}`,
    },
  };
}

function usableEnvironment(environment: Environment | null): environment is Environment {
  return !!environment && !environment.deletionRequestedAt;
}

export async function resolveTarget(
  targetId: unknown,
  storage: TargetStorage,
): Promise<ResolvedTarget> {
  if (typeof targetId !== "string" || targetId.length > 512) throw mcpFailure("unknown-target");
  const parts = targetId.split("~");
  if (parts[0] !== PREFIX || !isAgentPlatform(parts[1])) throw mcpFailure("unknown-target");
  const provider = parts[1];
  if (parts.length === 4 && parts[2] === "backend") {
    const { instanceId } = await storage.previewServices.getPreviewBackendIdentity();
    if (parts[3] !== backendBinding(instanceId)) throw mcpFailure("unknown-target");
    return backendTarget(provider, instanceId);
  }
  if (parts.length === 5 && parts[2] === "env") {
    const environment = await storage.getEnvironment(parts[3]!);
    if (!usableEnvironment(environment) || incarnation(environment) !== parts[4])
      throw mcpFailure("unknown-target");
    return environmentTarget(provider, environment, storage);
  }
  throw mcpFailure("unknown-target");
}

export async function listTargets(
  storage: TargetStorage,
  environmentId?: string,
): Promise<ResolvedTarget[]> {
  const { instanceId } = await storage.previewServices.getPreviewBackendIdentity();
  const targets = AGENT_PLATFORMS.map((provider) => backendTarget(provider, instanceId));
  if (environmentId) {
    const environment = await storage.getEnvironment(environmentId);
    if (!usableEnvironment(environment))
      throw mcpFailure("unknown-target", { message: "The environment no longer exists." });
    for (const provider of AGENT_PLATFORMS)
      targets.push(await environmentTarget(provider, environment, storage));
  }
  return targets;
}
