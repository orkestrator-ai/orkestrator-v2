export * from "./storage-shared.js";

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  COORDINATOR_WORKSPACE_VERSION,
  isCoordinatorWorkspace,
  type CoordinatorWorkflowAssociation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";

import { StorageKanban } from "./storage-kanban.js";
import { assertValidPromptImages, mimeTypeForImageData } from "./prompt-attachments.js";

const MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS = 2_000;

export class StorageService extends StorageKanban {
  override async init(): Promise<void> {
    await super.init();
    await this.migrateConfigSchema();
    await this.migrateNativeAgentSessionOwners();
  }

  private async migrateNativeAgentSessionOwners(): Promise<void> {
    await this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const environmentById = new Map(
        (await this.loadEnvironments()).map((environment) => [environment.id, environment]),
      );
      let changed = loaded.migrated;
      for (const session of Object.values(loaded.sessions)) {
        if (session.owner) continue;
        const environment = environmentById.get(session.environmentId);
        if (!environment) continue;
        session.owner = {
          kind: "environment",
          projectId: environment.projectId,
          environmentId: environment.id,
        };
        changed = true;
      }
      if (changed) await this.saveNativeAgentSessions(loaded.sessions, loaded.opaque);
    });
  }

  private async loadCoordinatorStore(): Promise<{
    version: 1;
    revision: number;
    workspaces: Record<string, CoordinatorWorkspace>;
    workflows: CoordinatorWorkflowAssociation[];
  }> {
    const value = await this.loadJson<unknown>(this.coordinatorsFile(), () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      revision: 0,
      workspaces: {},
      workflows: [],
    }));
    /**
     * Coordinator bridges were Codex-only, so the persisted identity was named
     * for it. Reading the old keys keeps a live bridge attached across the
     * upgrade; without this the reaper would not see the running child and the
     * next launch would allocate a second one against the same rollout.
     */
    const migrateCoordinatorBridgeFields = (workspace: unknown): unknown => {
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return workspace;
      const record = workspace as Record<string, unknown> & {
        conversations?: unknown;
      };
      const rename = (item: Record<string, unknown>): Record<string, unknown> => {
        const { codexBridgePort, codexBridgePid, ...rest } = item;
        if (codexBridgePort === undefined && codexBridgePid === undefined) return item;
        return {
          ...rest,
          ...(rest.bridgePort === undefined && typeof codexBridgePort === "number"
            ? { bridgePort: codexBridgePort }
            : {}),
          ...(rest.bridgePid === undefined && typeof codexBridgePid === "number"
            ? { bridgePid: codexBridgePid }
            : {}),
        };
      };
      return {
        ...rename(record),
        ...(Array.isArray(record.conversations)
          ? {
              conversations: record.conversations.map((conversation) =>
                conversation && typeof conversation === "object" && !Array.isArray(conversation)
                  ? rename(conversation as Record<string, unknown>)
                  : conversation,
              ),
            }
          : {}),
      };
    };
    const empty = () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      revision: 0,
      workspaces: {} as Record<string, CoordinatorWorkspace>,
      workflows: [] as CoordinatorWorkflowAssociation[],
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
      const migrated = migrateCoordinatorBridgeFields(workspace);
      if (!isCoordinatorWorkspace(migrated) || migrated.projectId !== projectId) {
        console.warn("[coordinator] Ignoring invalid coordinator workspace record");
        continue;
      }
      workspaces[projectId] = migrated;
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
    return {
      version: COORDINATOR_WORKSPACE_VERSION,
      revision: Number.isSafeInteger(store.revision) ? (store.revision as number) : 0,
      workspaces,
      workflows,
    };
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

  async getCoordinatorReconciliationState(): Promise<{
    workspaces: CoordinatorWorkspace[];
    workflows: CoordinatorWorkflowAssociation[];
  }> {
    const store = await this.loadCoordinatorStore();
    return { workspaces: Object.values(store.workspaces), workflows: store.workflows };
  }

  async mutateCoordinatorWorkspace(
    projectId: string,
    mutate: (current: CoordinatorWorkspace | null) => CoordinatorWorkspace | null,
  ): Promise<CoordinatorWorkspace | null> {
    if (!projectId.trim()) throw new Error("Coordinator project id is required");
    return this.enqueueCoordinatorMutation(async () => {
      const store = await this.loadCoordinatorStore();
      const current = store.workspaces[projectId] ?? null;
      const next = mutate(current);
      if (next && (!isCoordinatorWorkspace(next) || next.projectId !== projectId)) {
        throw new Error("Coordinator workspace mutation returned an invalid record");
      }
      if (next === current) return current;
      if (next) store.workspaces[projectId] = next;
      else delete store.workspaces[projectId];
      store.revision += 1;
      await this.saveSensitiveJson(this.coordinatorsFile(), store);
      this.announce("coordinator", projectId, projectId);
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
      await this.saveSensitiveJson(this.coordinatorsFile(), store);
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
        await this.saveSensitiveJson(this.coordinatorsFile(), store);
        return { association: existing, claimed: true };
      }
      if (store.workflows.length >= MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS) {
        throw new Error("Coordinator workflow association store is full");
      }
      const reserved = { ...association, pending: true, claimPid: process.pid };
      store.workflows.push(reserved);
      store.revision += 1;
      await this.saveSensitiveJson(this.coordinatorsFile(), store);
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
      association.resourceId = resourceId;
      association.pending = false;
      delete association.claimPid;
      store.revision += 1;
      await this.saveSensitiveJson(this.coordinatorsFile(), store);
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
      await this.saveSensitiveJson(this.coordinatorsFile(), store);
    });
  }

  async adoptCoordinatorWorkflowAssociation(
    projectId: string,
    coordinatorId: string,
    associationId: string,
    conversationId: string,
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
      if (association.conversationId && association.conversationId !== conversationId) {
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
      store.revision += 1;
      await this.saveSensitiveJson(this.coordinatorsFile(), store);
      return association;
    });
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
    const directory = path.join(
      this.dataDir,
      "coordinator-attachments",
      coordinatorId,
      conversationId,
    );
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
      store.revision += 1;
      await this.saveSensitiveJson(this.coordinatorsFile(), store);
    });
    if (coordinatorId) {
      await Promise.all([
        fs.rm(path.join(this.dataDir, "coordinator-attachments", coordinatorId), {
          recursive: true,
          force: true,
        }),
        fs.rm(path.join(this.dataDir, "coordinator-runtime", coordinatorId), {
          recursive: true,
          force: true,
        }),
      ]);
    }
  }
}
