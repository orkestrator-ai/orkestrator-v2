import { randomUUID } from "node:crypto";
import {
  parseAgentsMdChanges,
  type AgentsMdChange,
} from "@orkestrator/protocol/agents-md-orkestrator";

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
 *   permission (see `control-mcp-account-tools.ts`).
 *
 * Requests hold names and identifiers only, never file contents or values;
 * the one exception is an AGENTS.md proposal's entries, which are the
 * coordinator's own bounded words the user reviews.
 * The outcome is mailed back to the requesting coordinator conversation.
 *
 * An approved `update-agents-md` request keeps the user's final entries, and
 * one a backend restart interrupted is run again on start
 * (`resumeInterrupted`); its executor is idempotent per request.
 */

export const NODE_ACTION_REQUESTS_CHANGED_EVENT = "node-action-requests-changed";
export const NODE_ACTION_REQUEST_TTL_MS = 24 * 60 * 60_000;
const MAX_REQUESTS = 200;

export type NodeActionKind =
  | "delete-environment"
  | "create-project"
  | "update-project-files"
  | "reveal-env-value"
  | "apply-root-changes"
  | "update-agents-md"
  | "switch-agent-account";

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
}

export type NodeActionState =
  "pending" | "approved" | "rejected" | "expired" | "executed" | "failed" | "outcome-unknown";

export interface NodeActionRequest {
  requestId: string;
  kind: NodeActionKind;
  targets: NodeActionTarget[];
  /** The coordinator conversation that asked, and why (its own words, bounded). */
  requestedBy: { coordinatorEnvironmentId: string; coordinatorTabId: string; projectId: string };
  reason?: string;
  /** `update-agents-md`: the coordinator's proposal. */
  agentsMd?: { changes: AgentsMdChange[] };
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
}

export type NodeActionExecutor = (
  request: NodeActionRequest,
  approval: NodeActionApproval,
) => Promise<{ code: string; message: string; url?: string; outcomeUnknown?: boolean }>;

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
      emit(event: string, payload: unknown): void;
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

  private async load(): Promise<void> {
    const raw = await this.options.load();
    if (Array.isArray(raw)) {
      this.requests = raw
        .filter(
          (entry): entry is NodeActionRequest =>
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as NodeActionRequest).requestId === "string" &&
            Array.isArray((entry as NodeActionRequest).targets),
        )
        .slice(-MAX_REQUESTS);
    }
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.requests);
    const save = this.saveQueue.catch(() => undefined).then(() => this.options.save(snapshot));
    this.saveQueue = save;
    await save;
    this.options.emit(NODE_ACTION_REQUESTS_CHANGED_EVENT, {
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
          JSON.stringify(existing.agentsMd) !== JSON.stringify(input.agentsMd)
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
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + NODE_ACTION_REQUEST_TTL_MS).toISOString(),
      state: "pending",
    };
    this.requests = [...this.requests, request].slice(-MAX_REQUESTS);
    await this.persist();
    return request;
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
          request.state = outcome.outcomeUnknown ? "outcome-unknown" : "executed";
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
export function describeNodeAction(request: Pick<NodeActionRequest, "kind" | "targets">): string {
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
    case "update-agents-md":
      return `Open a pull request updating the ## Orkestrator section of AGENTS.md in ${request.targets
        .map(
          (target) =>
            `${target.projectName ?? target.projectId ?? "the project"} on ${target.nodeName}`,
        )
        .join(", ")}`;
  }
}
