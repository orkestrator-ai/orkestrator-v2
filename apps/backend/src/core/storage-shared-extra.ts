import * as shared from "./storage-shared-core.js";
import {
  createHash,
  isRecord,
} from "./storage-shared-core.js";
type OpenCodeModelCatalogEntry = shared.OpenCodeModelCatalogEntry;
type OpenCodeModelCatalogSnapshot = shared.OpenCodeModelCatalogSnapshot;
type ResourceChange = shared.ResourceChange;
type JsonRecord = shared.JsonRecord;
export function normalizeOpenCodeModelCatalogEntries(
  models: OpenCodeModelCatalogEntry[],
): OpenCodeModelCatalogEntry[] {
  const byId = new Map<string, OpenCodeModelCatalogEntry[]>();

  for (const candidate of models) {
    if (!candidate || typeof candidate !== "object") continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const provider =
      typeof candidate.provider === "string" ? candidate.provider.trim() : "";
    if (!id || !name || !provider) continue;

    const variants = Array.isArray(candidate.variants)
      ? Array.from(new Set(candidate.variants.filter(
          (variant): variant is string =>
            typeof variant === "string" && variant.trim().length > 0,
        ).map((variant) => variant.trim()))).sort((left, right) =>
          left.localeCompare(right)
        )
      : undefined;
    const nonNegativeNumber = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const contextWindow =
      typeof candidate.contextWindow === "number" &&
      Number.isSafeInteger(candidate.contextWindow) &&
      candidate.contextWindow > 0
        ? candidate.contextWindow
        : undefined;

    const normalized = {
      id,
      name,
      provider,
      ...(variants?.length ? { variants } : {}),
      ...(nonNegativeNumber(candidate.inputCost) !== undefined
        ? { inputCost: nonNegativeNumber(candidate.inputCost) }
        : {}),
      ...(nonNegativeNumber(candidate.outputCost) !== undefined
        ? { outputCost: nonNegativeNumber(candidate.outputCost) }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(typeof candidate.supportsImageInput === "boolean"
        ? { supportsImageInput: candidate.supportsImageInput }
        : {}),
    };
    const duplicates = byId.get(id) ?? [];
    duplicates.push(normalized);
    byId.set(id, duplicates);
  }

  return Array.from(byId.values())
    .map((duplicates) =>
      duplicates.reduce((selected, candidate) =>
        JSON.stringify(candidate).localeCompare(JSON.stringify(selected)) < 0
          ? candidate
          : selected
      )
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

export type PersistedOpenCodeModelCatalogStore = {
  schemaVersion: 2;
  catalogs: Record<string, unknown>;
  legacyUnscoped?: unknown;
};

export function normalizeOpenCodeModelCatalogProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) {
    throw new Error("OpenCode model catalogue projectId must be a non-blank string.");
  }
  return normalized;
}

export function parseOpenCodeModelCatalogSnapshot(
  projectId: string,
  value: unknown,
): OpenCodeModelCatalogSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.models)) return null;

  const models = normalizeOpenCodeModelCatalogEntries(
    record.models as OpenCodeModelCatalogEntry[],
  );
  if (models.length === 0) return null;

  const updatedAt =
    typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt))
      ? record.updatedAt
      : new Date(0).toISOString();
  const catalogVersion = createHash("sha256")
    .update(JSON.stringify(models))
    .digest("hex");

  return {
    schemaVersion: 2,
    projectId,
    catalogVersion,
    updatedAt,
    models,
  };
}

export function parseOpenCodeModelCatalogStore(
  value: unknown,
): Record<string, OpenCodeModelCatalogSnapshot> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  // Schema 1 was one host-global catalogue. It is deliberately left
  // unassigned: attaching it to whichever project reads first would leak a
  // project-specific opencode.json catalogue into another project.
  if (record.schemaVersion !== 2 || !record.catalogs ||
      typeof record.catalogs !== "object" || Array.isArray(record.catalogs)) {
    return {};
  }

  const catalogs = Object.create(null) as Record<
    string,
    OpenCodeModelCatalogSnapshot
  >;
  for (const [rawProjectId, candidate] of Object.entries(
    record.catalogs as Record<string, unknown>,
  )) {
    const projectId = rawProjectId.trim();
    if (!projectId || Object.hasOwn(catalogs, projectId)) continue;
    const snapshot = parseOpenCodeModelCatalogSnapshot(projectId, candidate);
    if (snapshot) catalogs[projectId] = snapshot;
  }
  return catalogs;
}

export function getUnscopedLegacyOpenCodeModelCatalog(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 1) return value;
  if (record.schemaVersion === 2 && Object.hasOwn(record, "legacyUnscoped")) {
    return record.legacyUnscoped;
  }
  return undefined;
}

export type ResourceChangeListener = (change: ResourceChange) => void;

/**
 * A planning mutation arrived for an exchange that is no longer attached.
 *
 * Distinguished from a generic failure so the service can drop the work
 * silently instead of marking a live exchange failed: whatever replaced this
 * record is now the authority.
 */
export class FeaturePlanningFenceError extends Error {
  constructor(readonly featureId: string, readonly operationId: string) {
    super(`Feature planning exchange ${operationId} is no longer attached`);
    this.name = "FeaturePlanningFenceError";
  }
}

/**
 * A new prompt collided with a dispatch whose outcome is still unknown.
 *
 * The refusal is the at-most-once guarantee doing its job: the parked request
 * may be executing at the provider right now, so accepting a second prompt
 * could run two turns for one intent. Distinguished from a generic failure so
 * callers can tell the user which of the two choices — retry or discard — will
 * clear it, rather than surfacing an internal message they cannot act on.
 */
export class PendingNativeAgentDispatchError extends Error {
  constructor(readonly pendingRequestId: string) {
    super(
      `Native agent dispatch ${pendingRequestId} is still awaiting recovery`,
    );
    this.name = "PendingNativeAgentDispatchError";
  }
}

export function parseUpdateObject(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}
