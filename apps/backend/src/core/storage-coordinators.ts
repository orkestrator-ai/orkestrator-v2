import { beginWorkerTabDelegation } from "./worker-tab-close-admission.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  COORDINATOR_WORKSPACE_VERSION,
  isCoordinatorWorkspace,
  normalizeCoordinatorRoles,
  normalizeCoordinatorSessionKeys,
  type CoordinatorWorkflowAssociation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import {
  isCoordinatorSurfaceAction,
  MAX_COORDINATOR_ACTION_RECEIPTS,
  MAX_COORDINATOR_ACTION_RESULT_BYTES,
  type CoordinatorActionReceipt,
  type CoordinatorSurfaceAction,
} from "@orkestrator/protocol/coordinator-surfaces";

import { assertValidPromptImages, mimeTypeForImageData } from "./prompt-attachments.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";
import type { DraftsRepository } from "./storage-drafts.js";

const MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS = 2_000;
const MAX_COORDINATOR_WORKFLOW_REQUEST_ALIASES = 256;

/**
 * Every coordinator's staged attachments, under the application data
 * directory. Only the backend writes here (`writeCoordinatorAttachment`), so
 * the renderer may read it back to preview an image the user pasted.
 */
export function coordinatorAttachmentsRoot(dataDir: string): string {
  return path.join(dataDir, "coordinator-attachments");
}

export class CoordinatorsRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  private enqueueCoordinatorMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.coordinatorsFile(), "coordinator storage", operation);
  }

  private async loadCoordinatorStore(): Promise<{
    version: 1;
    revision: number;
    workspaces: Record<string, CoordinatorWorkspace>;
    workflows: CoordinatorWorkflowAssociation[];
    actionReceipts: CoordinatorActionReceipt[];
  }> {
    const value = await this.context.loadJson<unknown>(this.files.coordinatorsFile(), () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      revision: 0,
      workspaces: {},
      workflows: [],
    }));
    const empty = () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      revision: 0,
      workspaces: {} as Record<string, CoordinatorWorkspace>,
      workflows: [] as CoordinatorWorkflowAssociation[],
      actionReceipts: [] as CoordinatorActionReceipt[],
    });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      console.warn("[coordinator] Ignoring malformed coordinator store");
      return empty();
    }
    const store = value as {
      version?: unknown;
      revision?: unknown;
      workspaces?: unknown;
      workflows?: unknown;
      actionReceipts?: unknown;
    };
    if (
      store.version !== COORDINATOR_WORKSPACE_VERSION ||
      !store.workspaces ||
      typeof store.workspaces !== "object" ||
      Array.isArray(store.workspaces)
    ) {
      console.warn("[coordinator] Ignoring unsupported coordinator store version");
      return empty();
    }
    const workspaces: Record<string, CoordinatorWorkspace> = {};
    for (const [projectId, workspace] of Object.entries(store.workspaces)) {
      // Codex-named bridge fields were upgraded once at import (storage-record-upgrades.ts).
      if (!isCoordinatorWorkspace(workspace) || workspace.projectId !== projectId) {
        console.warn("[coordinator] Ignoring invalid coordinator workspace record");
        continue;
      }
      // Read-time migration to one main plus side agents, and to the session
      // key the renderer uses; persisted on the next write, and idempotent
      // until then.
      workspaces[projectId] = normalizeCoordinatorSessionKeys(normalizeCoordinatorRoles(workspace));
    }
    const workflows = Array.isArray(store.workflows)
      ? store.workflows.filter(
          (item): item is CoordinatorWorkflowAssociation =>
            Boolean(item) &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof (item as CoordinatorWorkflowAssociation).id === "string" &&
            typeof (item as CoordinatorWorkflowAssociation).projectId === "string" &&
            typeof (item as CoordinatorWorkflowAssociation).coordinatorId === "string",
        )
      : [];
    const actionReceipts = Array.isArray(store.actionReceipts)
      ? store.actionReceipts.filter(isActionReceipt)
      : [];
    return {
      version: COORDINATOR_WORKSPACE_VERSION,
      revision: Number.isSafeInteger(store.revision) ? (store.revision as number) : 0,
      workspaces,
      workflows,
      actionReceipts,
    };
  }

  /**
   * Admit one coordinator surface action before it has any effect.
   *
   * Returns the receipt to replay when the same request already completed,
   * `claimed: true` when this caller must run the action (a new request, or a
   * pending one whose owner process is gone), and refuses a reused
   * `requestId` whose payload differs. A pending request still owned by a
   * live process is reported unclaimed so the caller can ask for a retry.
   */
  async admitCoordinatorActionReceipt(input: {
    coordinatorId: string;
    projectId: string;
    conversationId: string;
    requestId: string;
    action: CoordinatorSurfaceAction;
    payloadHash: string;
  }): Promise<{ receipt: CoordinatorActionReceipt; claimed: boolean }> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const existing = store.actionReceipts.find(
        (item) => item.coordinatorId === input.coordinatorId && item.requestId === input.requestId,
      );
      if (existing) {
        if (
          existing.action !== input.action ||
          existing.projectId !== input.projectId ||
          existing.payloadHash !== input.payloadHash
        ) {
          throw new Error("Coordinator request id was reused with a different payload");
        }
        if (existing.conversationId !== input.conversationId) {
          throw new Error("This request belongs to another coordinator conversation");
        }
        if (existing.state === "completed") return { receipt: existing, claimed: false };
        // This process included: a pending receipt it owns is still running
        // here (a failed run releases its receipt), so only a dead owner's
        // receipt is reclaimed.
        let ownerAlive = false;
        if (existing.claimPid) {
          try {
            process.kill(existing.claimPid, 0);
            ownerAlive = true;
          } catch {
            ownerAlive = false;
          }
        }
        if (ownerAlive) return { receipt: existing, claimed: false };
        existing.claimPid = process.pid;
        store.revision += 1;
        await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
        return { receipt: existing, claimed: true };
      }
      if (store.actionReceipts.length >= MAX_COORDINATOR_ACTION_RECEIPTS) {
        // Drop the oldest completed receipt; a pending one is still owed.
        const oldest = store.actionReceipts.findIndex((item) => item.state === "completed");
        if (oldest === -1) throw new Error("Coordinator action receipt store is full");
        store.actionReceipts.splice(oldest, 1);
      }
      const receipt: CoordinatorActionReceipt = {
        ...input,
        state: "pending",
        claimPid: process.pid,
        createdAt: new Date().toISOString(),
      };
      store.actionReceipts.push(receipt);
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      return { receipt, claimed: true };
    });
  }

  /** Record a claimed action's result so an identical retry replays it. */
  async completeCoordinatorActionReceipt(
    coordinatorId: string,
    requestId: string,
    result: Record<string, unknown>,
  ): Promise<CoordinatorActionReceipt> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const receipt = store.actionReceipts.find(
        (item) => item.coordinatorId === coordinatorId && item.requestId === requestId,
      );
      if (!receipt) throw new Error("Coordinator action receipt was not found");
      if (receipt.state === "completed") return receipt;
      const encoded = JSON.stringify(result);
      receipt.result =
        Buffer.byteLength(encoded, "utf8") > MAX_COORDINATOR_ACTION_RESULT_BYTES
          ? { truncated: true }
          : (JSON.parse(encoded) as Record<string, unknown>);
      receipt.state = "completed";
      receipt.completedAt = new Date().toISOString();
      delete receipt.claimPid;
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      return receipt;
    });
  }

  /**
   * Drop a pending receipt whose action failed before any effect, so the
   * same request may be retried as new. Completed receipts are kept.
   */
  async releaseCoordinatorActionReceipt(coordinatorId: string, requestId: string): Promise<void> {
    await this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const index = store.actionReceipts.findIndex(
        (item) =>
          item.coordinatorId === coordinatorId &&
          item.requestId === requestId &&
          item.state === "pending",
      );
      if (index === -1) return;
      store.actionReceipts.splice(index, 1);
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
    });
  }

  async getCoordinatorWorkspace(projectId: string): Promise<CoordinatorWorkspace | null> {
    return (await this.loadCoordinatorStore()).workspaces[projectId] ?? null;
  }

  async getCoordinatorWorkspaceById(coordinatorId: string): Promise<CoordinatorWorkspace | null> {
    return (
      Object.values((await this.loadCoordinatorStore()).workspaces).find(
        (workspace) => workspace.id === coordinatorId,
      ) ?? null
    );
  }

  async listCoordinatorWorkspaces(): Promise<CoordinatorWorkspace[]> {
    return Object.values((await this.loadCoordinatorStore()).workspaces);
  }

  async listCoordinatorWorkflowAssociations(
    projectId: string,
  ): Promise<CoordinatorWorkflowAssociation[]> {
    return (await this.loadCoordinatorStore()).workflows.filter(
      (association) => association.projectId === projectId,
    );
  }

  async listAllCoordinatorWorkflowAssociations(): Promise<CoordinatorWorkflowAssociation[]> {
    return (await this.loadCoordinatorStore()).workflows;
  }

  async getCoordinatorReconciliationState(): Promise<{
    workspaces: CoordinatorWorkspace[];
    workflows: CoordinatorWorkflowAssociation[];
  }> {
    const store = await this.loadCoordinatorStore();
    return { workspaces: Object.values(store.workspaces), workflows: store.workflows };
  }

  /** Keep the draft snapshot stable through the coordinator write. Lock order is drafts, then coordinator. */
  async mutateCoordinatorWorkspaceWithComposeDrafts(
    projectId: string,
    mutate: (
      current: CoordinatorWorkspace | null,
      drafts: Awaited<ReturnType<DraftsRepository["listComposeDrafts"]>>,
    ) => CoordinatorWorkspace | null,
  ): Promise<CoordinatorWorkspace | null> {
    return this.repos.prompts.enqueueComposeDraftMutation(async () => {
      const drafts = Object.values(await this.repos.prompts.loadComposeDrafts());
      return this.mutateCoordinatorWorkspace(projectId, (current) => mutate(current, drafts));
    });
  }

  async mutateCoordinatorWorkspace(
    projectId: string,
    mutate: (current: CoordinatorWorkspace | null) => CoordinatorWorkspace | null,
  ): Promise<CoordinatorWorkspace | null> {
    if (!projectId.trim()) throw new Error("Coordinator project id is required");
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const current = store.workspaces[projectId] ?? null;
      const mutated = mutate(current);
      // Every write keeps the one-main and session-key invariants, whatever
      // the mutator did.
      const next =
        mutated && mutated !== current
          ? normalizeCoordinatorSessionKeys(normalizeCoordinatorRoles(mutated))
          : mutated;
      if (next && (!isCoordinatorWorkspace(next) || next.projectId !== projectId)) {
        throw new Error("Coordinator workspace mutation returned an invalid record");
      }
      if (next === current) return current;
      if (next) store.workspaces[projectId] = next;
      else delete store.workspaces[projectId];
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      this.context.changes.announce("coordinator", projectId, projectId);
      return next;
    });
  }

  async saveCoordinatorWorkflowAssociation(
    association: CoordinatorWorkflowAssociation,
  ): Promise<CoordinatorWorkflowAssociation> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const duplicate = store.workflows.find(
        (item) =>
          item.coordinatorId === association.coordinatorId &&
          item.requestId === association.requestId,
      );
      if (duplicate) {
        if (
          duplicate.kind !== association.kind ||
          duplicate.resourceId !== association.resourceId ||
          duplicate.nodeId !== association.nodeId ||
          duplicate.projectId !== association.projectId ||
          (duplicate.payloadHash &&
            association.payloadHash &&
            duplicate.payloadHash !== association.payloadHash)
        ) {
          throw new Error("Coordinator request id was reused with a different payload");
        }
        return duplicate;
      }
      if (store.workflows.length >= MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS) {
        throw new Error("Coordinator workflow association store is full");
      }
      store.workflows.push(association);
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      return association;
    });
  }

  async reserveCoordinatorWorkflowAssociation(
    association: CoordinatorWorkflowAssociation,
  ): Promise<{ association: CoordinatorWorkflowAssociation; claimed: boolean }> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const existing = store.workflows.find(
        (item) =>
          item.coordinatorId === association.coordinatorId &&
          item.requestId === association.requestId,
      );
      if (existing) {
        if (
          existing.kind !== association.kind ||
          existing.projectId !== association.projectId ||
          existing.nodeId !== association.nodeId ||
          existing.payloadHash !== association.payloadHash
        ) {
          throw new Error("Coordinator request id was reused with a different payload");
        }
        if (!existing.pending) return { association: existing, claimed: false };
        let ownerAlive = false;
        if (existing.claimPid && existing.claimPid !== process.pid) {
          try {
            process.kill(existing.claimPid, 0);
            ownerAlive = true;
          } catch {
            ownerAlive = false;
          }
        }
        if (ownerAlive) return { association: existing, claimed: false };
        existing.claimPid = process.pid;
        store.revision += 1;
        await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
        return { association: existing, claimed: true };
      }
      if (store.workflows.length >= MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS) {
        throw new Error("Coordinator workflow association store is full");
      }
      const reserved = { ...association, pending: true, claimPid: process.pid };
      store.workflows.push(reserved);
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      return { association: reserved, claimed: true };
    });
  }

  async completeCoordinatorWorkflowAssociation(
    associationId: string,
    resourceId: string,
  ): Promise<CoordinatorWorkflowAssociation> {
    if (!resourceId.trim()) throw new Error("Coordinator workflow resource id is required");
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const association = store.workflows.find((item) => item.id === associationId);
      if (!association) throw new Error("Coordinator workflow reservation was not found");
      if (!association.pending && association.resourceId !== resourceId) {
        throw new Error("Coordinator workflow reservation is already complete");
      }
      // A leaf may reuse an active review after our pre-launch inventory read.
      // Reconcile the actual workflow ID under the store mutation lock.
      const owner =
        association.kind === "multi-review" && association.nodeId
          ? store.workflows.find(
              (item) =>
                item.id !== association.id &&
                !item.pending &&
                item.kind === association.kind &&
                item.nodeId === association.nodeId &&
                item.resourceId === resourceId,
            )
          : undefined;
      if (owner) {
        if (
          owner.coordinatorId !== association.coordinatorId ||
          owner.conversationId !== association.conversationId
        ) {
          throw new Error(
            "This active review belongs to another conversation; adopt its workflow before opening it",
          );
        }
        if (!association.payloadHash) {
          throw new Error(
            "Coordinator request payload hash is required to share an existing review",
          );
        }
        const aliases = [
          ...(owner.requestAliases ?? []),
          { requestId: association.requestId, payloadHash: association.payloadHash },
          ...(association.requestAliases ?? []),
        ];
        if (aliases.length > MAX_COORDINATOR_WORKFLOW_REQUEST_ALIASES) {
          throw new Error("Coordinator workflow association has too many request aliases");
        }
        owner.requestAliases = aliases;
        store.workflows = store.workflows.filter((item) => item.id !== association.id);
        store.revision += 1;
        await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
        return owner;
      }
      association.resourceId = resourceId;
      association.pending = false;
      delete association.claimPid;
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      // A completed launch makes this conversation the environment's creator,
      // which changes how its mail is routed.
      this.context.changes.announce("coordinator", association.projectId, association.projectId);
      return association;
    });
  }

  /**
   * Drops a reservation whose launch was refused before it created anything
   * (a graph launch's definite refusal, item 214), so the same request id can
   * be retried with a corrected payload. Only a still-pending reservation this
   * process holds is removed; whether one was.
   */
  async releasePendingCoordinatorWorkflowAssociation(associationId: string): Promise<boolean> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const association = store.workflows.find((item) => item.id === associationId);
      if (!association?.pending || association.claimPid !== process.pid) return false;
      store.workflows = store.workflows.filter((item) => item.id !== associationId);
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      return true;
    });
  }

  async addCoordinatorWorkflowRequestAlias(
    associationId: string,
    coordinatorId: string,
    conversationId: string,
    requestId: string,
    payloadHash: string,
  ): Promise<CoordinatorWorkflowAssociation> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const existingRequest = store.workflows.find(
        (item) =>
          item.coordinatorId === coordinatorId &&
          (item.requestId === requestId ||
            (Array.isArray(item.requestAliases) &&
              item.requestAliases.some(
                (alias) =>
                  alias && typeof alias.requestId === "string" && alias.requestId === requestId,
              ))),
      );
      if (existingRequest) {
        const existingHash =
          existingRequest.requestId === requestId
            ? existingRequest.payloadHash
            : Array.isArray(existingRequest.requestAliases)
              ? existingRequest.requestAliases.find(
                  (alias) =>
                    alias &&
                    typeof alias.requestId === "string" &&
                    typeof alias.payloadHash === "string" &&
                    alias.requestId === requestId,
                )?.payloadHash
              : undefined;
        if (existingRequest.id !== associationId || existingHash !== payloadHash) {
          throw new Error("Coordinator request id was reused with a different payload");
        }
        return existingRequest;
      }
      const association = store.workflows.find(
        (item) =>
          item.id === associationId &&
          item.coordinatorId === coordinatorId &&
          item.conversationId === conversationId &&
          !item.pending,
      );
      if (!association) throw new Error("Coordinator workflow association is unavailable");
      const aliases = Array.isArray(association.requestAliases)
        ? association.requestAliases.filter(
            (alias) =>
              alias && typeof alias.requestId === "string" && typeof alias.payloadHash === "string",
          )
        : [];
      if (aliases.length >= MAX_COORDINATOR_WORKFLOW_REQUEST_ALIASES) {
        throw new Error("Coordinator workflow association has too many request aliases");
      }
      association.requestAliases = [...aliases, { requestId, payloadHash }];
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      return association;
    });
  }

  /** Open one idempotent delegation without replacing another request. */
  async openCoordinatorDelegation(
    associationId: string,
    workerTabId: string,
    at = new Date().toISOString(),
  ): Promise<CoordinatorWorkflowAssociation | null> {
    if (!workerTabId.trim()) throw new Error("Coordinator delegation worker tab id is required");
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const association = store.workflows.find((item) => item.id === associationId);
      if (!association) return null;
      if (association.delegation) {
        if (association.delegation.workerTabId !== workerTabId) {
          throw new Error("Coordinator request id was reused for a different worker tab");
        }
        // A retry of the same request must neither reset a running delegation
        // nor reopen one that already produced its wake.
        return association;
      }
      const release = association.nodeId
        ? () => {}
        : beginWorkerTabDelegation(association.resourceId, workerTabId);
      try {
        if (
          !association.nodeId &&
          (await this.repos.projects.getEnvironment(association.resourceId))?.tabTeardownIntents?.[
            workerTabId
          ]
        )
          throw new Error(
            "This tab has pending teardown; finish closing it before delegating more work",
          );
        const overlapping = store.workflows.find(
          (item) =>
            item.id !== associationId &&
            item.coordinatorId === association.coordinatorId &&
            item.conversationId === association.conversationId &&
            item.kind === "environment" &&
            item.resourceId === association.resourceId &&
            item.nodeId === association.nodeId &&
            item.delegation?.workerTabId === workerTabId &&
            item.delegation.state === "running",
        );
        if (overlapping) {
          throw new Error("That worker tab already has an outstanding coordinator delegation");
        }
        association.delegation = { requestedAt: at, workerTabId, state: "running" };
        store.revision += 1;
        await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
        this.context.changes.announce("coordinator", association.projectId, association.projectId);
        return association;
      } finally {
        release();
      }
    });
  }

  /** Every delegation still waiting on its worker, for turn-end matching. */
  async listOpenCoordinatorDelegations(): Promise<CoordinatorWorkflowAssociation[]> {
    return (await this.loadCoordinatorStore()).workflows.filter(
      (association) => association.delegation?.state === "running",
    );
  }

  /**
   * Every delegation whose worker has finished but whose wake was not delivered.
   *
   * The close and the wake are two writes, so a crash between them is possible.
   * This is what the reconcile sweep re-reads to finish the job.
   */
  async listUnwokenCoordinatorDelegations(): Promise<CoordinatorWorkflowAssociation[]> {
    return (await this.loadCoordinatorStore()).workflows.filter(
      (association) =>
        association.delegation !== undefined &&
        association.delegation.state !== "running" &&
        !association.delegation.wokenAt,
    );
  }

  /**
   * Record that a delegation's worker finished.
   *
   * Returns null when the delegation was already closed, so the caller can tell
   * "I observed the edge" from "I am the one that observed it first" and only
   * the winner releases mail or sends a notice.
   */
  async closeCoordinatorDelegation(
    associationId: string,
    state: "completed" | "failed" | "stopped",
    at = new Date().toISOString(),
    backgroundWorkTimeoutMs?: number,
  ): Promise<CoordinatorWorkflowAssociation | null> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const association = store.workflows.find((item) => item.id === associationId);
      if (!association?.delegation || association.delegation.state !== "running") return null;
      association.delegation = {
        ...association.delegation,
        state,
        completedAt: at,
        ...(state === "completed" && backgroundWorkTimeoutMs !== undefined
          ? { backgroundWorkTimeoutMs }
          : {}),
      };
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      this.context.changes.announce("coordinator", association.projectId, association.projectId);
      return association;
    });
  }

  /**
   * Persist what kind of wake this delegation owns before performing the
   * separate mail-store write. A retry can then distinguish an already-released
   * report from a genuinely silent worker.
   */
  async prepareCoordinatorDelegationWake(
    associationId: string,
    wakeKind: "report" | "notice",
  ): Promise<CoordinatorWorkflowAssociation | null> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const association = store.workflows.find((item) => item.id === associationId);
      if (!association?.delegation || association.delegation.state === "running") return null;
      if (association.delegation.wakeKind) return association;
      association.delegation = { ...association.delegation, wakeKind };
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      this.context.changes.announce("coordinator", association.projectId, association.projectId);
      return association;
    });
  }

  /** Stamp a delivered wake so a retry after a crash cannot send a second one. */
  async markCoordinatorDelegationWoken(
    associationId: string,
    at = new Date().toISOString(),
  ): Promise<void> {
    await this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const association = store.workflows.find((item) => item.id === associationId);
      if (!association?.delegation || association.delegation.wokenAt) return;
      association.delegation = { ...association.delegation, wokenAt: at };
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      this.context.changes.announce("coordinator", association.projectId, association.projectId);
    });
  }

  /**
   * Serialized read-modify-write of one association's bookkeeping.
   *
   * `mutate` edits the stored record in place and returns whether it changed;
   * nothing is written otherwise. Most status-wake bookkeeping is backend-only
   * and is not announced. A waiting episode starting or ending is: the
   * coordinator panel marks that worker as needing a person.
   */
  async updateCoordinatorWorkflowAssociation(
    associationId: string,
    mutate: (association: CoordinatorWorkflowAssociation) => boolean,
  ): Promise<CoordinatorWorkflowAssociation | null> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const association = store.workflows.find((item) => item.id === associationId);
      if (!association) return null;
      const waitingBefore = association.delegation?.waiting?.since;
      if (!mutate(association)) return association;
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      if (association.delegation?.waiting?.since !== waitingBefore) {
        this.context.changes.announce("coordinator", association.projectId, association.projectId);
      }
      return association;
    });
  }

  async markCoordinatorWorkflowNotified(associationId: string, revision: number): Promise<void> {
    await this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const association = store.workflows.find((item) => item.id === associationId);
      if (
        !association ||
        (association.terminalNotifiedAt && (association.lastNotifiedRevision ?? -1) >= revision)
      )
        return;
      association.lastNotifiedRevision = revision;
      association.terminalNotifiedAt = new Date().toISOString();
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
    });
  }

  async adoptCoordinatorWorkflowAssociation(
    projectId: string,
    coordinatorId: string,
    associationId: string,
    conversationId: string,
    /** Backend-only: the main coordinator takes work from a side agent that is still open. */
    options: { force?: boolean } = {},
  ): Promise<CoordinatorWorkflowAssociation> {
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const workspace = store.workspaces[projectId];
      if (
        !workspace ||
        workspace.id !== coordinatorId ||
        !workspace.conversations.some((item) => item.id === conversationId && !item.closedAt)
      ) {
        throw new Error("Coordinator conversation is unavailable");
      }
      const association = store.workflows.find(
        (item) =>
          item.id === associationId &&
          item.projectId === projectId &&
          item.coordinatorId === coordinatorId,
      );
      if (!association) throw new Error("Coordinator workflow association was not found");
      if (
        !options.force &&
        association.conversationId &&
        association.conversationId !== conversationId
      ) {
        const currentConversation = workspace.conversations.find(
          (item) => item.id === association.conversationId,
        );
        if (currentConversation && !currentConversation.closedAt) {
          throw new Error("Coordinator workflow belongs to another open conversation");
        }
      }
      association.conversationId = conversationId;
      association.adoptedByConversationId = conversationId;
      // A completion notice addressed to the retired mailbox does not notify
      // the adopting conversation. Re-open the durable delivery intent; its
      // conversation-scoped idempotency key prevents duplicate delivery here.
      delete association.lastNotifiedRevision;
      delete association.terminalNotifiedAt;
      delete association.statusNotice;
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
      this.context.changes.announce("coordinator", association.projectId, association.projectId);
      return association;
    });
  }

  /**
   * Where one conversation's attachments live, outside the project checkout.
   *
   * A coordinator points at the user's own repository and must never write to
   * it, so a pasted image is staged here instead. The bridge launcher hands
   * this exact directory to the provider process as its extra readable
   * attachment root, which is why the path is computed in one place rather
   * than spelled out again at the launcher.
   */
  coordinatorAttachmentDirectory(coordinatorId: string, conversationId: string): string {
    return path.join(
      coordinatorAttachmentsRoot(this.context.dataDir),
      coordinatorId,
      conversationId,
    );
  }

  /**
   * Reclaim attachment directories after closed conversations leave the
   * durable retention window.
   *
   * This sweeps the coordinator directory rather than deleting only the ids
   * pruned by one mutation. A cleanup interrupted after the store write is
   * therefore retried by the next retention pass instead of becoming a
   * permanent orphan.
   */
  async pruneCoordinatorAttachmentDirectories(
    coordinatorId: string,
    retainedConversationIds: ReadonlySet<string>,
  ): Promise<void> {
    const root = path.join(coordinatorAttachmentsRoot(this.context.dataDir), coordinatorId);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    await Promise.all(
      entries
        .filter((entry) => !retainedConversationIds.has(entry.name))
        .map((entry) => fs.rm(path.join(root, entry.name), { recursive: true, force: true })),
    );
  }

  async writeCoordinatorAttachment(
    coordinatorId: string,
    conversationId: string,
    filename: string,
    base64Data: string,
  ): Promise<string> {
    const workspace = await this.getCoordinatorWorkspaceById(coordinatorId);
    if (
      !workspace ||
      !workspace.conversations.some((item) => item.id === conversationId && !item.closedAt)
    ) {
      throw new Error("Coordinator conversation is unavailable");
    }
    const [image] = assertValidPromptImages([{ filename, data: base64Data }]);
    if (!image) throw new Error("Coordinator attachment is invalid");
    const mediaType = mimeTypeForImageData(image.filename, image.data);
    const extension = mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
    const directory = this.coordinatorAttachmentDirectory(coordinatorId, conversationId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${randomUUID()}.${extension}`);
    await fs.writeFile(target, Buffer.from(image.data, "base64"), { flag: "wx", mode: 0o600 });
    return target;
  }

  async deleteCoordinatorByProject(projectId: string): Promise<void> {
    let coordinatorId: string | undefined;
    await this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      coordinatorId = store.workspaces[projectId]?.id;
      delete store.workspaces[projectId];
      store.workflows = store.workflows.filter((item) => item.projectId !== projectId);
      store.actionReceipts = store.actionReceipts.filter((item) => item.projectId !== projectId);
      store.revision += 1;
      await this.context.saveSensitiveJson(this.files.coordinatorsFile(), store);
    });
    if (coordinatorId) {
      await Promise.all([
        fs.rm(path.join(coordinatorAttachmentsRoot(this.context.dataDir), coordinatorId), {
          recursive: true,
          force: true,
        }),
        fs.rm(path.join(this.context.dataDir, "coordinator-runtime", coordinatorId), {
          recursive: true,
          force: true,
        }),
      ]);
    }
  }
}

/**
 * Coordinator workspaces, workflow associations, delegations and attachments: what callers reach as `storage.coordinators`.
 *
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to, like a public method of `StorageService`. Add a
 * method here only when code outside the storage files calls it.
 */
export type CoordinatorsStorage = Pick<
  CoordinatorsRepository,
  | "getCoordinatorWorkspace"
  | "getCoordinatorWorkspaceById"
  | "listCoordinatorWorkspaces"
  | "listCoordinatorWorkflowAssociations"
  | "getCoordinatorReconciliationState"
  | "mutateCoordinatorWorkspaceWithComposeDrafts"
  | "mutateCoordinatorWorkspace"
  | "saveCoordinatorWorkflowAssociation"
  | "reserveCoordinatorWorkflowAssociation"
  | "completeCoordinatorWorkflowAssociation"
  | "releasePendingCoordinatorWorkflowAssociation"
  | "addCoordinatorWorkflowRequestAlias"
  | "openCoordinatorDelegation"
  | "listOpenCoordinatorDelegations"
  | "listUnwokenCoordinatorDelegations"
  | "closeCoordinatorDelegation"
  | "prepareCoordinatorDelegationWake"
  | "markCoordinatorDelegationWoken"
  | "updateCoordinatorWorkflowAssociation"
  | "markCoordinatorWorkflowNotified"
  | "adoptCoordinatorWorkflowAssociation"
  | "coordinatorAttachmentDirectory"
  | "pruneCoordinatorAttachmentDirectories"
  | "writeCoordinatorAttachment"
  | "deleteCoordinatorByProject"
  | "admitCoordinatorActionReceipt"
  | "completeCoordinatorActionReceipt"
  | "releaseCoordinatorActionReceipt"
>;

function isActionReceipt(value: unknown): value is CoordinatorActionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.coordinatorId === "string" &&
    typeof item.projectId === "string" &&
    typeof item.conversationId === "string" &&
    typeof item.requestId === "string" &&
    isCoordinatorSurfaceAction(item.action) &&
    typeof item.payloadHash === "string" &&
    (item.state === "pending" || item.state === "completed") &&
    typeof item.createdAt === "string"
  );
}
