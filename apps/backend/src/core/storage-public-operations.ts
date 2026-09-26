import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isPublicActionName,
  isPublicNamespace,
  isPublicRequestId,
  PUBLIC_OPERATION_RETENTION,
  PUBLIC_API_LIMITS,
  type PublicActionName,
} from "@orkestrator/protocol/public-api";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { Environment, PortMapping, Project, RepositoryConfig } from "./models.js";
import { PublicActionError } from "./public-api/errors.js";
import {
  boundRecord,
  currentNamespace,
  emptyIndex,
  isActiveRecord,
  isPublicOperationRecord,
  MAX_RETIRED_NAMESPACES,
  namespaceAdmissionEnds,
  namespaceFence,
  namespaceOfOperationId,
  namespaceStatus,
  newOperationId,
  PUBLIC_OPERATION_RECORD_VERSION,
  recordBytes,
  requestKey,
  type PublicAuthority,
  type PublicOperationIndex,
  type PublicOperationRecord,
} from "./public-api/operation-ledger.js";
import {
  environmentSettingsRevision,
  projectRevision,
  repositorySettingsRevision,
} from "./public-api/revisions.js";
import { StoragePreviewServices } from "./storage-preview-services.js";
import { normalizeAgentSettings } from "@orkestrator/protocol/agent-settings";
import { withoutUrlCredentials } from "@orkestrator/protocol/git-remote-url";
import { applyProjectFolder } from "./storage-projects.js";
import { defaultRepositoryConfig } from "./storage-shared.js";

interface NamespaceFile {
  version: 1;
  namespace: string;
  operations: PublicOperationRecord[];
}

export interface AdmitPublicOperationInput {
  authority: PublicAuthority;
  action: PublicActionName;
  scope: string;
  requestId: string;
  /** Explicit namespace from the caller's receipt; omitted means current. */
  namespace?: string;
  requestKey: string;
  fingerprint: string;
  resolved?: PublicOperationRecord["resolved"];
  resources?: PublicOperationRecord["resources"];
  generation: string;
  now?: number;
}

export type PublicOperationLookup =
  | { status: "found"; record: PublicOperationRecord }
  | { status: "missing" }
  | { status: "expired"; namespace: string };

/**
 * Durable public operation receipts and the revision-checked edits public
 * actions make. Records live in one file per namespace under
 * `public-operations/`, guarded by a cross-process lock; the admission check,
 * the key reservation and the record publication happen in one critical
 * section before any side effect runs.
 */
export class StoragePublicOperations extends StoragePreviewServices {
  protected publicOperationQueue: Promise<unknown> = Promise.resolve();
  protected publicOperationLimits: {
    maxOperationsPerNamespace: number;
    maxNamespaceBytes: number;
  } = {
    maxOperationsPerNamespace: PUBLIC_OPERATION_RETENTION.maxOperationsPerNamespace,
    maxNamespaceBytes: PUBLIC_OPERATION_RETENTION.maxNamespaceBytes,
  };

  /** Tests only: shrink the per-namespace capacity to exercise refusal. */
  setPublicOperationLimitsForTesting(
    limits: Partial<StoragePublicOperations["publicOperationLimits"]>,
  ): void {
    this.publicOperationLimits = { ...this.publicOperationLimits, ...limits };
  }

  protected publicOperationsDir(): string {
    return this.file("public-operations");
  }

  protected publicOperationIndexFile(): string {
    return path.join(this.publicOperationsDir(), "index.json");
  }

  protected publicOperationNamespaceFile(namespace: string): string {
    if (!/^ns-[0-9]{13}-[a-f0-9]{8}$/.test(namespace)) throw new Error("Invalid namespace");
    return path.join(this.publicOperationsDir(), `${namespace}.json`);
  }

  protected enqueuePublicOperationMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        path.join(this.publicOperationsDir(), "store"),
        "public operation store",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.publicOperationQueue.then(run, run);
    this.publicOperationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Strict read: a store that exists but cannot be parsed (and has no usable
   * backup) is an error, never "empty". Treating it as empty would reopen
   * every key it held.
   */
  private async readStrictJson<T>(file: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      const recovered = await this.recoverJsonFromBackups<T>(file);
      if (recovered) return recovered.value;
      throw new PublicActionError(
        "internal-error",
        "The public operation store is unreadable; admissions are refused until it is repaired",
      );
    }
  }

  async loadPublicOperationIndex(): Promise<PublicOperationIndex> {
    const value = await this.readStrictJson<PublicOperationIndex>(this.publicOperationIndexFile());
    if (!value) return emptyIndex();
    if (value.version !== 1 || !Array.isArray(value.namespaces) || !Array.isArray(value.retired)) {
      throw new PublicActionError("internal-error", "The public operation index is malformed");
    }
    return value;
  }

  private async loadNamespaceRecords(namespace: string): Promise<PublicOperationRecord[]> {
    const value = await this.readStrictJson<NamespaceFile>(
      this.publicOperationNamespaceFile(namespace),
    );
    if (!value) return [];
    if (!Array.isArray(value.operations)) {
      throw new PublicActionError(
        "internal-error",
        "A public operation namespace file is malformed",
      );
    }
    if (
      value.operations.some(
        (record) =>
          !isPublicOperationRecord(record) ||
          !isPublicActionName(record.action) ||
          !isPublicNamespace(record.namespace) ||
          !isPublicRequestId(record.requestId) ||
          record.namespace !== namespace ||
          namespaceOfOperationId(record.operationId) !== namespace ||
          record.requestKey !==
            requestKey(record.authority, record.action, record.scope, record.requestId) ||
          !/^[a-f0-9]{64}$/.test(record.fingerprint),
      )
    ) {
      throw new PublicActionError(
        "internal-error",
        "A public operation namespace is malformed; admissions are refused until it is repaired",
      );
    }
    return value.operations as PublicOperationRecord[];
  }

  private async saveNamespaceRecords(
    namespace: string,
    operations: PublicOperationRecord[],
  ): Promise<void> {
    await this.saveSensitiveJson(this.publicOperationNamespaceFile(namespace), {
      version: 1,
      namespace,
      operations,
    } satisfies NamespaceFile);
  }

  private async indexWithCurrent(now: number): Promise<PublicOperationIndex> {
    const loaded = await this.loadPublicOperationIndex();
    const { index, rotated } = currentNamespace(loaded, now);
    if (rotated) await this.saveSensitiveJson(this.publicOperationIndexFile(), index);
    return index;
  }

  /** Current and retained namespaces, rotating the current one when due. */
  async publicOperationNamespaces(
    now = Date.now(),
  ): Promise<{ current: string; retained: string[] }> {
    return this.enqueuePublicOperationMutation(async () => {
      const index = await this.indexWithCurrent(now);
      return {
        current: index.namespaces.at(-1)!.id,
        retained: index.namespaces.map((entry) => entry.id),
      };
    });
  }

  /**
   * Reserve a request key and publish its operation record, or return the
   * existing record for the same key. Nothing may run before this resolves;
   * if it throws, the caller must not execute.
   */
  async admitPublicOperation(
    input: AdmitPublicOperationInput,
  ): Promise<{ record: PublicOperationRecord; replayed: boolean }> {
    const now = input.now ?? Date.now();
    return this.enqueuePublicOperationMutation(async () => {
      const index = await this.indexWithCurrent(now);
      const current = index.namespaces.at(-1)!;
      if (input.namespace !== undefined) {
        const status = namespaceStatus(index, input.namespace);
        if (status === "retired") {
          throw new PublicActionError(
            "namespace-expired",
            "This request key's namespace has been retired; its history is no longer retained. Use a new request ID for new work.",
            { details: { namespace: input.namespace } },
          );
        }
        if (status === "unknown") {
          throw new PublicActionError(
            "invalid-input",
            "The request namespace was not issued by this backend installation",
          );
        }
      }
      // A key is looked up across every retained namespace, so a retry that
      // lost its local receipt still converges while its history exists.
      for (const entry of [...index.namespaces].reverse()) {
        const records = await this.loadNamespaceRecords(entry.id);
        const existing = records.find(
          (record) => isPublicOperationRecord(record) && record.requestKey === input.requestKey,
        );
        if (!existing) continue;
        if (existing.fingerprint !== input.fingerprint) {
          throw new PublicActionError(
            "request-conflict",
            "This request ID was already used for a different request",
            { details: { operationId: existing.operationId, namespace: existing.namespace } },
          );
        }
        return { record: existing, replayed: true };
      }
      if (input.action === "environment.exec" && input.resources?.environmentId) {
        let active = 0;
        for (const entry of index.namespaces) {
          const records = await this.loadNamespaceRecords(entry.id);
          active += records.filter(
            (record) =>
              record.action === "environment.exec" &&
              record.resources.environmentId === input.resources?.environmentId &&
              isActiveRecord(record),
          ).length;
        }
        if (active >= PUBLIC_API_LIMITS.execConcurrencyPerEnvironment) {
          throw new PublicActionError(
            "busy",
            `At most ${PUBLIC_API_LIMITS.execConcurrencyPerEnvironment} commands may run per environment`,
            { retryable: true },
          );
        }
      }
      const targetEntry =
        input.namespace === undefined
          ? current
          : index.namespaces.find((entry) => entry.id === input.namespace)!;
      if (targetEntry.id !== current.id && now >= namespaceAdmissionEnds(targetEntry)) {
        throw new PublicActionError(
          "namespace-closed",
          "This request key belongs to an admission window that has closed and holds no record of it. Use a new request ID.",
          { details: { namespace: targetEntry.id } },
        );
      }
      const records = await this.loadNamespaceRecords(targetEntry.id);
      const bytes = records.reduce((total, record) => total + recordBytes(record), 0);
      if (
        records.length >= this.publicOperationLimits.maxOperationsPerNamespace ||
        bytes >= this.publicOperationLimits.maxNamespaceBytes
      ) {
        // Never evict retained history to make room: that would reopen keys.
        throw new PublicActionError(
          "store-capacity",
          "The public operation store is full for the current window; retry later",
          { retryable: true },
        );
      }
      const timestamp = new Date(now).toISOString();
      const record = boundRecord({
        version: PUBLIC_OPERATION_RECORD_VERSION,
        operationId: newOperationId(targetEntry.id),
        namespace: targetEntry.id,
        requestId: input.requestId,
        requestKey: input.requestKey,
        authority: input.authority,
        action: input.action,
        scope: input.scope,
        fingerprint: input.fingerprint,
        ...(input.resolved ? { resolved: input.resolved } : {}),
        state: "admitted",
        stage: "admitted",
        resources: input.resources ?? {},
        generation: input.generation,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.saveNamespaceRecords(targetEntry.id, [...records, record]);
      return { record, replayed: false };
    });
  }

  /**
   * Atomically advance one record. `update` receives the current record and
   * returns the next one (or null for no change). Terminal records are
   * immutable: an update that would move one backwards is ignored.
   */
  async updatePublicOperation(
    operationId: string,
    update: (record: PublicOperationRecord) => PublicOperationRecord | null,
  ): Promise<PublicOperationRecord | null> {
    const namespace = namespaceOfOperationId(operationId);
    if (!namespace) return null;
    return this.enqueuePublicOperationMutation(async () => {
      const records = await this.loadNamespaceRecords(namespace);
      const position = records.findIndex(
        (record) => isPublicOperationRecord(record) && record.operationId === operationId,
      );
      if (position < 0) return null;
      const current = records[position]!;
      const next = update(structuredClone(current));
      if (!next) return current;
      if (!isActiveRecord(current) && isActiveRecord(next)) return current;
      const bounded = boundRecord({ ...next, updatedAt: new Date().toISOString() });
      records[position] = bounded;
      await this.saveNamespaceRecords(namespace, records);
      return bounded;
    });
  }

  async getPublicOperation(operationId: string): Promise<PublicOperationLookup> {
    const namespace = namespaceOfOperationId(operationId);
    if (!namespace) return { status: "missing" };
    const index = await this.loadPublicOperationIndex();
    const status = namespaceStatus(index, namespace);
    if (status === "retired") return { status: "expired", namespace };
    if (status === "unknown") return { status: "missing" };
    const record = (await this.loadNamespaceRecords(namespace)).find(
      (candidate) => isPublicOperationRecord(candidate) && candidate.operationId === operationId,
    );
    return record ? { status: "found", record } : { status: "missing" };
  }

  /**
   * Unlocked read of an existing admission for `requestKey`. Admission
   * re-checks under the lock, so this is only a fast path for replays.
   */
  async findPublicOperationByKey(requestKey: string): Promise<PublicOperationRecord | null> {
    const index = await this.loadPublicOperationIndex();
    for (const entry of [...index.namespaces].reverse()) {
      const record = (await this.loadNamespaceRecords(entry.id)).find(
        (candidate) => isPublicOperationRecord(candidate) && candidate.requestKey === requestKey,
      );
      if (record) return record;
    }
    return null;
  }

  /**
   * Claim an `admitted` record left by a previous backend generation: nothing
   * ran for it, so the same key may execute it now. Only one caller wins.
   */
  async claimStalePublicOperation(
    operationId: string,
    generation: string,
  ): Promise<PublicOperationRecord | null> {
    let claimed: PublicOperationRecord | null = null;
    await this.updatePublicOperation(operationId, (record) => {
      if (record.state !== "admitted" || record.generation === generation) return null;
      claimed = { ...record, generation };
      return claimed;
    });
    return claimed;
  }

  /** Find operations by their caller request ID (optionally narrowed). */
  async findPublicOperationsByRequest(
    requestId: string,
    filter: { action?: PublicActionName; namespace?: string } = {},
  ): Promise<{ records: PublicOperationRecord[]; expiredNamespace?: string }> {
    const index = await this.loadPublicOperationIndex();
    if (filter.namespace !== undefined) {
      const status = namespaceStatus(index, filter.namespace);
      if (status === "retired") return { records: [], expiredNamespace: filter.namespace };
      if (status === "unknown") return { records: [] };
    }
    const namespaces = filter.namespace
      ? [filter.namespace]
      : index.namespaces.map((entry) => entry.id);
    const records: PublicOperationRecord[] = [];
    for (const namespace of namespaces) {
      for (const record of await this.loadNamespaceRecords(namespace)) {
        if (!isPublicOperationRecord(record) || record.requestId !== requestId) continue;
        if (filter.action && record.action !== filter.action) continue;
        records.push(record);
      }
    }
    return { records };
  }

  async listActivePublicOperations(): Promise<PublicOperationRecord[]> {
    const index = await this.loadPublicOperationIndex();
    const active: PublicOperationRecord[] = [];
    for (const entry of index.namespaces) {
      for (const record of await this.loadNamespaceRecords(entry.id)) {
        if (isPublicOperationRecord(record) && isActiveRecord(record)) active.push(record);
      }
    }
    return active;
  }

  /**
   * Retire namespaces past their fence that hold no active operation. Their
   * files are deleted and their IDs are remembered (bounded), so a replay
   * of any of their keys is refused as expired rather than executed.
   */
  async collectPublicOperations(now = Date.now()): Promise<{ retired: string[]; kept: string[] }> {
    return this.enqueuePublicOperationMutation(async () => {
      const index = await this.indexWithCurrent(now);
      const current = index.namespaces.at(-1)!.id;
      const retired: string[] = [];
      const kept: string[] = [];
      for (const entry of index.namespaces) {
        if (entry.id === current || now < namespaceFence(entry)) continue;
        const records = await this.loadNamespaceRecords(entry.id);
        // Active work pins its namespace. The one exception is a record whose
        // uncertainty is permanent — `unknown` with nothing parked to retry or
        // discard, untouched since the fence — which no future evidence or
        // action can resolve.
        const fence = namespaceFence(entry);
        const pinned = records.some(
          (record) =>
            isPublicOperationRecord(record) &&
            isActiveRecord(record) &&
            !(
              record.state === "unknown" &&
              record.dispatch?.recoverable !== true &&
              Date.parse(record.updatedAt) < fence
            ),
        );
        if (pinned) {
          kept.push(entry.id);
          continue;
        }
        retired.push(entry.id);
      }
      if (retired.length === 0) return { retired, kept };
      const next: PublicOperationIndex = {
        version: 1,
        namespaces: index.namespaces.filter((entry) => !retired.includes(entry.id)),
        retired: [...index.retired, ...retired].slice(-MAX_RETIRED_NAMESPACES),
      };
      // Publish the retirement before deleting files, so a crash in between
      // leaves orphaned files rather than an index that forgot the retirement.
      await this.saveSensitiveJson(this.publicOperationIndexFile(), next);
      for (const namespace of retired) {
        const file = this.publicOperationNamespaceFile(namespace);
        await fs.rm(file, { force: true });
        for (let backup = 1; backup <= 5; backup += 1) {
          await fs.rm(this.backupPath(file, backup), { force: true }).catch(() => undefined);
        }
      }
      return { retired, kept };
    });
  }

  // -------------------------------------------------------------------------
  // Revision-checked edits

  async updateProjectAtRevision(
    projectId: string,
    expectedRevision: string | undefined,
    updates: Partial<Pick<Project, "name" | "gitUrl" | "localPath" | "folder">>,
  ): Promise<Project> {
    // The revision check and the write happen under one projects.json lock.
    const project = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const current = projects.find((candidate) => candidate.id === projectId);
      if (!current) throw new PublicActionError("not-found", `Project not found: ${projectId}`);
      if (expectedRevision !== undefined && projectRevision(current) !== expectedRevision) {
        throw new PublicActionError(
          "revision-conflict",
          "The project changed since it was read; re-read it and apply the change again",
          { details: { currentRevision: projectRevision(current) } },
        );
      }
      return this.applyProjectUpdates(projects, current, updates);
    });
    this.announce("project", projectId);
    return project;
  }

  /** Shared body of project metadata edits; the caller holds the project lock. */
  protected async applyProjectUpdates(
    projects: Project[],
    project: Project,
    updates: Partial<Pick<Project, "name" | "gitUrl" | "localPath" | "folder">>,
  ): Promise<Project> {
    if (typeof updates.gitUrl === "string") {
      const gitUrl = withoutUrlCredentials(updates.gitUrl.trim());
      if (!gitUrl) throw new PublicActionError("invalid-input", "Git URL cannot be empty");
      if (
        projects.some((candidate) => candidate.id !== project.id && candidate.gitUrl === gitUrl)
      ) {
        throw new PublicActionError("conflict", "Another project already uses that remote URL");
      }
      project.gitUrl = gitUrl;
    }
    if (typeof updates.localPath === "string") {
      const duplicate = projects.some(
        (candidate) => candidate.id !== project.id && candidate.localPath === updates.localPath,
      );
      if (duplicate) {
        throw new PublicActionError("conflict", "Another project already uses that checkout path");
      }
    }
    if (typeof updates.name === "string") project.name = updates.name;
    if ("localPath" in updates) project.localPath = updates.localPath ?? null;
    if ("folder" in updates) applyProjectFolder(project, updates.folder);
    await this.saveJson(this.projectsFile(), projects);
    return project;
  }

  /**
   * Apply a repository-settings patch under the config lock. `apply`
   * receives a copy of the current entry and returns the new one; it runs
   * after the revision check, and nothing is written if it throws.
   */
  async patchRepositorySettingsAtRevision(
    projectId: string,
    expectedRevision: string | undefined,
    apply: (current: RepositoryConfig) => RepositoryConfig,
  ): Promise<RepositoryConfig> {
    const next = await this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      const stored = config.repositories[projectId];
      if (
        expectedRevision !== undefined &&
        repositorySettingsRevision(stored) !== expectedRevision
      ) {
        throw new PublicActionError(
          "revision-conflict",
          "The project settings changed since they were read; re-read and apply the change again",
          { details: { currentRevision: repositorySettingsRevision(stored) } },
        );
      }
      const current = structuredClone(stored ?? defaultRepositoryConfig());
      const updated = apply(current);
      config.repositories[projectId] = updated;
      await this.saveJson(this.configFile(), config);
      return updated;
    });
    this.announce("config", "app");
    return next;
  }

  /**
   * Apply an environment-settings patch under the environment lock. Only
   * port mappings, allowed domains and the agent-settings tier are touched;
   * launch intent (initial prompt, attachments, pending launch selection)
   * is carried through unchanged.
   */
  async patchEnvironmentSettingsAtRevision(
    environmentId: string,
    expectedRevision: string | undefined,
    apply: (
      current: {
        portMappings?: PortMapping[];
        allowedDomains?: string[];
        agentSettings?: AgentSettingsTier;
      },
      environment: Environment,
    ) => {
      portMappings?: PortMapping[];
      allowedDomains?: string[];
      agentSettings?: AgentSettingsTier;
    },
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment)
        throw new PublicActionError("not-found", `Environment not found: ${environmentId}`);
      if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
        throw new PublicActionError("conflict", "The environment is being deleted");
      }
      if (
        expectedRevision !== undefined &&
        environmentSettingsRevision(environment) !== expectedRevision
      ) {
        throw new PublicActionError(
          "revision-conflict",
          "The environment settings changed since they were read; re-read and apply the change again",
          { details: { currentRevision: environmentSettingsRevision(environment) } },
        );
      }
      const next = apply(
        structuredClone({
          portMappings: environment.portMappings,
          allowedDomains: environment.allowedDomains,
          agentSettings: environment.agentSettings,
        }),
        structuredClone(environment),
      );
      environment.portMappings = next.portMappings;
      environment.allowedDomains = next.allowedDomains;
      const tier = next.agentSettings ? normalizeAgentSettings(next.agentSettings) : undefined;
      if (tier && Object.keys(tier).length > 0) environment.agentSettings = tier;
      else delete environment.agentSettings;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }
}
