/**
 * Resolves the durable `ArtifactOwner` of an authenticated agent tool call.
 *
 * Ownership comes only from backend-issued bindings:
 * - A tab-scoped credential names its tab; the conversation is the native
 *   logical session key `env-<environmentId>:<tabId>`, so reopening the
 *   conversation in another tab (same logical key) recovers its artifacts.
 * - An environment-wide credential (OpenCode's shared registration, container
 *   or bridge fallbacks) cannot identify a conversation by itself and must
 *   present a backend-minted artifact grant as `scopeCapability`.
 * Workflow-result credentials never reach this code (their restricted server
 * branches return first) and are refused here as a second line.
 *
 * Caller-supplied project, environment or conversation identifiers are never
 * accepted as proof of ownership.
 */
import {
  ArtifactFailure,
  artifactError,
  type ArtifactOwner,
} from "@orkestrator/protocol/transcript-artifacts";
import type { ArtifactGrantService, ArtifactGrantVerb } from "./grants.js";

export interface ArtifactCallerScope {
  environmentId: string;
  projectId: string;
  tabId?: string;
  workflowResultKey?: string;
  workflowResultBroker?: boolean;
}

export interface ResolvedArtifactCaller {
  owner: ArtifactOwner;
  /** Dispatched turn, when known (grant binding or dispatch hook). */
  turnId?: string;
  providerSessionId?: string;
  via: "tab" | "grant";
}

export function conversationKeyForTab(environmentId: string, tabId: string): string {
  return `env-${environmentId}:${tabId}`;
}

function denied(message: string): ArtifactFailure {
  return new ArtifactFailure(
    artifactError("policy_denied", message, {
      retryClass: "never",
      suggestion:
        "Use the scopeCapability given in this turn's Orkestrator instructions, or call from a session-bound connection.",
    }),
  );
}

export function resolveArtifactCaller(
  scope: ArtifactCallerScope,
  scopeCapability: string | undefined,
  verb: ArtifactGrantVerb,
  deps: {
    backendId: string;
    grants: ArtifactGrantService;
    /** Current dispatched turn of a session-bound conversation, when known. */
    currentTurn?: (environmentId: string, conversationKey: string) => string | null | undefined;
  },
): ResolvedArtifactCaller {
  if (scope.workflowResultKey || scope.workflowResultBroker) {
    throw denied("Workflow result credentials cannot use artifact tools");
  }
  const tabConversation = scope.tabId
    ? conversationKeyForTab(scope.environmentId, scope.tabId)
    : null;
  if (scopeCapability !== undefined && scopeCapability !== "") {
    const binding = deps.grants.verify(scopeCapability, scope, verb);
    if (!binding) throw denied("The artifact scope capability is invalid, expired, or revoked");
    if (tabConversation && binding.owner.conversationKey !== tabConversation) {
      throw denied("The artifact scope capability belongs to another conversation");
    }
    return {
      owner: binding.owner,
      turnId: binding.turnId,
      ...(binding.providerSessionId ? { providerSessionId: binding.providerSessionId } : {}),
      via: "grant",
    };
  }
  if (!tabConversation) {
    throw denied("This shared connection requires the scopeCapability argument for artifact tools");
  }
  const turnId = deps.currentTurn?.(scope.environmentId, tabConversation) ?? undefined;
  return {
    owner: {
      backendId: deps.backendId,
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      conversationKey: tabConversation,
    },
    ...(turnId ? { turnId } : {}),
    via: "tab",
  };
}

/** Same `not_found` for missing records and records outside the caller's scope. */
export function ownsRecord(owner: ArtifactOwner, record: { owner: ArtifactOwner }): boolean {
  return (
    record.owner.backendId === owner.backendId &&
    record.owner.environmentId === owner.environmentId &&
    record.owner.projectId === owner.projectId &&
    record.owner.conversationKey === owner.conversationKey
  );
}

export function notFound(what = "Artifact"): ArtifactFailure {
  return new ArtifactFailure(artifactError("not_found", `${what} not found`));
}
