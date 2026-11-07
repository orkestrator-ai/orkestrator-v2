import { nodeActionRequestsChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import type { BackendEmit } from "../backend-emit.js";
import { randomUUID } from "node:crypto";
import {
  parseAgentsMdChanges,
  type AgentsMdChange,
} from "@orkestrator/protocol/agents-md-orkestrator";
import type { AgentInteractionQuestionAnswer } from "@orkestrator/protocol/agent-interactions";
import {
  parseWorkerQuestionAnswers,
  type WorkerQuestionRelay,
} from "@orkestrator/protocol/worker-question-relay";
import type { ProjectHomeMessage } from "@orkestrator/protocol/project-home-message";

/**
 * Actions a coordinator may only *request*; the user approves or rejects
 * each one in the portal, and only an approval executes it.
 *
 * - `delete-environment`: a coordinator never deletes on its own initiative.
 *   The user may ask for a deletion in the coordinator chat; the request
 *   then names the node and the environment for an explicit confirmation.
 * - `create-project`: a copy of the coordinator's project on another node
 *   (clone plus the files the user picks), at a location the user approves.
 * - `update-project-files`: push the command node's `.env` and selected
 *   files (or keys) to nodes.
 * - `reveal-env-value`: show one `.env` value in plain text.
 * - `apply-root-changes`: apply a patch of the project checkout's
 *   uncommitted changes to one worker on this node. The coordinator names
 *   the worker and may suggest files; the user picks the files.
 * - `update-agents-md`: open a pull request changing only the
 *   `## Orkestrator` section of the project's root AGENTS.md, on the node
 *   that owns the project copy. The user may edit the entries while
 *   approving.
 * - `switch-agent-account`: make another Claude or Codex login the active
 *   account on one machine, through the same `set_active_agent_account` the
 *   Settings switch uses. It changes which subscription pays for every new
 *   turn there, so it needs the user unless a self-timer carries their
 *   permission or the user turned on the standing permission in Settings
 *   (see `control-mcp-account-tools.ts`). A switch under either permission is
 *   recorded here as a request that ran without a decision (`authorizedBy`
 *   `"standing-grant"` or `"self-timer"`, `runUnattended`), so the user can
 *   see it afterwards; the hourly limit counts only the standing permission's.
 * - `answer-worker-question`: answer a question a worker on one node is
 *   waiting on, with the answer the coordinator proposed or the user's edit
 *   of it, through the same `resolve_native_agent_interaction` the worker's
 *   tab uses. A question no longer pending settles `stale` and nothing is
 *   sent. Approvals and permissions are never relayed.
 * - `message-project-home`: send a main coordinator's message to the
 *   project home, the user's own checkout, when the coordinator has sent it
 *   nothing in the last three hours. The coordinator's reason is the
 *   request's `reason`; declining sends nothing.
 *
 * Requests hold names and identifiers only, never file contents or values;
 * the exceptions are an AGENTS.md proposal's entries, which are the
 * coordinator's own bounded words the user reviews, and a worker question
 * relay's bounded copy of the question and proposed answer, and a held
 * project-home message, which is the coordinator's own bounded text.
 * The outcome is mailed back to the requesting coordinator conversation.
 *
 * An approved `update-agents-md` request keeps the user's final entries, and
 * one a backend restart interrupted is run again on start
 * (`resumeInterrupted`); its executor is idempotent per request.
 */

export const NODE_ACTION_REQUESTS_CHANGED_EVENT = "node-action-requests-changed";
export const NODE_ACTION_REQUEST_TTL_MS = 24 * 60 * 60_000;
const MAX_REQUESTS = 200;
const MAX_PROTECTED_REQUESTS = 2_000;
const SWITCH_WINDOW_MS = 60 * 60_000;

export type NodeActionKind =
  | "delete-environment"
  | "create-project"
  | "update-project-files"
  | "reveal-env-value"
  | "apply-root-changes"
  | "update-agents-md"
  | "switch-agent-account"
  | "answer-worker-question"
  | "message-project-home";

/** Kinds whose approved, unfinished runs are resumed after a restart. */
const RESUMABLE_KINDS: ReadonlySet<NodeActionKind> = new Set(["update-agents-md"]);

export interface NodeActionTarget {
  nodeId: string;
  nodeName: string;
  environmentId?: string;
  environmentName?: string;
  projectId?: string;
  projectName?: string;
  /** Absolute location on the node, for a new project. */
  location?: string;
  gitRemote?: string;
  files?: string[];
  keys?: string[];
  /** `switch-agent-account`: the provider and the account to make active. */
  platform?: string;
  accountId?: string;
  accountLabel?: string;
  /** `switch-agent-account`: the account active when it was asked for. */
  previousAccountId?: string;
  previousAccountLabel?: string;
}

export type NodeActionAuthorization = "standing-grant" | "self-timer";

export type NodeActionState =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executed"
  | "failed"
  | "outcome-unknown"
  /** Approved, but what it acts on had already gone; nothing was done. */
  | "stale";

export interface NodeActionRequest {
  requestId: string;
  kind: NodeActionKind;
  targets: NodeActionTarget[];
  /** The coordinator conversation that asked, and why (its own words, bounded). */
  requestedBy: { coordinatorEnvironmentId: string; coordinatorTabId: string; projectId: string };
  reason?: string;
  /** `update-agents-md`: the coordinator's proposal. */
  agentsMd?: { changes: AgentsMdChange[] };
  /** `answer-worker-question`: the question as proposed and the coordinator's answer. */
  workerQuestion?: WorkerQuestionRelay;
  /** `message-project-home`: the message held for the user's approval. */
  projectHomeMessage?: ProjectHomeMessage;
  /**
   * Ran without a decision because the user granted it in advance: in
   * Settings (`standing-grant`), or in their own turn on the self-timer that
   * woke the coordinator (`self-timer`). Such a record is created already
   * approved and is never pending.
   */
  authorizedBy?: NodeActionAuthorization;
  /** `self-timer`: the timer and the user's words its permission carries. */
  selfTimer?: { scheduleId: string; userInstruction: string; grantedAt: string };
  /** The requesting coordinator's display name, for records the user reads later. */
  coordinatorName?: string;
  /** Why the user is asked although a standing permission exists (its limit). */
  askedBecause?: string;
  createdAt: string;
  expiresAt: string;
  state: NodeActionState;
  resolvedAt?: string;
  /** The user's choices, kept for kinds that resume after a restart. */
  approval?: NodeActionApproval;
  result?: { code: string; message: string; url?: string };
}

/**
 * The user's final choices for an approval, where the request kind lets the
 * user adjust it while approving (a project copy's location and files).
 */
export interface NodeActionApproval {
  location?: string;
  paths?: string[];
  rememberFiles?: boolean;
  /** `update-agents-md`: the entries as the user edited them. */
  changes?: AgentsMdChange[];
  /** `answer-worker-question`: the answer as the user settled it. */
  answers?: AgentInteractionQuestionAnswer[];
}

export type NodeActionExecutor = (
  request: NodeActionRequest,
  approval: NodeActionApproval,
) => Promise<{
  code: string;
  message: string;
  url?: string;
  outcomeUnknown?: boolean;
  /** What the request acts on had already gone; nothing was done. */
  stale?: boolean;
}>;

/** Bounded, validated approval choices; unknown fields are dropped. */
export function parseNodeActionApproval(value: unknown): NodeActionApproval {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Expected approval.");
  const raw = value as Record<string, unknown>;
  const approval: NodeActionApproval = {};
  if (raw.location !== undefined) {
    if (typeof raw.location !== "string" || raw.location.length > 1024) {
      throw new Error("Expected an absolute location.");
    }
    approval.location = raw.location.trim();
  }
  if (raw.paths !== undefined) {
    if (
      !Array.isArray(raw.paths) ||
      raw.paths.length > 2_000 ||
      !raw.paths.every((entry) => typeof entry === "string" && entry.length <= 1024)
    ) {
      throw new Error("Expected paths.");
    }
    approval.paths = raw.paths as string[];
  }
  if (raw.rememberFiles !== undefined) approval.rememberFiles = raw.rememberFiles === true;
  if (raw.changes !== undefined) approval.changes = parseAgentsMdChanges(raw.changes);
  if (raw.answers !== undefined) approval.answers = parseWorkerQuestionAnswers(raw.answers);
  return approval;
}

export class NodeActionRequests {
  private requests: NodeActionRequest[] = [];
  private loadPromise: Promise<void> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  /** Requests whose executor is running in this process. */
  private readonly running = new Set<string>();

  constructor(
    private readonly options: {
      load(): Promise<unknown>;
      save(requests: NodeActionRequest[]): Promise<void>;
      emit: BackendEmit;
      executors: Partial<Record<NodeActionKind, NodeActionExecutor>>;
      /** Tell the requesting conversation what happened. */
      notify?(request: NodeActionRequest): Promise<void>;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.load();
    return this.loadPromise;
  }

  private retain(requests: NodeActionRequest[]): NodeActionRequest[] {
    const cutoff = this.now() - SWITCH_WINDOW_MS;
    const protectedRecord = (request: NodeActionRequest) =>
      request.authorizedBy === "standing-grant" &&
      (request.state === "approved" || Date.parse(request.createdAt) > cutoff);
    const ordinary = new Set(
      requests.filter((request) => !protectedRecord(request)).slice(-MAX_REQUESTS),
    );
    return requests.filter((request) => protectedRecord(request) || ordinary.has(request));
  }

  private async load(): Promise<void> {
    const raw = await this.options.load();
    if (Array.isArray(raw)) {
      this.requests = this.retain(
        raw.filter(
          (entry): entry is NodeActionRequest =>
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as NodeActionRequest).requestId === "string" &&
            Array.isArray((entry as NodeActionRequest).targets),
        ),
      );
    }
    let interrupted = false;
    for (const request of this.requests) {
      if (request.authorizedBy && request.state === "approved") {
        request.state = "outcome-unknown";
        request.result = {
          code: "interrupted",
          message:
            "The backend restarted before the switch outcome was saved. Check the active account before retrying.",
        };
        interrupted = true;
      }
    }
    if (interrupted) await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.requests);
    const save = this.saveQueue.catch(() => undefined).then(() => this.options.save(snapshot));
    this.saveQueue = save;
    await save;
    this.options.emit(nodeActionRequestsChangedEvent, {
      pending: this.requests.filter((request) => request.state === "pending").length,
    });
  }

  async create(input: {
    requestId?: string;
    kind: NodeActionKind;
    targets: NodeActionTarget[];
    requestedBy: NodeActionRequest["requestedBy"];
    reason?: string;
    agentsMd?: NodeActionRequest["agentsMd"];
    workerQuestion?: NodeActionRequest["workerQuestion"];
    projectHomeMessage?: NodeActionRequest["projectHomeMessage"];
    askedBecause?: string;
  }): Promise<NodeActionRequest> {
    if (input.requestId !== undefined && (!input.requestId.trim() || input.requestId.length > 256))
      throw new Error("Expected a requestId of 1-256 characters");
    await this.ensureLoaded();
    if (input.targets.length === 0) throw new Error("A request needs at least one target.");
    if (input.targets.length > 64) throw new Error("A request can name at most 64 targets.");
    if (input.requestId) {
      const existing = this.requests.find((request) => request.requestId === input.requestId);
      if (existing) {
        if (
          existing.kind !== input.kind ||
          JSON.stringify(existing.targets) !== JSON.stringify(input.targets) ||
          JSON.stringify(existing.requestedBy) !== JSON.stringify(input.requestedBy) ||
          existing.reason !== (input.reason ? input.reason.slice(0, 500) : undefined) ||
          JSON.stringify(existing.agentsMd) !== JSON.stringify(input.agentsMd) ||
          JSON.stringify(existing.workerQuestion) !== JSON.stringify(input.workerQuestion) ||
          JSON.stringify(existing.projectHomeMessage) !== JSON.stringify(input.projectHomeMessage)
        )
          throw new Error("Request ID was reused with a different payload");
        await this.persist();
        return structuredClone(existing);
      }
    }
    this.expire();
    const now = this.now();
    const request: NodeActionRequest = {
      requestId: input.requestId ?? randomUUID(),
      kind: input.kind,
      targets: input.targets.map((target) => ({ ...target })),
      requestedBy: { ...input.requestedBy },
      ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
      ...(input.agentsMd ? { agentsMd: structuredClone(input.agentsMd) } : {}),
      ...(input.workerQuestion ? { workerQuestion: structuredClone(input.workerQuestion) } : {}),
      ...(input.projectHomeMessage
        ? { projectHomeMessage: structuredClone(input.projectHomeMessage) }
        : {}),
      ...(input.askedBecause ? { askedBecause: input.askedBecause.slice(0, 500) } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + NODE_ACTION_REQUEST_TTL_MS).toISOString(),
      state: "pending",
    };
    this.requests = this.retain([...this.requests, request]);
    await this.persist();
    return request;
  }

  /**
   * Run a request the user authorized in advance, without asking: it is
   * recorded already approved and executed at once by the kind's own
   * executor, and the requesting coordinator gets no mail (the tool call
   * that asked returns the outcome).
   *
   * At most `limit.count` such runs within `limit.windowMs` share a `scope`
   * (failed runs changed nothing and do not count). Past that, nothing is
   * recorded and the caller asks the user instead. The count and the record
   * are taken together, with no await between them, so concurrent calls
   * cannot both take the last place.
   *
   * A `requestId` already used returns that request as it is, whether it ran
   * unattended or is an ordinary request the user was asked about.
   *
   * `authorizedBy` defaults to the standing permission, the only one with a
   * limit; a self-timer's permission is one switch the user asked for, so it
   * passes no limit and is not counted against the standing permission's.
   */
  async runUnattended(
    input: {
      requestId: string;
      kind: NodeActionKind;
      targets: NodeActionTarget[];
      requestedBy: NodeActionRequest["requestedBy"];
      reason?: string;
      coordinatorName?: string;
      authorizedBy?: NodeActionAuthorization;
      selfTimer?: NodeActionRequest["selfTimer"];
    },
    limit: { count: number; windowMs: number; scope(request: NodeActionRequest): boolean } | null,
  ): Promise<{ request: NodeActionRequest; ran: boolean } | { overLimit: { recent: number } }> {
    if (!input.requestId.trim() || input.requestId.length > 256)
      throw new Error("Expected a requestId of 1-256 characters");
    if (input.targets.length === 0) throw new Error("A request needs at least one target.");
    await this.ensureLoaded();
    const existing = this.requests.find((request) => request.requestId === input.requestId);
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.requestedBy.coordinatorEnvironmentId !==
          input.requestedBy.coordinatorEnvironmentId ||
        existing.requestedBy.coordinatorTabId !== input.requestedBy.coordinatorTabId ||
        existing.targets[0]?.nodeId !== input.targets[0]?.nodeId ||
        existing.targets[0]?.platform !== input.targets[0]?.platform ||
        existing.targets[0]?.accountId !== input.targets[0]?.accountId
      )
        throw new Error("Request ID was reused with a different payload");
      return { request: structuredClone(existing), ran: false };
    }
    this.requests = this.retain(this.requests);
    const authorizedBy = input.authorizedBy ?? "standing-grant";
    if (authorizedBy === "standing-grant" && !limit)
      throw new Error("The standing permission is always limited.");
    if (limit && limit.windowMs > SWITCH_WINDOW_MS)
      throw new Error("Unsupported allowance window.");
    if (
      this.requests.filter((request) => request.authorizedBy === "standing-grant").length >=
      MAX_PROTECTED_REQUESTS
    )
      throw new Error("Switch history capacity reached; try again later.");
    const now = this.now();
    if (limit) {
      const recent = this.requests.filter(
        (request) =>
          request.authorizedBy === "standing-grant" &&
          request.state !== "failed" &&
          now - Date.parse(request.createdAt) < limit.windowMs &&
          limit.scope(request),
      ).length;
      if (recent >= limit.count) return { overLimit: { recent } };
    }
    const at = new Date(now).toISOString();
    const request: NodeActionRequest = {
      requestId: input.requestId,
      kind: input.kind,
      targets: input.targets.map((target) => ({ ...target })),
      requestedBy: { ...input.requestedBy },
      ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
      authorizedBy,
      ...(authorizedBy === "self-timer" && input.selfTimer
        ? {
            selfTimer: {
              scheduleId: input.selfTimer.scheduleId.slice(0, 100),
              userInstruction: input.selfTimer.userInstruction.slice(0, 500),
              grantedAt: input.selfTimer.grantedAt.slice(0, 64),
            },
          }
        : {}),
      ...(input.coordinatorName ? { coordinatorName: input.coordinatorName.slice(0, 120) } : {}),
      createdAt: at,
      expiresAt: at,
      resolvedAt: at,
      state: "approved",
    };
    this.requests = this.retain([...this.requests, request]);
    try {
      await this.persist();
    } catch (error) {
      this.requests = this.requests.filter((entry) => entry !== request);
      throw error;
    }
    return { request: await this.execute(request, {}), ran: true };
  }

  async list(options: { pendingOnly?: boolean } = {}): Promise<NodeActionRequest[]> {
    await this.ensureLoaded();
    if (this.expire()) await this.persist();
    return this.requests
      .filter((request) => !options.pendingOnly || request.state === "pending")
      .map((request) => structuredClone(request));
  }

  async get(requestId: string): Promise<NodeActionRequest | null> {
    await this.ensureLoaded();
    const request = this.requests.find((entry) => entry.requestId === requestId);
    return request ? structuredClone(request) : null;
  }

  /**
   * The user's decision. Only a pending, unexpired request can be resolved,
   * and only once: an approval executes it, a rejection never does.
   */
  async resolve(
    requestId: string,
    decision: "approve" | "reject",
    approval: NodeActionApproval = {},
  ): Promise<NodeActionRequest> {
    await this.ensureLoaded();
    this.expire();
    const request = this.requests.find((entry) => entry.requestId === requestId);
    if (!request) throw new Error("That request does not exist.");
    if (request.state !== "pending") {
      throw new Error(`That request is already ${request.state}.`);
    }
    request.resolvedAt = new Date(this.now()).toISOString();
    if (decision === "reject") {
      request.state = "rejected";
      request.result = { code: "rejected", message: "The user rejected this request." };
      await this.persist();
      await this.options.notify?.(structuredClone(request)).catch(() => undefined);
      return structuredClone(request);
    }
    request.state = "approved";
    if (RESUMABLE_KINDS.has(request.kind)) request.approval = structuredClone(approval);
    await this.persist();
    return this.execute(request, approval);
  }

  /**
   * Run again every approved request of a resumable kind that a backend
   * restart interrupted. Its executor finds what the earlier run left.
   */
  async resumeInterrupted(): Promise<void> {
    await this.ensureLoaded();
    for (const request of this.requests) {
      if (
        request.state !== "approved" ||
        !RESUMABLE_KINDS.has(request.kind) ||
        this.running.has(request.requestId)
      )
        continue;
      await this.execute(request, request.approval ?? {});
    }
  }

  private async execute(
    request: NodeActionRequest,
    approval: NodeActionApproval,
  ): Promise<NodeActionRequest> {
    this.running.add(request.requestId);
    try {
      const executor = this.options.executors[request.kind];
      if (!executor) {
        request.state = "failed";
        request.result = { code: "unsupported", message: "This kind of request cannot run here." };
      } else {
        try {
          const outcome = await executor(structuredClone(request), approval);
          request.state = outcome.outcomeUnknown
            ? "outcome-unknown"
            : outcome.stale
              ? "stale"
              : "executed";
          request.result = {
            code: outcome.code,
            message: outcome.message,
            ...(outcome.url ? { url: outcome.url } : {}),
          };
        } catch (error) {
          // Offline nodes have not accepted the write. Keep approved entries
          // durable so startup/reconnect reconciliation can try them again.
          if (
            RESUMABLE_KINDS.has(request.kind) &&
            (error as { code?: unknown })?.code === "node-unavailable"
          ) {
            request.result = {
              code: "node-unavailable",
              message: "Waiting for the target node to reconnect.",
            };
            await this.persist();
            return structuredClone(request);
          }
          request.state = "failed";
          request.result = {
            code: (error as { code?: unknown }).code
              ? String((error as { code?: unknown }).code)
              : "failed",
            message: (error instanceof Error ? error.message : String(error)).slice(0, 600),
          };
        }
      }
      await this.persist();
    } finally {
      this.running.delete(request.requestId);
    }
    // An unattended run answers the call that started it; mail would repeat it.
    if (!request.authorizedBy)
      await this.options.notify?.(structuredClone(request)).catch(() => undefined);
    return structuredClone(request);
  }

  private expire(): boolean {
    const now = this.now();
    let changed = false;
    for (const request of this.requests) {
      if (request.state === "pending" && Date.parse(request.expiresAt) <= now) {
        request.state = "expired";
        request.result = { code: "expired", message: "Nobody approved this request in time." };
        changed = true;
      }
    }
    return changed;
  }
}

/** One line the user and the coordinator both read, naming every node and environment. */
export function describeNodeAction(
  request: Pick<NodeActionRequest, "kind" | "targets" | "workerQuestion">,
): string {
  const names = (target: NodeActionTarget) => target.environmentName ?? target.environmentId ?? "";
  switch (request.kind) {
    case "delete-environment":
      return `Delete ${request.targets
        .map((target) => `“${names(target)}” on ${target.nodeName}`)
        .join(", ")}`;
    case "create-project":
      return `Copy ${request.targets
        .map(
          (target) =>
            `${target.projectName ?? target.gitRemote ?? "a project"} to ${target.nodeName}${target.location ? ` at ${target.location}` : ""}`,
        )
        .join(", ")}`;
    case "update-project-files":
      return `Update ${request.targets
        .map(
          (target) =>
            `${(target.files ?? []).join(", ")}${target.keys?.length ? ` (keys ${target.keys.join(", ")})` : ""} on ${target.nodeName}`,
        )
        .join("; ")}`;
    case "reveal-env-value":
      return `Show ${request.targets
        .map(
          (target) =>
            `${target.keys?.join(", ")} from ${target.files?.join(", ")} on ${target.nodeName}`,
        )
        .join("; ")} in plain text`;
    case "apply-root-changes":
      return `Apply uncommitted checkout changes to ${request.targets
        .map((target) => `“${names(target)}” on ${target.nodeName}`)
        .join(", ")}`;
    case "switch-agent-account":
      return `Switch ${request.targets
        .map(
          (target) =>
            `the active ${target.platform === "codex" ? "Codex" : "Claude"} account on ${target.nodeName} to “${target.accountLabel ?? target.accountId}”`,
        )
        .join(", ")}`;
    case "answer-worker-question":
      return `Answer a question ${request.targets
        .map(
          (target) =>
            `${request.workerQuestion?.tabName ? `in tab “${request.workerQuestion.tabName}” ` : ""}of “${names(target)}” on ${target.nodeName}`,
        )
        .join(", ")}`;
    case "message-project-home":
      return `Send a coordinator message to the project home ${request.targets
        .map((target) => `“${names(target)}” on ${target.nodeName}`)
        .join(", ")}`;
    case "update-agents-md":
      return `Open a pull request updating the ## Orkestrator section of AGENTS.md in ${request.targets
        .map(
          (target) =>
            `${target.projectName ?? target.projectId ?? "the project"} on ${target.nodeName}`,
        )
        .join(", ")}`;
  }
}
