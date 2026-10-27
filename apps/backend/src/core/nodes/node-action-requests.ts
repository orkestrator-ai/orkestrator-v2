import { randomUUID } from "node:crypto";

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
 *
 * Requests hold names and identifiers only, never file contents or values.
 * The outcome is mailed back to the requesting coordinator conversation.
 */

export const NODE_ACTION_REQUESTS_CHANGED_EVENT = "node-action-requests-changed";
export const NODE_ACTION_REQUEST_TTL_MS = 24 * 60 * 60_000;
const MAX_REQUESTS = 200;

export type NodeActionKind =
  | "delete-environment"
  | "create-project"
  | "update-project-files"
  | "reveal-env-value"
  | "apply-root-changes";

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
  createdAt: string;
  expiresAt: string;
  state: NodeActionState;
  resolvedAt?: string;
  result?: { code: string; message: string };
}

/**
 * The user's final choices for an approval, where the request kind lets the
 * user adjust it while approving (a project copy's location and files).
 */
export interface NodeActionApproval {
  location?: string;
  paths?: string[];
  rememberFiles?: boolean;
}

export type NodeActionExecutor = (
  request: NodeActionRequest,
  approval: NodeActionApproval,
) => Promise<{ code: string; message: string; outcomeUnknown?: boolean }>;

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
  return approval;
}

export class NodeActionRequests {
  private requests: NodeActionRequest[] = [];
  private loadPromise: Promise<void> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

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
          existing.reason !== (input.reason ? input.reason.slice(0, 500) : undefined)
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
    await this.persist();
    const executor = this.options.executors[request.kind];
    if (!executor) {
      request.state = "failed";
      request.result = { code: "unsupported", message: "This kind of request cannot run here." };
    } else {
      try {
        const outcome = await executor(structuredClone(request), approval);
        request.state = outcome.outcomeUnknown ? "outcome-unknown" : "executed";
        request.result = { code: outcome.code, message: outcome.message };
      } catch (error) {
        request.state = "failed";
        request.result = {
          code: (error as { code?: unknown }).code
            ? String((error as { code?: unknown }).code)
            : "failed",
          message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        };
      }
    }
    await this.persist();
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
  }
}
