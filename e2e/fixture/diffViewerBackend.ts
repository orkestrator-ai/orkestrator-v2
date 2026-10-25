import { exactCount, type ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import {
  environmentChangeResourceKey,
  type ChangeDiffFileBody,
  type ChangeDiffHunk,
  type ChangeDiffLine,
  type ChangeFileStatus,
  type ChangesGetDiffResult,
  type DiffIdentity,
} from "@orkestrator/protocol/change-resources";

/**
 * Static stand-ins for the backend's change-tracking answers. The diff viewer
 * renders backend-prepared hunks, so the fixtures answer
 * `changes_resolve_live_detail` / `changes_get_diff` with bodies precomputed
 * from the texts below rather than computing anything in the browser.
 */

const diffFixtureOriginal = [
  "# Frontend State Audit",
  "",
  "**Goal:** minimise renderer-owned state so that every client of the same backend",
  "converges on a consistent view.",
  "",
  "## 1. Current architecture",
  "",
  "The backend already owns a lot. Storage persists projects, environments and review",
  "workflows, plus kanban tasks and completion-comment markers.",
  "",
  "### The gap",
  "",
  "Two things are missing, and every finding below is downstream of them.",
].join("\n");

const diffFixtureModified = [
  "# Frontend State Audit — What Should Move",
  "",
  "**Goal:** minimise renderer-owned state so that every client of the same backend",
  "converges on a consistent view of the world.",
  "",
  "## 1. Current architecture",
  "",
  "The backend already owns a lot. `StorageService` persists projects, environments,",
  "config, review workflows, kanban tasks and completion-comment markers.",
  "",
  "### The gap",
  "",
  "Two things are missing, and every finding below is downstream of them.",
  "",
  "**(a) There is no general change-notification broadcast** — only a fixed set of",
  "event names is ever emitted across the whole surface:",
  "",
  "```",
  "environment-renamed",
  "environment-setup-started",
  "claude-model-catalog-updated",
  "```",
].join("\n");

export const diffFixtureObjectId = "63d12576e9198f24bc2271a6a8c3702dfb391eae";
const diffFixtureEnvironmentId = "fixture-environment";
export const diffFixtureResourceKey = environmentChangeResourceKey(diffFixtureEnvironmentId);

export type DiffFixtureStatus = "modified" | "new" | "deleted";

type LineOp = readonly [type: "context" | "add" | "remove", text: string];

const original = diffFixtureOriginal.split("\n");
const modified = diffFixtureModified.split("\n");

/** The unified diff of the two texts above, as the backend's renderer would emit it. */
const modifiedOps: readonly LineOp[] = [
  ["remove", original[0]!],
  ["add", modified[0]!],
  ["context", original[1]!],
  ["context", original[2]!],
  ["remove", original[3]!],
  ["add", modified[3]!],
  ["context", original[4]!],
  ["context", original[5]!],
  ["context", original[6]!],
  ["remove", original[7]!],
  ["remove", original[8]!],
  ["add", modified[7]!],
  ["add", modified[8]!],
  ...original.slice(9, 13).map((text): LineOp => ["context", text]),
  ...modified.slice(13).map((text): LineOp => ["add", text]),
];

function hunk(ops: readonly LineOp[]): ChangeDiffHunk {
  let oldLine = 1;
  let newLine = 1;
  const lines = ops.map(([type, text]): ChangeDiffLine => {
    const line: ChangeDiffLine = {
      type,
      text,
      oldLine: type === "add" ? null : oldLine,
      newLine: type === "remove" ? null : newLine,
    };
    if (type !== "add") oldLine++;
    if (type !== "remove") newLine++;
    return line;
  });
  const oldLines = ops.filter(([type]) => type !== "add").length;
  const newLines = ops.filter(([type]) => type !== "remove").length;
  const oldStart = oldLines === 0 ? 0 : 1;
  const newStart = newLines === 0 ? 0 : 1;
  return {
    header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines,
  };
}

function count(ops: readonly LineOp[], type: "add" | "remove") {
  return ops.filter(([opType]) => opType === type).length;
}

function measurement(input: {
  id: string;
  scope: ChangeMeasurement["scope"];
  baselineVersion: string | null;
  ops: readonly LineOp[];
}): ChangeMeasurement {
  return {
    schemaVersion: 1,
    measurementId: `m-${input.id}`,
    worktreeId: "fixture-worktree",
    worktreeIncarnation: "fixture-incarnation",
    scope: input.scope,
    logicalOwner: {},
    baselineVersion: input.baselineVersion,
    beforeSnapshotId: "fixture-snapshot-before",
    afterSnapshotId: "fixture-snapshot-after",
    evidenceRefs: [],
    capabilityRevision: null,
    origin: "captured-endpoints",
    algorithmPolicyId: "raw-lines-v1",
    representationPolicyId: "raw-bytes-v1",
    execution: "not-applicable",
    executionOccurrence: "not-applicable",
    effectClaim: "workspace-observed",
    finality: "final",
    consistency: "stable-observation",
    boundary: { before: "fresh-before", after: "after-terminal" },
    attribution: { basis: "workspace-observation", writerIsolation: "unknown", overlap: "unknown" },
    completeness: { files: "complete", reasons: [], omittedFileCount: 0 },
    totals: {
      additions: exactCount(count(input.ops, "add")),
      deletions: exactCount(count(input.ops, "remove")),
      changedFiles: 1,
    },
    diffIdentityId: input.id,
    createdAt: "2026-10-20T00:00:00.000Z",
    supersedesMeasurementId: null,
  };
}

function fileIdentity(input: {
  id: string;
  scope: DiffIdentity["scope"];
  path: string;
  status: ChangeFileStatus;
}): DiffIdentity {
  const pathId = `path:${input.path}`;
  const before =
    input.status === "added"
      ? ({ state: "absent" } as const)
      : ({
          state: "present",
          snapshotId: "fixture-snapshot-before",
          pathId,
          blobId: "blob-before",
        } as const);
  const after =
    input.status === "deleted"
      ? ({ state: "absent" } as const)
      : ({
          state: "present",
          snapshotId: "fixture-snapshot-after",
          pathId,
          blobId: "blob-after",
        } as const);
  return {
    id: input.id,
    worktreeId: "fixture-worktree",
    worktreeIncarnation: "fixture-incarnation",
    scope: input.scope,
    measurementId: `m-${input.id}`,
    algorithmPolicyId: "raw-lines-v1",
    representationPolicyId: "raw-bytes-v1",
    rendererPolicyId: "hunks-v1",
    whitespacePolicy: "preserve",
    kind: "file",
    before,
    after,
    basePathDisplay: input.status === "added" ? null : input.path,
    targetPathDisplay: input.status === "deleted" ? null : input.path,
  };
}

function diffBody(input: {
  id: string;
  scope: DiffIdentity["scope"];
  path: string;
  status: ChangeFileStatus;
  baselineVersion: string | null;
  ops: readonly LineOp[];
}): Extract<ChangesGetDiffResult, { kind: "body" }> {
  const identity = fileIdentity(input);
  const file: ChangeDiffFileBody = {
    pathId: `path:${input.path}`,
    oldPathDisplay: identity.kind === "file" ? identity.basePathDisplay : null,
    newPathDisplay: identity.kind === "file" ? identity.targetPathDisplay : null,
    status: input.status,
    fileKind: "text",
    bodyAvailability: "available",
    reasonKey: null,
    hunks: [hunk(input.ops)],
    truncated: false,
  };
  return {
    kind: "body",
    identity,
    measurement: measurement(input),
    files: [file],
    nextCursor: null,
    viewIdentityId: input.id,
  };
}

const opsForStatus: Record<DiffFixtureStatus, readonly LineOp[]> = {
  modified: modifiedOps,
  new: modified.map((text): LineOp => ["add", text]),
  deleted: original.map((text): LineOp => ["remove", text]),
};

const fileStatus: Record<DiffFixtureStatus, ChangeFileStatus> = {
  modified: "modified",
  new: "added",
  deleted: "deleted",
};

/**
 * Backend body for a live "current workspace file" diff of `path` against the
 * environment baseline `baselineVersion` (`ref@oid`). `changes_resolve_live_detail`
 * answers with its identity and `changes_get_diff` with the body itself.
 */
export function liveDiffFixtureBody(input: {
  path: string;
  status: DiffFixtureStatus;
  baselineVersion: string;
}): Extract<ChangesGetDiffResult, { kind: "body" }> {
  return diffBody({
    id: `fixture-live-${input.status}`,
    scope: "environment-net",
    path: input.path,
    status: fileStatus[input.status],
    baselineVersion: input.baselineVersion,
    ops: opsForStatus[input.status],
  });
}

/** Historical body for a newly added one-line file at `path`. */
export function addedFileDiffBody(id: string, path: string): ChangesGetDiffResult {
  return diffBody({
    id,
    scope: "thread-net",
    path,
    status: "added",
    baselineVersion: null,
    ops: [["add", "export {};"]],
  });
}
