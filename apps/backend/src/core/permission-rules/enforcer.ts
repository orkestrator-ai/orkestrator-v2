import { randomUUID } from "node:crypto";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  agentInteractionPolicyAction,
  type AgentInteractionApplyOutcome,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import {
  PERMISSION_RULE_EXPIRY_CHOICES_MS,
  findPermissionRule,
  permissionRuleKindFor,
  permissionRuleOffer,
  type NativeAgentPermissionRule,
  type PermissionRuleApplication,
  type PermissionRuleKind,
  type PermissionRuleScope,
} from "@orkestrator/protocol/permission-rules";
import type {
  AgentInteractionProviderCapability,
  PermissionRuleRequestDetail,
} from "../agent-provider-contract.js";
import type { Environment, PersistedNativeAgentSession } from "../models.js";
import type { PermissionRuleStore } from "./store.js";

/**
 * Applies Orkestrator's permission rules (todo 0723) to a session's pending
 * requests, and offers "Approve and remember" on the ones a rule could cover.
 *
 * A rule only ever answers a question the session's own policy would put to
 * the user: never under a deny or unattended policy, never for a coordinator,
 * a pipeline, a review, a plan-mode turn or a capability the policy denies.
 * Everything else fails closed: a store that cannot be read, a request the
 * bridge did not mark exact, a claim that already exists, or an answer the
 * provider did not apply, all leave the card for the user. The answer itself
 * is always the provider's allow-once, so removing a rule takes effect on the
 * very next request.
 */

/** The parts of a provider the enforcer uses. */
export interface PermissionRuleProvider {
  interactions?: Pick<
    AgentInteractionProviderCapability,
    "resolveInteraction" | "permissionRuleDetail"
  > &
    Partial<Pick<AgentInteractionProviderCapability, "listPendingInteractions">>;
}

/** What the user chose on the card's "Approve and remember" panel. */
export interface PermissionRuleChoice {
  pattern: string;
  scope: PermissionRuleScope;
  /** Answer for every provider, not only the one that asked. */
  anyProvider: boolean;
  /** One of {@link PERMISSION_RULE_EXPIRY_CHOICES_MS}, or absent for "until removed". */
  expiresInMs?: number;
}

export class PermissionRuleRefusedError extends Error {}

export interface PermissionRuleEnforcerOptions {
  store: () => PermissionRuleStore;
  getEnvironment: (environmentId: string) => Promise<Environment | null | undefined>;
  now: () => number;
  /** A rule answered a request; for view refresh. Content-free. */
  onApplied?: (application: PermissionRuleApplication) => void;
}

/** Where a session's requests may be answered by rules, once it qualifies. */
export interface PermissionRuleSessionScope {
  projectId: string;
  environmentId: string;
  logicalSessionKey: string;
  agent: PersistedNativeAgentSession["agent"];
  workspaceRoot?: string;
  /** Rule kinds the session's execution policy leaves to the user. */
  kinds: ReadonlySet<PermissionRuleKind>;
}

const AUTHORIZATION_KINDS = new Set(["command-approval", "file-approval", "permission"]);
/** The container's workspace mount, where its agents see the checkout. */
const CONTAINER_WORKSPACE_ROOT = "/workspace";

export class PermissionRuleEnforcer {
  /** Requests being answered by this process, so concurrent reads answer once. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: PermissionRuleEnforcerOptions) {}

  /**
   * Whether rules may apply to `session` at all, and with what scope; `null`
   * when they may not. Never throws.
   */
  async sessionScope(
    session: PersistedNativeAgentSession,
  ): Promise<PermissionRuleSessionScope | null> {
    if (session.origin !== "interactive-native") return null;
    if (session.interactionPolicy?.mode !== "interactive") return null;
    if (session.executionPolicy === "coordinator-read-only") return null;
    if (session.owner && session.owner.kind !== "environment") return null;
    const policy = session.policy;
    if (policy && (policy.approvals !== "ask" || policy.id === "coordinator-read-only"))
      return null;
    if (policy?.id === "pipeline") return null;
    if (session.controls?.mode === "plan") return null;
    let environment: Environment | null | undefined;
    try {
      environment = await this.options.getEnvironment(session.environmentId);
    } catch {
      return null;
    }
    if (!environment || environment.deletionRequestedAt) return null;
    const denied = new Set(policy?.capabilityPolicy?.deny ?? []);
    const kinds = new Set<PermissionRuleKind>(["mcp-tool"]);
    if (!denied.has("shell") && !denied.has("shell.mutate")) kinds.add("command-prefix");
    if (!denied.has("file.write") && !denied.has("file.patch")) kinds.add("file-path");
    if (!denied.has("network") && policy?.networkAccess !== "restricted") {
      kinds.add("network-host");
    }
    const workspaceRoot =
      environment.environmentType === "containerized"
        ? CONTAINER_WORKSPACE_ROOT
        : environment.worktreePath;
    return {
      projectId: environment.projectId,
      environmentId: environment.id,
      logicalSessionKey: session.logicalSessionKey,
      agent: session.agent,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      kinds,
    };
  }

  /** The detail a rule may match for `request`, when the session's policy would ask. */
  private requestDetail(
    session: PersistedNativeAgentSession,
    provider: PermissionRuleProvider,
    scope: PermissionRuleSessionScope,
    request: AgentInteractionRequest,
  ): PermissionRuleRequestDetail | null {
    if (!AUTHORIZATION_KINDS.has(request.kind)) return null;
    if (request.state !== "pending") return null;
    if (request.presentation.confirmDisabled === true) return null;
    if (request.expiresAt !== undefined && request.expiresAt <= this.options.now()) return null;
    // A rule only answers what this session's policy leaves to the user.
    if (agentInteractionPolicyAction(session.interactionPolicy, request.kind) !== "await-user") {
      return null;
    }
    let detail: PermissionRuleRequestDetail | null = null;
    try {
      detail =
        provider.interactions?.permissionRuleDetail?.(session.providerSessionId, request.id) ??
        null;
    } catch {
      return null;
    }
    if (!detail || !scope.kinds.has(permissionRuleKindFor(detail.subject))) return null;
    return detail;
  }

  /**
   * Answers every request in `snapshot` a rule covers, and returns the
   * snapshot without them, with "Approve and remember" offers on the rest.
   * Never throws; on any failure the snapshot is returned as it came.
   */
  async apply(
    session: PersistedNativeAgentSession,
    provider: PermissionRuleProvider,
    snapshot: AgentInteractionSnapshot,
  ): Promise<{ snapshot: AgentInteractionSnapshot; answered: number }> {
    if (snapshot.requests.length === 0) return { snapshot, answered: 0 };
    const scope = await this.sessionScope(session);
    if (!scope) return { snapshot, answered: 0 };
    let rules: NativeAgentPermissionRule[] | null;
    try {
      rules = this.options.store().listForProject(scope.projectId);
    } catch {
      // A store that cannot be read answers nothing.
      rules = null;
    }
    const kept: AgentInteractionRequest[] = [];
    let answered = 0;
    for (const request of snapshot.requests) {
      const detail = this.requestDetail(session, provider, scope, request);
      if (!detail) {
        kept.push(request);
        continue;
      }
      const rule =
        rules && rules.length > 0
          ? findPermissionRule(rules, detail.subject, {
              provider: request.provider,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              ...(scope.workspaceRoot ? { workspaceRoot: scope.workspaceRoot } : {}),
              now: this.options.now(),
            })
          : null;
      if (rule && (await this.answer(session, provider, scope, request, detail, rule))) {
        answered += 1;
        continue;
      }
      kept.push(withOffer(request, detail, scope));
    }
    return { snapshot: { ...snapshot, requests: kept }, answered };
  }

  /**
   * Whether any rule could answer a request of `session` right now. A cheap
   * pre-check (one indexed store read, no provider read) so the activity
   * sweep reads pending requests only for sessions that have rules to apply.
   */
  async hasApplicableRules(session: PersistedNativeAgentSession): Promise<boolean> {
    const scope = await this.sessionScope(session);
    if (!scope) return false;
    try {
      const now = this.options.now();
      return this.options
        .store()
        .listForProject(scope.projectId)
        .some(
          (rule) =>
            (rule.provider === "any" || rule.provider === session.agent) &&
            (rule.scope === "project" || rule.environmentId === scope.environmentId) &&
            (rule.expiresAt === undefined || rule.expiresAt > now) &&
            scope.kinds.has(rule.kind),
        );
    } catch {
      return false;
    }
  }

  /**
   * The activity sweep saw `session` waiting: answer what rules cover. Returns
   * how many requests were answered and how many still wait on the user, or
   * `null` when nothing was read.
   */
  async applyToWaitingSession(
    session: PersistedNativeAgentSession,
    provider: PermissionRuleProvider,
  ): Promise<{ answered: number; remaining: number } | null> {
    const interactions = provider.interactions;
    if (!interactions?.listPendingInteractions) return null;
    if (!(await this.hasApplicableRules(session))) return null;
    let snapshot: AgentInteractionSnapshot;
    try {
      snapshot = await interactions.listPendingInteractions(session.providerSessionId);
    } catch {
      return null;
    }
    const { snapshot: after, answered } = await this.apply(session, provider, snapshot);
    return {
      answered,
      remaining: after.requests.filter(
        (request) => request.state === "pending" || request.state === "answering",
      ).length,
    };
  }

  /** Offers only, for a request list read elsewhere (never answers). */
  async offers(
    session: PersistedNativeAgentSession,
    provider: PermissionRuleProvider,
    requests: AgentInteractionRequest[],
  ): Promise<AgentInteractionRequest[]> {
    const scope = await this.sessionScope(session);
    if (!scope) return requests;
    return requests.map((request) => {
      const detail = this.requestDetail(session, provider, scope, request);
      return detail ? withOffer(request, detail, scope) : request;
    });
  }

  /**
   * The card's "Approve and remember": answers `interactionId` allow-once and,
   * once the provider applied it, saves the rule the user chose. The choice
   * is checked against the offer re-derived here from the provider's own
   * payload, so a client can only save a pattern the card could show, and
   * only for a request that is still waiting on the user right now.
   */
  async approveAndRemember(
    session: PersistedNativeAgentSession,
    provider: PermissionRuleProvider,
    interactionId: string,
    choice: PermissionRuleChoice,
  ): Promise<{ outcome: AgentInteractionApplyOutcome; rule?: NativeAgentPermissionRule }> {
    const interactions = provider.interactions;
    if (!interactions?.listPendingInteractions) {
      throw new PermissionRuleRefusedError("This agent cannot answer requests here");
    }
    const scope = await this.sessionScope(session);
    if (!scope) {
      throw new PermissionRuleRefusedError("Rules do not apply to this session");
    }
    if (choice.scope !== "project" && choice.scope !== "environment") {
      throw new PermissionRuleRefusedError("Unknown rule scope");
    }
    if (
      choice.expiresInMs !== undefined &&
      !PERMISSION_RULE_EXPIRY_CHOICES_MS.includes(choice.expiresInMs)
    ) {
      throw new PermissionRuleRefusedError("Unknown rule expiry");
    }
    const snapshot = await interactions.listPendingInteractions(session.providerSessionId);
    const request = snapshot.requests.find((candidate) => candidate.id === interactionId);
    if (!request) {
      return {
        outcome: {
          result: "stale",
          interactionId,
          sessionId: session.providerSessionId,
          revision: snapshot.revision,
        },
      };
    }
    const detail = this.requestDetail(session, provider, scope, request);
    if (!detail) throw new PermissionRuleRefusedError("This request can't be remembered");
    const offer = permissionRuleOffer(
      detail.subject,
      scope.workspaceRoot ? { workspaceRoot: scope.workspaceRoot } : {},
    );
    if (!offer.patterns.includes(choice.pattern)) {
      throw new PermissionRuleRefusedError("That pattern was not offered for this request");
    }
    const now = this.options.now();
    const rule: NativeAgentPermissionRule = {
      id: randomUUID(),
      provider: choice.anyProvider ? "any" : request.provider,
      scope: choice.scope,
      projectId: scope.projectId,
      ...(choice.scope === "environment" ? { environmentId: scope.environmentId } : {}),
      kind: offer.kind,
      pattern: choice.pattern,
      createdAt: now,
      createdFrom: {
        environmentId: scope.environmentId,
        agent: request.provider,
        logicalSessionKey: scope.logicalSessionKey,
        interactionId: request.id,
      },
      useCount: 0,
      ...(choice.expiresInMs === undefined ? {} : { expiresAt: now + choice.expiresInMs }),
    };
    const outcome = await interactions.resolveInteraction(session.providerSessionId, request.id, {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: request.id,
      sessionId: request.sessionId,
      action: "answer",
      answer: {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: request.id,
        sessionId: request.sessionId,
        answers: detail.allowOnceAnswers,
      },
      resolvedAt: Math.max(now, request.createdAt),
    });
    // A rule is saved only for a request the user's click actually approved.
    if (outcome.result !== "applied") return { outcome };
    return { outcome, rule: this.options.store().create(rule) };
  }

  private async answer(
    session: PersistedNativeAgentSession,
    provider: PermissionRuleProvider,
    scope: PermissionRuleSessionScope,
    request: AgentInteractionRequest,
    detail: PermissionRuleRequestDetail,
    rule: NativeAgentPermissionRule,
  ): Promise<boolean> {
    const interactions = provider.interactions;
    if (!interactions) return false;
    const flightKey = `${session.key}\0${request.id}`;
    if (this.inFlight.has(flightKey)) return false;
    this.inFlight.add(flightKey);
    const application: PermissionRuleApplication = {
      ruleId: rule.id,
      kind: rule.kind,
      pattern: rule.pattern,
      scope: rule.scope,
      environmentId: scope.environmentId,
      agent: request.provider,
      logicalSessionKey: scope.logicalSessionKey,
      interactionId: request.id,
      appliedAt: this.options.now(),
    };
    try {
      const store = this.options.store();
      if (store.claimApplication(application, this.options.now()) !== "claimed") return false;
      const resolvedAt = Math.max(this.options.now(), request.createdAt);
      const resolution: AgentInteractionResolution = {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: request.id,
        sessionId: request.sessionId,
        action: "answer",
        answer: {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: request.id,
          sessionId: request.sessionId,
          answers: detail.allowOnceAnswers,
        },
        resolvedAt,
      };
      let applied = false;
      try {
        const outcome = await interactions.resolveInteraction(
          session.providerSessionId,
          request.id,
          resolution,
        );
        applied = outcome.result === "applied";
      } catch {
        applied = false;
      }
      try {
        store.finishApplication(application, applied, this.options.now());
      } catch {
        // The provider already has its answer; only the record is missing.
      }
      if (applied) {
        try {
          this.options.onApplied?.(application);
        } catch {
          // View refresh is best effort.
        }
      }
      return applied;
    } catch {
      return false;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }
}

function withOffer(
  request: AgentInteractionRequest,
  detail: PermissionRuleRequestDetail,
  scope: PermissionRuleSessionScope,
): AgentInteractionRequest {
  const offer = permissionRuleOffer(detail.subject, {
    ...(scope.workspaceRoot ? { workspaceRoot: scope.workspaceRoot } : {}),
    ...(detail.proposal ? { proposal: detail.proposal } : {}),
  });
  return { ...request, presentation: { ...request.presentation, ruleOffer: offer } };
}
