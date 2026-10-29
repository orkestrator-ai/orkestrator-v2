import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import {
  GRAPH_LIBRARY_BOUNDS,
  type GraphTemplateTrustRecord,
} from "@orkestrator/protocol/graphs/library";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GRAPH_LAUNCH_BOUNDS, type GraphLaunchDefaults } from "@orkestrator/protocol/graphs/launch";
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
  /**
   * Launch defaults per template (item 214), keyed by `graphTemplateRefKey`.
   * At most {@link GRAPH_LAUNCH_BOUNDS.maxSavedDefaultsPerProject}; the least
   * recently saved is dropped first.
   */
  launchDefaults?: Record<string, GraphLaunchDefaults>;
  updatedAt: string;
}

const TEMPLATES = "templates";
const PROJECTS = "projects";

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
    (value.launchDefaults === undefined || isRecord(value.launchDefaults)) &&
    typeof value.updatedAt === "string"
  );
}

function isLaunchDefaults(value: unknown): value is GraphLaunchDefaults {
  return (
    isRecord(value) &&
    isRecord(value.roles) &&
    isRecord(value.params) &&
    typeof value.updatedAt === "string"
  );
}

function emptyProjectSettings(projectId: string): PersistedGraphProjectSettings {
  return { projectId, ceilingRevision: 0, trust: [], updatedAt: nowIso() };
}

/**
 * The `graph-templates` store (item 109): user templates in the `templates`
 * collection (one row per template id) and per-project trust records and
 * capability ceilings in `projects` (one row per project id).
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
  ): PersistedGraphProjectSettings {
    return this.updateProjectSettings(projectId, (settings) => {
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
    return { settings, revoked: result };
  }

  /** The launch defaults saved for one template in a project (item 214), if any. */
  getGraphLaunchDefaults(projectId: string, templateKey: string): GraphLaunchDefaults | null {
    const stored = this.getGraphProjectSettings(projectId)?.launchDefaults?.[templateKey];
    return isLaunchDefaults(stored) ? structuredClone(stored) : null;
  }

  /**
   * Saves (or with `null`, forgets) one template's launch defaults. Bounded:
   * past the per-project cap the least recently saved entry is dropped.
   */
  saveGraphLaunchDefaults(
    projectId: string,
    templateKey: string,
    defaults: GraphLaunchDefaults | null,
  ): void {
    this.updateProjectSettings(projectId, (settings) => {
      const entries = Object.entries(settings.launchDefaults ?? {}).filter(
        ([key, value]) => key !== templateKey && isLaunchDefaults(value),
      );
      if (defaults) entries.push([templateKey, defaults]);
      entries.sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));
      const kept = entries.slice(-GRAPH_LAUNCH_BOUNDS.maxSavedDefaultsPerProject);
      if (kept.length > 0) settings.launchDefaults = Object.fromEntries(kept);
      else delete settings.launchDefaults;
    });
  }

  /** Project removal: its trust records and ceiling have nothing left to answer for. */
  deleteGraphProjectSettings(projectId: string): void {
    const deleted = this.context.updateStoreRow<boolean>(
      this.graphTemplatesFile(),
      projectId,
      (current) => (current === undefined ? { result: false } : { result: true, delete: true }),
      { collection: PROJECTS },
    );
    if (deleted) {
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
  | "getGraphLaunchDefaults"
  | "saveGraphLaunchDefaults"
  | "announceGraphProjectTemplatesChanged"
>;
