import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import {
  GRAPH_LIBRARY_BOUNDS,
  type GraphTemplateTrustRecord,
} from "@orkestrator/protocol/graphs/library";
import {
  GRAPH_SHARING_BOUNDS,
  type GraphTrustedSigningKey,
} from "@orkestrator/protocol/graphs/sharing";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphTemplateError } from "./graph-template-errors.js";
import type { StorageContext } from "./storage-context.js";
import { isRecord, nowIso } from "./storage-shared.js";

/** A user template as stored: the store's revision is the template's own `revision`. */
export interface PersistedGraphTemplate {
  id: string;
  /** Compare-and-swap revision, 1 on the first save. */
  revision: number;
  template: GraphTemplateV1;
  /** Serialized UTF-8 bytes of `template`, for the store-wide bound. */
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

/** One project's graph settings: trust records and the capability ceiling (D18). */
export interface PersistedGraphProjectSettings {
  projectId: string;
  /** Absent: the default ceiling (every agent capability, up to the environment's policy). */
  ceiling?: GraphCapabilityCeiling;
  /** Compare-and-swap revision of `ceiling`; 0 when never set. */
  ceilingRevision: number;
  ceilingUpdatedAt?: string;
  /** At most {@link GRAPH_LIBRARY_BOUNDS.maxTrustRecords}, one per path. */
  trust: GraphTemplateTrustRecord[];
  updatedAt: string;
}

/**
 * This installation's share-bundle signing key and the keys it trusts (item
 * 405). The private key never leaves the backend: no command returns it and
 * nothing logs it.
 */
export interface PersistedGraphSharingKeys {
  installation?: {
    /** Raw Ed25519 public key, base64url. */
    publicKey: string;
    /** The JWK `d` member (raw private key, base64url). */
    privateKey: string;
    keyId: string;
    createdAt: string;
  };
  /** At most {@link GRAPH_SHARING_BOUNDS.maxTrustedKeys}, one per key id, by label. */
  trusted: GraphTrustedSigningKey[];
  updatedAt: string;
}

/** The canonical text of an approved project template, kept for review diffs (item 405). */
export interface PersistedGraphApprovedTemplate {
  digest: string;
  approvedAt: string;
  /** `graphTemplateExportText` of the approved template; absent when not kept. */
  text?: string;
  /** Why `text` is absent: larger than one copy may be, or dropped for the project budget. */
  textOmitted?: "too-large" | "budget";
}

/** One project's approved copies and rejected digests, by path (item 405). */
export interface PersistedGraphProjectApprovals {
  projectId: string;
  approved: Record<string, PersistedGraphApprovedTemplate>;
  rejected: Record<string, { digest: string; rejectedAt: string }>;
  updatedAt: string;
}

const TEMPLATES = "templates";
const PROJECTS = "projects";
const SHARING = "sharing";
const SHARING_KEYS_ROW = "keys";
const APPROVALS = "approvals";

interface GraphTemplatesEnvelope {
  templates?: Record<string, unknown>;
  projects?: Record<string, unknown>;
}

function isPersistedGraphTemplate(value: unknown, id: string): value is PersistedGraphTemplate {
  return (
    isRecord(value) &&
    value.id === id &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0 &&
    Number.isSafeInteger(value.bytes) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isRecord(value.template) &&
    value.template.id === id
  );
}

function isTrustRecord(value: unknown): value is GraphTemplateTrustRecord {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.digest === "string" &&
    typeof value.approvedAt === "string"
  );
}

function isPersistedGraphProjectSettings(
  value: unknown,
  projectId: string,
): value is PersistedGraphProjectSettings {
  return (
    isRecord(value) &&
    value.projectId === projectId &&
    Number.isSafeInteger(value.ceilingRevision) &&
    (value.ceiling === undefined || isRecord(value.ceiling)) &&
    Array.isArray(value.trust) &&
    value.trust.every(isTrustRecord) &&
    typeof value.updatedAt === "string"
  );
}

function isTrustedSigningKey(value: unknown): value is GraphTrustedSigningKey {
  return (
    isRecord(value) &&
    typeof value.keyId === "string" &&
    typeof value.publicKey === "string" &&
    typeof value.label === "string" &&
    typeof value.addedAt === "string"
  );
}

function isPersistedGraphSharingKeys(value: unknown): value is PersistedGraphSharingKeys {
  if (!isRecord(value) || !Array.isArray(value.trusted) || typeof value.updatedAt !== "string") {
    return false;
  }
  const installation = value.installation;
  return (
    value.trusted.every(isTrustedSigningKey) &&
    (installation === undefined ||
      (isRecord(installation) &&
        typeof installation.publicKey === "string" &&
        typeof installation.privateKey === "string" &&
        typeof installation.keyId === "string" &&
        typeof installation.createdAt === "string"))
  );
}

function isPersistedGraphProjectApprovals(
  value: unknown,
  projectId: string,
): value is PersistedGraphProjectApprovals {
  return (
    isRecord(value) &&
    value.projectId === projectId &&
    isRecord(value.approved) &&
    Object.values(value.approved).every(
      (entry) =>
        isRecord(entry) && typeof entry.digest === "string" && typeof entry.approvedAt === "string",
    ) &&
    isRecord(value.rejected) &&
    Object.values(value.rejected).every(
      (entry) =>
        isRecord(entry) && typeof entry.digest === "string" && typeof entry.rejectedAt === "string",
    ) &&
    typeof value.updatedAt === "string"
  );
}

function emptySharingKeys(): PersistedGraphSharingKeys {
  return { trusted: [], updatedAt: nowIso() };
}

function emptyProjectApprovals(projectId: string): PersistedGraphProjectApprovals {
  return { projectId, approved: {}, rejected: {}, updatedAt: nowIso() };
}

/** Keeps only `keepPaths` and fits the kept texts in the project budget, oldest dropped first. */
function boundApprovals(
  approvals: PersistedGraphProjectApprovals,
  keepPaths: ReadonlySet<string>,
): void {
  for (const path of Object.keys(approvals.approved)) {
    if (!keepPaths.has(path)) delete approvals.approved[path];
  }
  for (const path of Object.keys(approvals.rejected)) {
    if (!keepPaths.has(path)) delete approvals.rejected[path];
  }
  const kept = Object.values(approvals.approved)
    .filter((entry) => entry.text !== undefined)
    .sort((a, b) => (a.approvedAt < b.approvedAt ? -1 : a.approvedAt > b.approvedAt ? 1 : 0));
  let total = kept.reduce((sum, entry) => sum + Buffer.byteLength(entry.text!, "utf8"), 0);
  for (const entry of kept) {
    if (total <= GRAPH_SHARING_BOUNDS.maxApprovedTextBytesPerProject) break;
    total -= Buffer.byteLength(entry.text!, "utf8");
    delete entry.text;
    entry.textOmitted = "budget";
  }
}

function emptyProjectSettings(projectId: string): PersistedGraphProjectSettings {
  return { projectId, ceilingRevision: 0, trust: [], updatedAt: nowIso() };
}

/**
 * The `graph-templates` store (item 109): user templates in the `templates`
 * collection (one row per template id) and per-project trust records and
 * capability ceilings in `projects` (one row per project id). Item 405 adds
 * the share-bundle signing keys (`sharing`, one row) and approved
 * project-template copies with rejections (`approvals`, one row per project).
 *
 * Every write is one `updateStoreRow` transaction, which checks the revision
 * inside the transaction against the row it replaces, so two clients saving
 * the same template cannot both win. The store-wide count and byte bounds are
 * checked against a cached read just before that transaction.
 */
export class GraphTemplatesRepository {
  constructor(private readonly context: StorageContext) {}

  private graphTemplatesFile(): string {
    return this.context.file("graph-templates.json");
  }

  private async loadEnvelope(): Promise<GraphTemplatesEnvelope> {
    const value = await this.context.loadJsonCached<unknown>(this.graphTemplatesFile(), () => ({}));
    return isRecord(value) ? (value as GraphTemplatesEnvelope) : {};
  }

  /** Every readable user template, in no particular order. */
  async listGraphTemplateRecords(): Promise<PersistedGraphTemplate[]> {
    const templates = (await this.loadEnvelope()).templates;
    if (!isRecord(templates)) return [];
    return Object.entries(templates)
      .filter((entry): entry is [string, PersistedGraphTemplate] =>
        isPersistedGraphTemplate(entry[1], entry[0]),
      )
      .map(([, record]) => record);
  }

  getGraphTemplateRecord(id: string): PersistedGraphTemplate | null {
    const stored = this.context.loadStoreRow(this.graphTemplatesFile(), id, {
      collection: TEMPLATES,
    });
    return isPersistedGraphTemplate(stored, id) ? stored : null;
  }

  /**
   * Saves a user template when the stored revision equals `expectedRevision`
   * (0: it must not exist yet). The stored copy gets `revision` = expected + 1.
   * The caller has validated the template.
   */
  async saveGraphTemplateRecord(
    template: GraphTemplateV1,
    expectedRevision: number,
  ): Promise<PersistedGraphTemplate> {
    const id = template.id;
    const bytes = Buffer.byteLength(JSON.stringify(template), "utf8");
    const others = (await this.listGraphTemplateRecords()).filter((record) => record.id !== id);
    if (expectedRevision === 0 && others.length >= GRAPH_LIBRARY_BOUNDS.maxUserTemplates) {
      throw new GraphTemplateError(
        "limit",
        `At most ${GRAPH_LIBRARY_BOUNDS.maxUserTemplates} user templates can be saved`,
      );
    }
    const total = others.reduce((sum, record) => sum + record.bytes, 0) + bytes;
    if (total > GRAPH_LIBRARY_BOUNDS.maxUserTemplateBytes) {
      throw new GraphTemplateError(
        "limit",
        `User templates are limited to ${GRAPH_LIBRARY_BOUNDS.maxUserTemplateBytes} bytes in total`,
      );
    }
    const saved = this.context.updateStoreRow<PersistedGraphTemplate>(
      this.graphTemplatesFile(),
      id,
      (current) => {
        const previous = isPersistedGraphTemplate(current, id) ? current : undefined;
        const stored = previous?.revision ?? 0;
        if (stored !== expectedRevision) {
          throw new GraphTemplateError(
            "revision-conflict",
            stored === 0
              ? `Template ${id} was deleted or never saved (expected revision ${expectedRevision})`
              : `Template ${id} is at revision ${stored}, not ${expectedRevision}; reload it before saving`,
          );
        }
        const now = nowIso();
        const revision = stored + 1;
        const next: PersistedGraphTemplate = {
          id,
          revision,
          template: { ...template, revision },
          bytes,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        return { result: next, value: next };
      },
      { collection: TEMPLATES },
    );
    this.context.changes.announce("graph-template", `user:${id}`);
    return saved;
  }

  /** Deletes a user template; with `expectedRevision`, only at that revision. */
  deleteGraphTemplateRecord(id: string, expectedRevision?: number): boolean {
    const deleted = this.context.updateStoreRow<boolean>(
      this.graphTemplatesFile(),
      id,
      (current) => {
        const previous = isPersistedGraphTemplate(current, id) ? current : undefined;
        if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
          throw new GraphTemplateError(
            "revision-conflict",
            `Template ${id} is at revision ${previous?.revision ?? 0}, not ${expectedRevision}`,
          );
        }
        if (current === undefined) return { result: false };
        return { result: true, delete: true };
      },
      { collection: TEMPLATES },
    );
    if (deleted)
      this.context.changes.announce("graph-template", `user:${id}`, undefined, undefined, true);
    return deleted;
  }

  getGraphProjectSettings(projectId: string): PersistedGraphProjectSettings | null {
    const stored = this.context.loadStoreRow(this.graphTemplatesFile(), projectId, {
      collection: PROJECTS,
    });
    return isPersistedGraphProjectSettings(stored, projectId) ? stored : null;
  }

  private updateProjectSettings<T>(
    projectId: string,
    mutate: (settings: PersistedGraphProjectSettings) => T,
  ): { settings: PersistedGraphProjectSettings; result: T } {
    const outcome = this.context.updateStoreRow(
      this.graphTemplatesFile(),
      projectId,
      (current) => {
        const settings = isPersistedGraphProjectSettings(current, projectId)
          ? structuredClone(current)
          : emptyProjectSettings(projectId);
        const result = mutate(settings);
        settings.updatedAt = nowIso();
        return { result: { settings, result }, value: settings };
      },
      { collection: PROJECTS },
    );
    this.context.changes.announce("graph-template", `project:${projectId}`, projectId);
    return outcome;
  }

  /**
   * Sets (or with `null`, clears) a project's ceiling when its revision equals
   * `expectedRevision` (any revision when omitted). The caller has validated it.
   */
  setGraphProjectCeiling(
    projectId: string,
    ceiling: GraphCapabilityCeiling | null,
    expectedRevision?: number,
  ): PersistedGraphProjectSettings {
    return this.updateProjectSettings(projectId, (settings) => {
      if (expectedRevision !== undefined && settings.ceilingRevision !== expectedRevision) {
        throw new GraphTemplateError(
          "revision-conflict",
          `The project's ceiling is at revision ${settings.ceilingRevision}, not ${expectedRevision}`,
        );
      }
      if (ceiling) settings.ceiling = ceiling;
      else delete settings.ceiling;
      settings.ceilingRevision += 1;
      settings.ceilingUpdatedAt = nowIso();
    }).settings;
  }

  /**
   * Records an approval, replacing any earlier one for the same path. Records
   * for paths outside `keepPaths` (files that no longer exist) are dropped, so
   * the list stays bounded by the project's files.
   */
  approveGraphProjectTemplate(
    projectId: string,
    record: GraphTemplateTrustRecord,
    keepPaths: ReadonlySet<string>,
    approvedText?: string,
  ): PersistedGraphProjectSettings {
    const settings = this.updateProjectSettings(projectId, (settings) => {
      const kept = settings.trust.filter(
        (entry) => entry.path !== record.path && keepPaths.has(entry.path),
      );
      if (kept.length >= GRAPH_LIBRARY_BOUNDS.maxTrustRecords) {
        throw new GraphTemplateError(
          "limit",
          `At most ${GRAPH_LIBRARY_BOUNDS.maxTrustRecords} project templates can be trusted`,
        );
      }
      settings.trust = [...kept, record].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
    }).settings;
    // The approved copy (item 405), written after the trust record it
    // belongs to: should this write fail, the review shows "not kept".
    this.updateProjectApprovals(projectId, (approvals) => {
      const fits =
        approvedText !== undefined &&
        Buffer.byteLength(approvedText, "utf8") <= GRAPH_SHARING_BOUNDS.maxApprovedTextBytes;
      approvals.approved[record.path] = {
        digest: record.digest,
        approvedAt: record.approvedAt,
        ...(fits
          ? { text: approvedText }
          : approvedText !== undefined
            ? { textOmitted: "too-large" }
            : {}),
      };
      delete approvals.rejected[record.path];
      boundApprovals(approvals, new Set([...keepPaths, record.path]));
    });
    return settings;
  }

  /** Removes the approval for `path`; whether one existed. */
  revokeGraphProjectTemplate(
    projectId: string,
    path: string,
  ): { settings: PersistedGraphProjectSettings; revoked: boolean } {
    const { settings, result } = this.updateProjectSettings(projectId, (current) => {
      const before = current.trust.length;
      current.trust = current.trust.filter((entry) => entry.path !== path);
      return current.trust.length !== before;
    });
    if (this.getGraphProjectApprovals(projectId)?.approved[path]) {
      this.updateProjectApprovals(projectId, (approvals) => {
        delete approvals.approved[path];
      });
    }
    return { settings, revoked: result };
  }

  /** A project's approved copies and rejections (item 405). */
  getGraphProjectApprovals(projectId: string): PersistedGraphProjectApprovals | null {
    const stored = this.context.loadStoreRow(this.graphTemplatesFile(), projectId, {
      collection: APPROVALS,
    });
    return isPersistedGraphProjectApprovals(stored, projectId) ? stored : null;
  }

  private updateProjectApprovals(
    projectId: string,
    mutate: (approvals: PersistedGraphProjectApprovals) => void,
  ): PersistedGraphProjectApprovals {
    const approvals = this.context.updateStoreRow(
      this.graphTemplatesFile(),
      projectId,
      (current) => {
        const next = isPersistedGraphProjectApprovals(current, projectId)
          ? structuredClone(current)
          : emptyProjectApprovals(projectId);
        mutate(next);
        next.updatedAt = nowIso();
        return { result: next, value: next };
      },
      { collection: APPROVALS },
    );
    this.context.changes.announce("graph-template", `project:${projectId}`, projectId);
    return approvals;
  }

  /**
   * Records that the user rejected the project template at `path` with
   * `digest` (item 405). Any earlier approval stays; rejections of paths
   * outside `keepPaths` are dropped.
   */
  rejectGraphProjectTemplate(
    projectId: string,
    rejection: { path: string; digest: string; rejectedAt: string },
    keepPaths: ReadonlySet<string>,
  ): PersistedGraphProjectApprovals {
    return this.updateProjectApprovals(projectId, (approvals) => {
      approvals.rejected[rejection.path] = {
        digest: rejection.digest,
        rejectedAt: rejection.rejectedAt,
      };
      boundApprovals(approvals, new Set([...keepPaths, rejection.path]));
    });
  }

  // ------------------------------------------------------------ sharing keys (item 405)

  getGraphSharingKeys(): PersistedGraphSharingKeys | null {
    const stored = this.context.loadStoreRow(this.graphTemplatesFile(), SHARING_KEYS_ROW, {
      collection: SHARING,
    });
    return isPersistedGraphSharingKeys(stored) ? stored : null;
  }

  private updateSharingKeys<T>(mutate: (keys: PersistedGraphSharingKeys) => T): {
    keys: PersistedGraphSharingKeys;
    result: T;
  } {
    return this.context.updateStoreRow(
      this.graphTemplatesFile(),
      SHARING_KEYS_ROW,
      (current) => {
        const keys = isPersistedGraphSharingKeys(current)
          ? structuredClone(current)
          : emptySharingKeys();
        const result = mutate(keys);
        keys.updatedAt = nowIso();
        return { result: { keys, result }, value: keys };
      },
      { collection: SHARING },
    );
  }

  /**
   * This installation's signing key, created by `create` the first time.
   * Inside one row transaction, so two first exports cannot make two keys.
   */
  ensureGraphSharingInstallationKey(
    create: () => NonNullable<PersistedGraphSharingKeys["installation"]>,
  ): NonNullable<PersistedGraphSharingKeys["installation"]> {
    const existing = this.getGraphSharingKeys()?.installation;
    if (existing) return existing;
    return this.updateSharingKeys((keys) => {
      keys.installation ??= create();
      return keys.installation;
    }).result;
  }

  /** Adds or relabels a trusted key (one per key id). */
  trustGraphSharingKey(key: GraphTrustedSigningKey): PersistedGraphSharingKeys {
    return this.updateSharingKeys((keys) => {
      const others = keys.trusted.filter((entry) => entry.keyId !== key.keyId);
      if (others.length >= GRAPH_SHARING_BOUNDS.maxTrustedKeys) {
        throw new GraphTemplateError(
          "limit",
          `At most ${GRAPH_SHARING_BOUNDS.maxTrustedKeys} signing keys can be trusted`,
        );
      }
      const previous = keys.trusted.find((entry) => entry.keyId === key.keyId);
      keys.trusted = [...others, { ...key, addedAt: previous?.addedAt ?? key.addedAt }].sort(
        (a, b) => a.label.localeCompare(b.label) || (a.keyId < b.keyId ? -1 : 1),
      );
    }).keys;
  }

  /** Removes a trusted key; whether it was there. */
  untrustGraphSharingKey(keyId: string): { keys: PersistedGraphSharingKeys; removed: boolean } {
    const { keys, result } = this.updateSharingKeys((current) => {
      const before = current.trusted.length;
      current.trusted = current.trusted.filter((entry) => entry.keyId !== keyId);
      return current.trusted.length !== before;
    });
    return { keys, removed: result };
  }

  /** Project removal: its trust records and ceiling have nothing left to answer for. */
  deleteGraphProjectSettings(projectId: string): void {
    const deletedSettings = this.context.updateStoreRow<boolean>(
      this.graphTemplatesFile(),
      projectId,
      (current) => (current === undefined ? { result: false } : { result: true, delete: true }),
      { collection: PROJECTS },
    );
    const deletedApprovals = this.context.updateStoreRow<boolean>(
      this.graphTemplatesFile(),
      projectId,
      (current) => (current === undefined ? { result: false } : { result: true, delete: true }),
      { collection: APPROVALS },
    );
    if (deletedSettings || deletedApprovals) {
      this.context.changes.announce(
        "graph-template",
        `project:${projectId}`,
        projectId,
        undefined,
        true,
      );
    }
  }

  /** A project's template files changed on disk (no store write). */
  announceGraphProjectTemplatesChanged(projectId: string): void {
    this.context.changes.announce("graph-template", `project:${projectId}`, projectId);
  }
}

/**
 * The graph template store: what callers reach as `storage.graphTemplates`.
 *
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to. Add a method here only when code outside the storage
 * files calls it.
 */
export type GraphTemplatesStorage = Pick<
  GraphTemplatesRepository,
  | "listGraphTemplateRecords"
  | "getGraphTemplateRecord"
  | "saveGraphTemplateRecord"
  | "deleteGraphTemplateRecord"
  | "getGraphProjectSettings"
  | "setGraphProjectCeiling"
  | "approveGraphProjectTemplate"
  | "revokeGraphProjectTemplate"
  | "announceGraphProjectTemplatesChanged"
  | "getGraphProjectApprovals"
  | "rejectGraphProjectTemplate"
  | "getGraphSharingKeys"
  | "ensureGraphSharingInstallationKey"
  | "trustGraphSharingKey"
  | "untrustGraphSharingKey"
>;
