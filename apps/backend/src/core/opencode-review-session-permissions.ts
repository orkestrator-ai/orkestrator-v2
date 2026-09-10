import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  isNativeAgentExecutionPolicy,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import {
  ProviderUnavailableError,
  type ProviderCreateSessionOptions,
  type ProviderSendOptions,
} from "./agent-provider-contract.js";
import { asRecord, assertSdkResponse } from "./agent-provider-runtime.js";
import {
  effectiveOpenCodePolicy,
  openCodePermissionRules,
  openCodeReviewPermissionRules,
} from "./opencode-provider-helpers.js";

const REVIEW_SESSION_METADATA_KEY = "orkestrator.reviewSession";
const REVIEW_SESSION_METADATA_VERSION = 1;

export function openCodeReviewSessionMetadata(policy: NativeAgentExecutionPolicy) {
  return {
    [REVIEW_SESSION_METADATA_KEY]: {
      version: REVIEW_SESSION_METADATA_VERSION,
      policy,
    },
  };
}

function reviewSessionPolicy(value: unknown): NativeAgentExecutionPolicy | undefined {
  const session = asRecord(value);
  const metadata = asRecord(session?.metadata);
  const marker = asRecord(metadata?.[REVIEW_SESSION_METADATA_KEY]);
  if (
    marker?.version !== REVIEW_SESSION_METADATA_VERSION ||
    !isNativeAgentExecutionPolicy(marker.policy) ||
    marker.policy.id === "coordinator-read-only"
  ) {
    return undefined;
  }
  return marker.policy;
}

/** OpenCode appends update rules, so the newest complete suffix is authoritative. */
function endsWithPermissionRules(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length < right.length) return false;
  return JSON.stringify(left.slice(-right.length)) === JSON.stringify(right);
}

/**
 * Durable reviewer identity and temporary permission lifecycle.
 *
 * OpenCode stores both metadata and permission rules on the session. This
 * object keeps only a per-provider cache; after recreation it reads the marker
 * and current rule suffix back from the server before granting or restoring
 * anything.
 */
export class OpenCodeReviewSessionPermissions {
  private readonly policies = new Map<string, NativeAgentExecutionPolicy>();
  private readonly hydrated = new Set<string>();
  private readonly candidates = new Set<string>();
  private readonly active = new Set<string>();

  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string | undefined,
    private readonly requestOptions: () => { signal: AbortSignal },
    private readonly onPolicy: (sessionId: string, policy: NativeAgentExecutionPolicy) => void,
  ) {}

  registerCandidate(sessionId: string): void {
    this.candidates.add(sessionId);
  }

  async createSession(
    label: string,
    options: ProviderCreateSessionOptions,
  ): Promise<{ sessionId: string; policy?: NativeAgentExecutionPolicy }> {
    const policy = options.policy ? effectiveOpenCodePolicy(options.policy) : undefined;
    if (options.reviewerSession && !policy) {
      throw new Error("OpenCode reviewer sessions require an execution policy");
    }
    const permission = policy ? openCodePermissionRules(policy) : undefined;
    const response = await this.client.session.create(
      {
        title: label,
        ...(options.reviewerSession && policy
          ? { metadata: openCodeReviewSessionMetadata(policy) }
          : {}),
        ...(permission ? { permission } : {}),
      },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode session creation");
    if (!response.data?.id) throw new Error("OpenCode returned an empty session");
    this.rememberCreated(response.data.id, policy, options.reviewerSession === true);
    return { sessionId: response.data.id, ...(policy ? { policy } : {}) };
  }

  enableForTurn(sessionId: string, options: ProviderSendOptions): Promise<boolean> {
    return options.readOnly && options.reviewShellPolicy
      ? this.enable(sessionId, options.reviewShellPolicy)
      : Promise.resolve(false);
  }

  rememberCreated(
    sessionId: string,
    policy: NativeAgentExecutionPolicy | undefined,
    reviewer: boolean,
  ): void {
    this.hydrated.add(sessionId);
    if (!reviewer || !policy) return;
    this.candidates.add(sessionId);
    this.policies.set(sessionId, policy);
  }

  /** Apply the constrained rules only after the durable marker proves intent. */
  async enable(sessionId: string, requestedPolicy: NativeAgentExecutionPolicy): Promise<boolean> {
    const basePolicy = await this.readPolicy(sessionId);
    if (!basePolicy) return false;
    const policy = effectiveOpenCodePolicy(requestedPolicy);
    try {
      const response = await this.client.session.update(
        {
          sessionID: sessionId,
          directory: this.directory,
          permission: openCodeReviewPermissionRules(policy),
        },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode reviewer permission update");
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode reviewer permissions are unavailable", {
        cause: error,
      });
    }
    this.active.add(sessionId);
    return true;
  }

  /** Restore the immutable base policy once a reviewer is no longer running. */
  async restoreIfNeeded(sessionId: string): Promise<void> {
    if (!this.candidates.has(sessionId) && !this.active.has(sessionId)) return;
    const policy = await this.readPolicy(sessionId);
    if (!policy || !this.active.has(sessionId)) return;
    try {
      const response = await this.client.session.update(
        {
          sessionID: sessionId,
          directory: this.directory,
          permission: openCodePermissionRules(policy),
        },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode reviewer permission restore");
      this.active.delete(sessionId);
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode reviewer permissions could not be restored", {
        cause: error,
      });
    }
  }

  private async readPolicy(sessionId: string): Promise<NativeAgentExecutionPolicy | undefined> {
    if (this.hydrated.has(sessionId)) return this.policies.get(sessionId);
    let response;
    try {
      response = await this.client.session.get(
        { sessionID: sessionId, directory: this.directory },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode reviewer identity read");
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode reviewer identity is unavailable", {
        cause: error,
      });
    }
    const policy = reviewSessionPolicy(response.data);
    this.hydrated.add(sessionId);
    if (!policy) return undefined;
    this.policies.set(sessionId, policy);
    this.onPolicy(sessionId, policy);
    if (
      endsWithPermissionRules(
        asRecord(response.data)?.permission,
        openCodeReviewPermissionRules(policy),
      )
    ) {
      this.active.add(sessionId);
    }
    return policy;
  }
}
