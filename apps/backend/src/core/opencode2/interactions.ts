/**
 * OpenCode 2.x permission requests and forms as the shared approval and
 * question cards (docs/todo/agent-engines/0008-opencode-v2.md, build plan
 * phase 4).
 *
 * - **Authoritative on every read.** `GET /api/session/:id/permission` and
 *   `/form` are read for every snapshot, so a tab that was unmounted (or a
 *   backend that restarted) shows exactly what OpenCode is still waiting on.
 *   Nothing here is cached beyond the identity of what was last listed.
 * - **Allow once or deny, never `always`** (owner decision 1, 2026-11-09): an
 *   `always` reply saves a rule in OpenCode's own database for every later
 *   session, which Orkestrator can neither list nor remove. The card offers no
 *   session grant, and an `approve-for-session` resolution is refused here
 *   before anything is sent. Orkestrator's own permission rules (todo 0723)
 *   still apply through {@link OpenCode2InteractionAdapter.permissionRuleDetail}.
 * - **Deny rather than approve.** A malformed or unmappable answer is refused
 *   without a reply; declining, denying or cancelling rejects. OpenCode
 *   publishes no deadline, so there is no timeout to deny on: a request waits
 *   until it is answered, and stopping or closing the turn rejects whatever is
 *   still pending (`OpenCode2Provider.abort`), as on 1.x.
 * - **Confirmed from the source.** A reply is reported `applied` only once the
 *   request has left the server's pending list; a reply whose answer was
 *   lost is reconciled the same way rather than assumed.
 */
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_LIMITS,
  isAgentInteractionResolution,
  type AgentInteractionApplyOutcome,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import {
  ProviderUnavailableError,
  type AgentInteractionProviderCapability,
  type PermissionRuleRequestDetail,
  type ProviderSessionRegistration,
} from "../agent-provider-contract.js";
import {
  asRecord,
  InteractionSnapshotTracker,
  MAX_TRACKED_PROVIDER_INTERACTIONS,
  nonEmptyString,
  outcome,
  serializedByteLength,
  setBoundedMapEntry,
  truncatedJoinedText,
  truncatedText,
} from "../agent-provider-runtime.js";
import { openCodeRuleDetail } from "../permission-rules/index.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import { openCode2FormAnswer, openCode2FormCard, type OpenCode2FormCard } from "./forms.js";

type Identity =
  | { kind: "permission"; sessionId: string; providerId: string }
  | { kind: "form"; sessionId: string; providerId: string; card: OpenCode2FormCard };

/** Lines of an edit's diff preview shown on the approval card. */
const MAX_PREVIEW_DIFF_CHARS = 8_000;
const MAX_RESOURCES_SHOWN = 16;
const FORM_DECLINED_MESSAGE = "The user declined to answer.";

function interactionId(sessionId: string, kind: "permission" | "form", id: string): string {
  const value = `opencode2:${kind}:${encodeURIComponent(sessionId)}:${id}`;
  if (value.length > AGENT_INTERACTION_LIMITS.maxIdLength) {
    throw new ProviderUnavailableError("OpenCode returned an oversized interaction identity");
  }
  return value;
}

/** The names a 2.x action is shown under; the action itself is shown verbatim otherwise. */
const ACTION_TITLES: Record<string, string> = {
  shell: "run a command",
  edit: "change a file",
  read: "read a file",
  external_directory: "use a directory outside the project",
  webfetch: "fetch a web page",
  websearch: "search the web",
  subagent: "start a sub-agent",
  question: "ask you a question",
};

function previewDiff(metadata: Record<string, unknown> | null): string | undefined {
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const lines: string[] = [];
  for (const entry of files.slice(0, 4)) {
    const file = asRecord(entry);
    const patch = typeof file?.patch === "string" ? file.patch : undefined;
    if (patch) lines.push(patch);
  }
  if (lines.length === 0) return undefined;
  const text = lines.join("\n");
  return text.length <= MAX_PREVIEW_DIFF_CHARS
    ? text
    : `${text.slice(0, MAX_PREVIEW_DIFF_CHARS)}\n… (preview cut)`;
}

/**
 * The structured operation behind one 2.x approval (todo 0723), read through
 * the 1.x reader with 2.x's names mapped onto it: `shell` for `bash`, and its
 * one parsed command as the exact command. Anything else — several commands in
 * one call, several files, other actions — is not something a rule answers.
 */
function openCode2RuleDetail(
  request: Record<string, unknown>,
  action: string,
  resources: readonly string[],
  directory: string,
): PermissionRuleRequestDetail | null {
  if (action === "shell") {
    if (resources.length !== 1) return null;
    return openCodeRuleDetail(
      { metadata: { command: resources[0] } },
      "bash",
      resources,
      directory,
    );
  }
  if (action === "edit" || action === "webfetch") {
    return openCodeRuleDetail({ ...request, metadata: {} }, action, resources, directory);
  }
  return null;
}

export class OpenCode2InteractionAdapter implements AgentInteractionProviderCapability {
  private readonly tracker = new InteractionSnapshotTracker();
  private readonly identities = new Map<string, Identity>();
  private readonly ruleDetails = new Map<string, PermissionRuleRequestDetail>();
  private readonly resolving = new Set<string>();

  constructor(
    private readonly client: OpenCode2Client,
    private readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}

  register(sessionId: string, registration?: ProviderSessionRegistration): void {
    this.tracker.register(sessionId, registration);
  }

  permissionRuleDetail(sessionId: string, id: string): PermissionRuleRequestDetail | null {
    if (this.identities.get(id)?.sessionId !== sessionId) return null;
    return this.ruleDetails.get(id) ?? null;
  }

  async listPendingInteractions(sessionId: string): Promise<AgentInteractionSnapshot> {
    let permissions: unknown;
    let forms: unknown;
    try {
      [permissions, forms] = await Promise.all([
        this.client.listPermissions(sessionId),
        this.client.listForms(sessionId),
      ]);
    } catch (error) {
      // A session the server does not know has nothing pending.
      if (error instanceof OpenCode2RequestError && error.status === 404) {
        return this.publish(sessionId, []);
      }
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("OpenCode interactions are unavailable", { cause: error });
    }
    if (!Array.isArray(permissions) || !Array.isArray(forms)) {
      throw new ProviderUnavailableError("OpenCode interactions are malformed");
    }
    const owned = (entry: unknown) => asRecord(entry)?.sessionID === sessionId;
    const ownedPermissions = permissions.filter(owned);
    const ownedForms = forms.filter(owned);
    if (ownedPermissions.length + ownedForms.length > AGENT_INTERACTION_LIMITS.maxPendingRequests) {
      throw new ProviderUnavailableError("OpenCode returned too many interactions");
    }
    if (
      serializedByteLength([ownedPermissions, ownedForms]) >
      AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes * 4
    ) {
      throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
    }
    const requests = [
      ...ownedForms.map((form) => this.mapForm(sessionId, form)),
      ...ownedPermissions.map((permission) => this.mapPermission(sessionId, permission)),
    ];
    return this.publish(sessionId, requests);
  }

  async resolveInteraction(
    sessionId: string,
    id: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome> {
    const known = this.tracker.sessionFor(id);
    if (known !== undefined && known !== sessionId) return outcome("rejected", sessionId, id, 0);
    const snapshot = await this.listPendingInteractions(sessionId);
    const request = snapshot.requests.find((candidate) => candidate.id === id);
    const identity = this.identities.get(id);
    if (!request || !identity) return outcome("stale", sessionId, id, snapshot.revision);
    if (!isAgentInteractionResolution(resolution, request)) {
      return outcome("rejected", sessionId, id, snapshot.revision);
    }
    if (this.resolving.has(id))
      return outcome("already-resolved", sessionId, id, snapshot.revision);
    const reply = this.reply(identity, resolution);
    if (!reply) return outcome("rejected", sessionId, id, snapshot.revision);
    this.resolving.add(id);
    try {
      try {
        await reply();
      } catch (error) {
        // Someone else answered it first, or it settled with its turn.
        if (error instanceof OpenCode2RequestError && error.status === 404) {
          return outcome("already-resolved", sessionId, id, snapshot.revision);
        }
        // A definitive refusal of the answer itself (an invalid form answer,
        // `Form.AlreadySettledError`) leaves nothing applied by this call.
        if (error instanceof OpenCode2RequestError) {
          const still = await this.listPendingInteractions(sessionId).catch(() => null);
          if (still && !still.requests.some((item) => item.id === id)) {
            return outcome("already-resolved", sessionId, id, still.revision);
          }
          return outcome("rejected", sessionId, id, still?.revision ?? snapshot.revision);
        }
      }
      const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
      if (!reconciled) return outcome("provider-unavailable", sessionId, id, snapshot.revision);
      return outcome(
        reconciled.requests.some((item) => item.id === id) ? "provider-unavailable" : "applied",
        sessionId,
        id,
        reconciled.revision,
      );
    } finally {
      this.resolving.delete(id);
    }
  }

  /** The upstream call for one resolution, or null when it must be refused unsent. */
  private reply(
    identity: Identity,
    resolution: AgentInteractionResolution,
  ): (() => Promise<void>) | null {
    const { sessionId, providerId } = identity;
    if (identity.kind === "permission") {
      if (resolution.action === "approve-for-session") return null;
      if (resolution.action === "answer") {
        // A permission card has no questions; any answer content is malformed.
        if ((resolution.answer?.answers.length ?? 0) > 0) return null;
        return () => this.client.replyPermission(sessionId, providerId, "once");
      }
      return () => this.client.replyPermission(sessionId, providerId, "reject");
    }
    if (resolution.action === "approve-for-session") return null;
    if (resolution.action !== "answer") {
      return () => this.client.rejectForm(sessionId, providerId, FORM_DECLINED_MESSAGE);
    }
    const encoded = openCode2FormAnswer(identity.card, resolution.answer?.answers ?? []);
    if (!encoded.ok) return null;
    return () => this.client.replyForm(sessionId, providerId, encoded.answer);
  }

  private publish(sessionId: string, requests: AgentInteractionRequest[]) {
    const snapshot = this.tracker.snapshot(sessionId, requests);
    const current = new Set(snapshot.requests.map((request) => request.id));
    for (const [id, identity] of this.identities) {
      if (identity.sessionId === sessionId && !current.has(id)) {
        this.identities.delete(id);
        this.ruleDetails.delete(id);
      }
    }
    for (const id of this.ruleDetails.keys()) {
      if (!this.identities.has(id)) this.ruleDetails.delete(id);
    }
    return snapshot;
  }

  private base(sessionId: string, id: string) {
    const createdAt = this.tracker.firstSeen(id, this.now());
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: "opencode" as const,
      origin: this.tracker.registration(sessionId).origin,
      sessionId,
      state: "pending" as const,
      revision: 0,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapPermission(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerId = nonEmptyString(request?.id);
    const action = nonEmptyString(request?.action);
    const resources = Array.isArray(request?.resources)
      ? request.resources.filter((value): value is string => typeof value === "string")
      : null;
    if (!request || !providerId || !action || !resources) {
      throw new ProviderUnavailableError("OpenCode returned a malformed permission request");
    }
    const id = interactionId(sessionId, "permission", providerId);
    setBoundedMapEntry(
      this.identities,
      id,
      { kind: "permission", sessionId, providerId },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    const detail = openCode2RuleDetail(request, action, resources, this.directory);
    if (detail) setBoundedMapEntry(this.ruleDetails, id, detail, MAX_TRACKED_PROVIDER_INTERACTIONS);
    else this.ruleDetails.delete(id);
    const metadata = asRecord(request.metadata);
    const diff = action === "edit" ? previewDiff(metadata) : undefined;
    const label = action === "shell" ? "Command" : action === "edit" ? "File" : "Resource";
    const reason = nonEmptyString(request.message);
    return {
      ...this.base(sessionId, id),
      kind: "permission",
      presentation: {
        title: `OpenCode asks to ${ACTION_TITLES[action] ?? `use ${truncatedText(action, action, 128)}`}`,
        body: truncatedJoinedText([
          `Permission: ${truncatedText(action, action, 256)}`,
          ...resources
            .slice(0, MAX_RESOURCES_SHOWN)
            .map((resource) => `${label}: ${truncatedText(resource, resource, 2_048)}`),
          ...(resources.length > MAX_RESOURCES_SHOWN
            ? [`… and ${resources.length - MAX_RESOURCES_SHOWN} more`]
            : []),
          ...(reason ? [`Reason: ${truncatedText(reason, reason, 2_048)}`] : []),
          ...(diff ? ["", diff] : []),
        ]),
        questions: [],
        confirmLabel: "Allow once",
        declineLabel: "Deny",
      },
    };
  }

  private mapForm(sessionId: string, raw: unknown): AgentInteractionRequest {
    const form = asRecord(raw);
    const providerId = nonEmptyString(form?.id);
    const card = openCode2FormCard(raw);
    if (!providerId || !card) {
      throw new ProviderUnavailableError("OpenCode returned a malformed form");
    }
    const id = interactionId(sessionId, "form", providerId);
    setBoundedMapEntry(
      this.identities,
      id,
      { kind: "form", sessionId, providerId, card },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    return {
      ...this.base(sessionId, id),
      kind: "question",
      presentation: {
        title: card.title,
        ...(card.body ? { body: card.body } : {}),
        ...(card.url ? { url: card.url } : {}),
        questions: card.questions,
        ...(card.confirmDisabled ? { confirmDisabled: true } : {}),
        declineLabel: "Decline",
      },
    };
  }
}
