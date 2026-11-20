/**
 * Content references and typed anchors for rich interactions.
 *
 * A `ContentRef` names the exact thing a person examined: an immutable
 * artifact revision, a file at a content hash (or explicitly the live file),
 * an earlier interaction revision, a run, a captured URL excerpt. A reference
 * identifies content; it never grants authority — the backend resolves each
 * one under the caller's authenticated scope.
 *
 * An `Anchor` narrows a reference to the part the person meant: a document
 * block, table rows, chart points or a range, a diagram object, one side of a
 * diff, a normalized image region, a PDF page region, a media time range.
 * Every anchor carries its source, so it stays bound to the revision it was
 * made on and is never silently moved to a newer one.
 *
 * Browser-safe.
 */
import { CHART_POLICY } from "../rich-content-policy.js";
import {
  arr,
  bool,
  fail,
  id,
  num,
  obj,
  oneOf,
  optArr,
  optId,
  optNum,
  optStr,
  revision,
  str,
} from "./validate.js";

export const RICH_REF_LIMITS = {
  pathChars: 1_024,
  urlChars: 2_048,
  hashChars: 128,
  quoteChars: 4_000,
  labelChars: 200,
  anchorIds: 2_000,
  sourceRefs: 32,
} as const;

export type ContentRef =
  | { kind: "artifact"; artifactId: string; revision: number; label?: string }
  | {
      kind: "file";
      path: string;
      /** Content hash of the version shown; absent means the live file. */
      contentHash?: string;
      commit?: string;
      live: boolean;
      label?: string;
    }
  | { kind: "interaction"; interactionId: string; revision: number; label?: string }
  | { kind: "message"; messageId: string; label?: string }
  | { kind: "run"; runId: string; revision?: number; label?: string }
  | { kind: "url"; url: string; capturedAt?: string; label?: string }
  | { kind: "workspace-image"; path: string; label?: string }
  | { kind: "trace"; traceId: string; revision: number; label?: string }
  | { kind: "inline"; label?: string };

export const CONTENT_REF_KINDS = [
  "artifact",
  "file",
  "interaction",
  "message",
  "run",
  "url",
  "workspace-image",
  "trace",
  "inline",
] as const;

function readPath(value: unknown, path: string): string {
  const text = str(value, path, RICH_REF_LIMITS.pathChars, 1);
  if (text.includes("\0")) fail(path, "must not contain NUL");
  if (/(^|\/)\.\.(\/|$)/u.test(text)) fail(path, "must not traverse with ..");
  return text;
}

export function readContentRef(value: unknown, path: string): ContentRef {
  const record = obj(value, path, [
    "kind",
    "artifactId",
    "revision",
    "label",
    "path",
    "contentHash",
    "commit",
    "live",
    "interactionId",
    "messageId",
    "runId",
    "url",
    "capturedAt",
    "traceId",
  ]);
  const kind = oneOf(record.kind, `${path}.kind`, CONTENT_REF_KINDS);
  const label = optStr(record.label, `${path}.label`, RICH_REF_LIMITS.labelChars);
  const withLabel = <T extends object>(ref: T): T & { label?: string } =>
    label === undefined ? ref : { ...ref, label };
  const only = (keys: string[]) => {
    for (const key of Object.keys(record)) {
      if (key !== "kind" && key !== "label" && !keys.includes(key)) {
        fail(`${path}.${key}`, `is not a field of a ${kind} reference`);
      }
    }
  };
  switch (kind) {
    case "artifact":
      only(["artifactId", "revision"]);
      return withLabel({
        kind,
        artifactId: id(record.artifactId, `${path}.artifactId`),
        revision: revision(record.revision, `${path}.revision`),
      });
    case "file": {
      only(["path", "contentHash", "commit", "live"]);
      const contentHash = optStr(
        record.contentHash,
        `${path}.contentHash`,
        RICH_REF_LIMITS.hashChars,
      );
      const live = bool(record.live, `${path}.live`);
      if (!live && contentHash === undefined && record.commit === undefined) {
        fail(path, "a non-live file reference needs a contentHash or commit");
      }
      return withLabel({
        kind,
        path: readPath(record.path, `${path}.path`),
        ...(contentHash === undefined ? {} : { contentHash }),
        ...(record.commit === undefined ? {} : { commit: id(record.commit, `${path}.commit`, 64) }),
        live,
      });
    }
    case "interaction":
      only(["interactionId", "revision"]);
      return withLabel({
        kind,
        interactionId: id(record.interactionId, `${path}.interactionId`),
        revision: revision(record.revision, `${path}.revision`),
      });
    case "message":
      only(["messageId"]);
      return withLabel({ kind, messageId: id(record.messageId, `${path}.messageId`, 400) });
    case "run":
      only(["runId", "revision"]);
      return withLabel({
        kind,
        runId: id(record.runId, `${path}.runId`),
        ...(record.revision === undefined
          ? {}
          : { revision: revision(record.revision, `${path}.revision`) }),
      });
    case "url": {
      only(["url", "capturedAt"]);
      const url = str(record.url, `${path}.url`, RICH_REF_LIMITS.urlChars, 1);
      if (!/^https?:\/\//iu.test(url)) fail(`${path}.url`, "must be an http(s) URL");
      const capturedAt = optStr(record.capturedAt, `${path}.capturedAt`, 64);
      return withLabel({ kind, url, ...(capturedAt === undefined ? {} : { capturedAt }) });
    }
    case "workspace-image":
      only(["path"]);
      return withLabel({ kind, path: readPath(record.path, `${path}.path`) });
    case "trace":
      only(["traceId", "revision"]);
      return withLabel({
        kind,
        traceId: id(record.traceId, `${path}.traceId`),
        revision: revision(record.revision, `${path}.revision`),
      });
    case "inline":
      only([]);
      return withLabel({ kind });
  }
}

export function contentRefKey(ref: ContentRef): string {
  switch (ref.kind) {
    case "artifact":
      return `artifact:${ref.artifactId}@${ref.revision}`;
    case "file":
      return `file:${ref.path}@${ref.live ? "live" : (ref.contentHash ?? ref.commit)}`;
    case "interaction":
      return `interaction:${ref.interactionId}@${ref.revision}`;
    case "message":
      return `message:${ref.messageId}`;
    case "run":
      return `run:${ref.runId}@${ref.revision ?? "current"}`;
    case "url":
      return `url:${ref.url}@${ref.capturedAt ?? "live"}`;
    case "workspace-image":
      return `image:${ref.path}`;
    case "trace":
      return `trace:${ref.traceId}@${ref.revision}`;
    case "inline":
      return "inline";
  }
}

/** One readable line describing a reference, for agent-facing summaries. */
export function describeContentRef(ref: ContentRef): string {
  const label = ref.label ? `${ref.label} ` : "";
  switch (ref.kind) {
    case "artifact":
      return `${label}(artifact ${ref.artifactId} revision ${ref.revision})`;
    case "file":
      return `${label}(file ${ref.path}${ref.live ? ", live" : ref.contentHash ? `, content ${ref.contentHash.slice(0, 16)}` : `, commit ${ref.commit}`})`;
    case "interaction":
      return `${label}(interaction ${ref.interactionId} revision ${ref.revision})`;
    case "message":
      return `${label}(message ${ref.messageId})`;
    case "run":
      return `${label}(run ${ref.runId}${ref.revision === undefined ? "" : ` revision ${ref.revision}`})`;
    case "url":
      return `${label}(${ref.url}${ref.capturedAt ? ` captured ${ref.capturedAt}` : ""})`;
    case "workspace-image":
      return `${label}(image ${ref.path})`;
    case "trace":
      return `${label}(demonstration ${ref.traceId} revision ${ref.revision})`;
    case "inline":
      return ref.label ?? "(inline content)";
  }
}

// ---------------------------------------------------------------------------
// Anchors

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnchorLocation =
  | { kind: "whole" }
  | {
      kind: "document-block";
      blockId: string;
      quote?: string;
      start?: number;
      end?: number;
      contextDigest?: string;
    }
  | { kind: "text-range"; quote: string; prefix?: string; suffix?: string }
  | { kind: "table-rows"; rowIds: string[] }
  | { kind: "table-cell"; rowId: string; columnId: string }
  | { kind: "chart-points"; seriesIds: string[]; pointIds: string[] }
  | {
      kind: "chart-range";
      seriesIds: string[];
      from: number;
      to: number;
      inclusive: boolean;
      population: "all-underlying-observations" | "visible-observations";
    }
  | { kind: "chart-categories"; categoryIds: string[]; seriesIds: string[] }
  | { kind: "diagram-objects"; objectIds: string[] }
  | {
      kind: "diff-range";
      file: string;
      side: "before" | "after";
      startLine: number;
      endLine: number;
      contentHash?: string;
      hunkId?: string;
    }
  | { kind: "image-region"; rect: NormalizedRect }
  | { kind: "pdf-region"; page: number; rect?: NormalizedRect }
  | { kind: "media-range"; startMs: number; endMs: number; transcriptExcerpt?: string }
  | { kind: "plan-step"; stepId: string }
  | { kind: "criterion"; criterionId: string }
  | { kind: "evidence"; evidenceId: string }
  | { kind: "workflow-node"; workflowId: string; runId: string; nodeId: string; attemptId?: string }
  | { kind: "trace-step"; stepIds: string[] };

export const ANCHOR_KINDS = [
  "whole",
  "document-block",
  "text-range",
  "table-rows",
  "table-cell",
  "chart-points",
  "chart-range",
  "chart-categories",
  "diagram-objects",
  "diff-range",
  "image-region",
  "pdf-region",
  "media-range",
  "plan-step",
  "criterion",
  "evidence",
  "workflow-node",
  "trace-step",
] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export interface RichAnchor {
  source: ContentRef;
  location: AnchorLocation;
}

function readRect(value: unknown, path: string): NormalizedRect {
  const record = obj(value, path, ["x", "y", "width", "height"]);
  const rect = {
    x: num(record.x, `${path}.x`, { min: 0, max: 1 }),
    y: num(record.y, `${path}.y`, { min: 0, max: 1 }),
    width: num(record.width, `${path}.width`, { min: 0, max: 1 }),
    height: num(record.height, `${path}.height`, { min: 0, max: 1 }),
  };
  if (rect.width <= 0 || rect.height <= 0) fail(path, "must have a positive area");
  if (rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) {
    fail(path, "must lie inside the normalized image (0..1)");
  }
  return rect;
}

const ids = (value: unknown, path: string, min = 1, max = 200) =>
  arr(value, path, RICH_REF_LIMITS.anchorIds, (item, itemPath) => id(item, itemPath, max), min);

export function readAnchorLocation(value: unknown, path: string): AnchorLocation {
  const record = obj(value, path, [
    "kind",
    "blockId",
    "quote",
    "start",
    "end",
    "contextDigest",
    "prefix",
    "suffix",
    "rowIds",
    "rowId",
    "columnId",
    "seriesIds",
    "pointIds",
    "from",
    "to",
    "inclusive",
    "population",
    "categoryIds",
    "objectIds",
    "file",
    "side",
    "startLine",
    "endLine",
    "contentHash",
    "hunkId",
    "rect",
    "page",
    "startMs",
    "endMs",
    "transcriptExcerpt",
    "stepId",
    "criterionId",
    "evidenceId",
    "workflowId",
    "runId",
    "nodeId",
    "attemptId",
    "stepIds",
  ]);
  const kind = oneOf(record.kind, `${path}.kind`, ANCHOR_KINDS);
  const quote = (key: string) => optStr(record[key], `${path}.${key}`, RICH_REF_LIMITS.quoteChars);
  switch (kind) {
    case "whole":
      return { kind };
    case "document-block": {
      const start = optNum(record.start, `${path}.start`, { min: 0, integer: true });
      const end = optNum(record.end, `${path}.end`, { min: 0, integer: true });
      if (start !== undefined && end !== undefined && end < start)
        fail(`${path}.end`, "must not precede start");
      const q = quote("quote");
      const digest = optStr(
        record.contextDigest,
        `${path}.contextDigest`,
        RICH_REF_LIMITS.hashChars,
      );
      return {
        kind,
        blockId: id(record.blockId, `${path}.blockId`),
        ...(q === undefined ? {} : { quote: q }),
        ...(start === undefined ? {} : { start }),
        ...(end === undefined ? {} : { end }),
        ...(digest === undefined ? {} : { contextDigest: digest }),
      };
    }
    case "text-range": {
      const prefix = quote("prefix");
      const suffix = quote("suffix");
      return {
        kind,
        quote: str(record.quote, `${path}.quote`, RICH_REF_LIMITS.quoteChars, 1),
        ...(prefix === undefined ? {} : { prefix }),
        ...(suffix === undefined ? {} : { suffix }),
      };
    }
    case "table-rows":
      return { kind, rowIds: ids(record.rowIds, `${path}.rowIds`) };
    case "table-cell":
      return {
        kind,
        rowId: id(record.rowId, `${path}.rowId`),
        columnId: id(record.columnId, `${path}.columnId`),
      };
    case "chart-points":
      return {
        kind,
        seriesIds: ids(record.seriesIds, `${path}.seriesIds`),
        pointIds: ids(
          record.pointIds,
          `${path}.pointIds`,
          1,
          CHART_POLICY.maxIdCharacters * 18 + 1,
        ),
      };
    case "chart-range": {
      const from = num(record.from, `${path}.from`);
      const to = num(record.to, `${path}.to`);
      if (to < from) fail(`${path}.to`, "must not be below from (the range is inverted)");
      return {
        kind,
        seriesIds: ids(record.seriesIds, `${path}.seriesIds`),
        from,
        to,
        inclusive: bool(record.inclusive, `${path}.inclusive`),
        population: oneOf(record.population, `${path}.population`, [
          "all-underlying-observations",
          "visible-observations",
        ] as const),
      };
    }
    case "chart-categories":
      return {
        kind,
        categoryIds: ids(record.categoryIds, `${path}.categoryIds`),
        seriesIds: ids(record.seriesIds, `${path}.seriesIds`, 0),
      };
    case "diagram-objects":
      return { kind, objectIds: ids(record.objectIds, `${path}.objectIds`) };
    case "diff-range": {
      const startLine = num(record.startLine, `${path}.startLine`, { min: 1, integer: true });
      const endLine = num(record.endLine, `${path}.endLine`, { min: 1, integer: true });
      if (endLine < startLine) fail(`${path}.endLine`, "must not precede startLine");
      const contentHash = optStr(
        record.contentHash,
        `${path}.contentHash`,
        RICH_REF_LIMITS.hashChars,
      );
      const hunkId = optId(record.hunkId, `${path}.hunkId`);
      return {
        kind,
        file: readPath(record.file, `${path}.file`),
        side: oneOf(record.side, `${path}.side`, ["before", "after"] as const),
        startLine,
        endLine,
        ...(contentHash === undefined ? {} : { contentHash }),
        ...(hunkId === undefined ? {} : { hunkId }),
      };
    }
    case "image-region":
      return { kind, rect: readRect(record.rect, `${path}.rect`) };
    case "pdf-region":
      return {
        kind,
        page: num(record.page, `${path}.page`, { min: 1, integer: true }),
        ...(record.rect === undefined ? {} : { rect: readRect(record.rect, `${path}.rect`) }),
      };
    case "media-range": {
      const startMs = num(record.startMs, `${path}.startMs`, { min: 0, integer: true });
      const endMs = num(record.endMs, `${path}.endMs`, { min: 0, integer: true });
      if (endMs <= startMs) fail(`${path}.endMs`, "must be after startMs");
      const excerpt = quote("transcriptExcerpt");
      return {
        kind,
        startMs,
        endMs,
        ...(excerpt === undefined ? {} : { transcriptExcerpt: excerpt }),
      };
    }
    case "plan-step":
      return { kind, stepId: id(record.stepId, `${path}.stepId`) };
    case "criterion":
      return { kind, criterionId: id(record.criterionId, `${path}.criterionId`) };
    case "evidence":
      return { kind, evidenceId: id(record.evidenceId, `${path}.evidenceId`) };
    case "workflow-node": {
      const attemptId = optId(record.attemptId, `${path}.attemptId`);
      return {
        kind,
        workflowId: id(record.workflowId, `${path}.workflowId`),
        runId: id(record.runId, `${path}.runId`),
        nodeId: id(record.nodeId, `${path}.nodeId`),
        ...(attemptId === undefined ? {} : { attemptId }),
      };
    }
    case "trace-step":
      return { kind, stepIds: ids(record.stepIds, `${path}.stepIds`) };
  }
}

export function readAnchor(value: unknown, path: string): RichAnchor {
  const record = obj(value, path, ["source", "location"]);
  return {
    source: readContentRef(record.source, `${path}.source`),
    location: readAnchorLocation(record.location, `${path}.location`),
  };
}

export function readContentRefs(value: unknown, path: string): ContentRef[] {
  return optArr(value, path, RICH_REF_LIMITS.sourceRefs, readContentRef) ?? [];
}

/** One readable line describing an anchor's location (no source content). */
export function describeAnchorLocation(location: AnchorLocation): string {
  switch (location.kind) {
    case "whole":
      return "the whole item";
    case "document-block":
      return `block ${location.blockId}${location.quote ? ` ("${clip(location.quote, 160)}")` : ""}`;
    case "text-range":
      return `text "${clip(location.quote, 160)}"`;
    case "table-rows":
      return `rows ${listIds(location.rowIds)}`;
    case "table-cell":
      return `cell ${location.rowId} / ${location.columnId}`;
    case "chart-points":
      return `points ${listIds(location.pointIds)} of series ${listIds(location.seriesIds)}`;
    case "chart-range":
      return `x range ${location.from}–${location.to} (${location.inclusive ? "inclusive" : "exclusive"}, ${location.population}) of series ${listIds(location.seriesIds)}`;
    case "chart-categories":
      return `categories ${listIds(location.categoryIds)}${location.seriesIds.length ? ` of series ${listIds(location.seriesIds)}` : ""}`;
    case "diagram-objects":
      return `diagram objects ${listIds(location.objectIds)}`;
    case "diff-range":
      return `${location.file} lines ${location.startLine}-${location.endLine} (${location.side} side${location.contentHash ? `, content ${location.contentHash.slice(0, 16)}` : ""})`;
    case "image-region": {
      const r = location.rect;
      return `image region x=${r.x.toFixed(3)} y=${r.y.toFixed(3)} w=${r.width.toFixed(3)} h=${r.height.toFixed(3)} (normalized)`;
    }
    case "pdf-region":
      return `page ${location.page}${location.rect ? " region" : ""}`;
    case "media-range":
      return `time ${(location.startMs / 1000).toFixed(1)}s–${(location.endMs / 1000).toFixed(1)}s`;
    case "plan-step":
      return `plan step ${location.stepId}`;
    case "criterion":
      return `criterion ${location.criterionId}`;
    case "evidence":
      return `evidence ${location.evidenceId}`;
    case "workflow-node":
      return `workflow ${location.workflowId} run ${location.runId} node ${location.nodeId}${location.attemptId ? ` attempt ${location.attemptId}` : ""}`;
    case "trace-step":
      return `demonstration steps ${listIds(location.stepIds)}`;
  }
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, 20).join(", ");
  return ids.length > 20 ? `${shown} and ${ids.length - 20} more` : shown;
}
