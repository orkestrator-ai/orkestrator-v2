/**
 * Test fixtures for environment change projections (tests only).
 * Values mirror what the backend's ChangeProjectionService serves.
 */
import type { LineCount } from "@orkestrator/protocol/change-measurements";
import {
  environmentChangeResourceKey,
  type ChangeFileRow,
  type ChangeProjection,
} from "@orkestrator/protocol/change-resources";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";

export function exactCount(value: number): LineCount {
  return { value, quality: "complete", bound: "exact" };
}

export function unknownCount(): LineCount {
  return { value: null, quality: "unknown", bound: "none" };
}

export function notApplicableCount(): LineCount {
  return { value: null, quality: "not-applicable", bound: "none" };
}

export function fileRowFixture(
  path: string,
  overrides: Partial<ChangeFileRow> = {},
): ChangeFileRow {
  return {
    rowId: `m-1:${path}`,
    pathId: `p:${path}`,
    oldPathDisplay: path,
    newPathDisplay: path,
    status: "modified",
    fileKind: "text",
    additions: exactCount(1),
    deletions: exactCount(0),
    bodyAvailability: "available",
    reasonKey: null,
    detail: null,
    ...overrides,
  };
}

export function environmentProjectionFixture(
  environmentId: string,
  overrides: Partial<ChangeProjection> = {},
): ChangeProjection {
  return {
    schemaVersion: 1,
    resourceKey: environmentChangeResourceKey(environmentId),
    ownerGeneration: "gen-1",
    revision: 1,
    measurementId: "m-1",
    state: "ready",
    availability: "ready",
    observationState: "fresh",
    coverageState: "complete",
    labelKey: "changes.scope.environment-net",
    labelArgs: {},
    hasFileChanges: true,
    hasTextChanges: true,
    badge: { visible: true, mode: "counts" },
    counters: { additions: exactCount(12), deletions: exactCount(3), changedFiles: 2 },
    provenanceLabelKey: "changes.provenance.observed",
    reasonKeys: [],
    freshness: {
      lastAttemptAt: null,
      lastSuccessfulCheckAt: null,
      lastContentChangeObservedAt: null,
      observedAt: null,
      requiredObservationEpoch: null,
      checkedObservationEpoch: null,
    },
    detail: null,
    filePage: {
      snapshotToken: "token-1",
      rows: [fileRowFixture("src/a.ts"), fileRowFixture("src/b.ts")],
      nextCursor: null,
      totalRows: 2,
    },
    actions: [],
    ...overrides,
  };
}

export function resetChangeProjectionStore(): void {
  useChangeProjectionStore.setState({
    projections: new Map(),
    retiredOwners: new Map(),
    transportRevision: 0,
    deleted: new Set(),
    contentGenerations: new Map(),
    toolPresentations: new Map(),
  });
}
