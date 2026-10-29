/**
 * The template library's wire shapes (item 109, plan P1.9, D2, D18): the three
 * scopes, project-template trust, the per-project capability ceiling, and the
 * inputs and results of the `graph_template*` backend commands.
 *
 * Built-in templates come from code ({@link graphBuiltinTemplates}), user
 * templates from the backend's `graph-templates` store (revision
 * compare-and-swap), and project templates from `.orkestrator/graphs/*.graph.json`
 * in the project's checkout. A project template is untrusted until the user
 * approves its digest ({@link graphTemplateDigest}); a changed digest is
 * untrusted again, and an untrusted template cannot launch.
 */
import { canonicalJson } from "../canonical-json.js";
import type { FieldError } from "../field-validation.js";
import type { GraphRoleProviders } from "./agent-enforcement.js";
import type { GraphCapabilityCeiling } from "./capability-profiles.js";
import type { GraphCompileDiagnostic } from "./compile-diagnostics.js";
import type { CompiledGraphPlan, GraphCompileCost, GraphPlanAcknowledgementRef } from "./plan.js";
import { GRAPH_ID_PATTERN, GRAPH_TEMPLATE_BOUNDS } from "./grammar.js";
import type { GraphBuiltInEngineStatus } from "./builtins/index.js";
import type { GraphTemplateEngine, GraphTemplateScope, GraphTemplateV1 } from "./template-model.js";

export { graphBuiltinEngineStatus, graphBuiltinTemplates } from "./builtin-registry.js";
export { GRAPH_TEMPLATE_SCOPES, type GraphTemplateScope } from "./template-model.js";

// ---------------------------------------------------------------- bounds

/** Where project templates live, relative to the project's checkout. */
export const GRAPH_PROJECT_TEMPLATE_DIRECTORY = ".orkestrator/graphs";
/** File-name suffix of a project template. */
export const GRAPH_PROJECT_TEMPLATE_SUFFIX = ".graph.json";

export const GRAPH_LIBRARY_BOUNDS = Object.freeze({
  /** Project template files read per project; later names (sorted) are skipped. */
  maxProjectFiles: 64,
  /** Bytes read per project file (the template guard's own limit). */
  maxProjectFileBytes: GRAPH_TEMPLATE_BOUNDS.maxTemplateBytes,
  /** Bytes read per project in total. */
  maxProjectTotalBytes: 16 * 1024 * 1024,
  /** Characters in a project template's file name. */
  maxProjectFileNameChars: 128,
  /** User templates in the store. */
  maxUserTemplates: 200,
  /** Serialized bytes of every user template together. */
  maxUserTemplateBytes: 32 * 1024 * 1024,
  /** Trust records kept per project. */
  maxTrustRecords: 128,
});

/** A project template file name: one path segment ending in `.graph.json`. */
export const GRAPH_PROJECT_TEMPLATE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.graph\.json$/;

/** `.orkestrator/graphs/<name>` for a valid file name, else null. */
export function graphProjectTemplatePath(fileName: string): string | null {
  if (
    fileName.length > GRAPH_LIBRARY_BOUNDS.maxProjectFileNameChars ||
    !GRAPH_PROJECT_TEMPLATE_FILE_PATTERN.test(fileName)
  ) {
    return null;
  }
  return `${GRAPH_PROJECT_TEMPLATE_DIRECTORY}/${fileName}`;
}

/** Whether `path` names a project template (`.orkestrator/graphs/<name>.graph.json`). */
export function isGraphProjectTemplatePath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const prefix = `${GRAPH_PROJECT_TEMPLATE_DIRECTORY}/`;
  return path.startsWith(prefix) && graphProjectTemplatePath(path.slice(prefix.length)) === path;
}

// ---------------------------------------------------------------- references

export type GraphTemplateRef =
  | { scope: "builtin"; id: string }
  | { scope: "user"; id: string }
  | { scope: "project"; projectId: string; path: string };

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,199}$/;

/** A reference from untrusted input, or a message saying what is wrong. */
export function parseGraphTemplateRef(value: unknown): GraphTemplateRef | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "ref must be an object with a scope" };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const only = (allowed: string[]) => keys.every((key) => allowed.includes(key));
  switch (record.scope) {
    case "builtin":
    case "user":
      if (!only(["scope", "id"])) return { error: "ref has unknown fields" };
      if (typeof record.id !== "string" || !GRAPH_ID_PATTERN.test(record.id)) {
        return { error: "ref.id must be a template id" };
      }
      if (record.id.length > GRAPH_TEMPLATE_BOUNDS.maxIdChars)
        return { error: "ref.id is too long" };
      return { scope: record.scope, id: record.id };
    case "project":
      if (!only(["scope", "projectId", "path"])) return { error: "ref has unknown fields" };
      if (typeof record.projectId !== "string" || !PROJECT_ID_PATTERN.test(record.projectId)) {
        return { error: "ref.projectId must be a project id" };
      }
      if (!isGraphProjectTemplatePath(record.path)) {
        return {
          error: `ref.path must name a file in ${GRAPH_PROJECT_TEMPLATE_DIRECTORY} ending in ${GRAPH_PROJECT_TEMPLATE_SUFFIX}`,
        };
      }
      return { scope: "project", projectId: record.projectId, path: record.path };
    default:
      return { error: "ref.scope must be builtin, user or project" };
  }
}

/** A stable string for a reference (list keys, caches). */
export function graphTemplateRefKey(ref: GraphTemplateRef): string {
  return ref.scope === "project"
    ? `project:${ref.projectId}:${ref.path}`
    : `${ref.scope}:${ref.id}`;
}

// ---------------------------------------------------------------- trust

/**
 * A project template's trust (§6.9). `untrusted`: never approved. `changed`:
 * approved once, but the file's digest has changed since, so it is untrusted
 * again until the user approves the new digest. Built-in and user templates
 * are always `trusted`.
 */
export const GRAPH_TEMPLATE_TRUST_STATES = ["trusted", "untrusted", "changed"] as const;
export type GraphTemplateTrustState = (typeof GRAPH_TEMPLATE_TRUST_STATES)[number];

/** One approval: the project template at `path` is trusted while its digest is `digest`. */
export interface GraphTemplateTrustRecord {
  /** `.orkestrator/graphs/<name>.graph.json`, relative to the checkout. */
  path: string;
  /** {@link graphTemplateDigest} of the approved template. */
  digest: string;
  /** RFC 3339 UTC. */
  approvedAt: string;
}

/** The trust state of a template whose current digest is `digest`. */
export function graphTemplateTrustState(
  record: GraphTemplateTrustRecord | undefined,
  digest: string,
): GraphTemplateTrustState {
  if (!record) return "untrusted";
  return record.digest === digest ? "trusted" : "changed";
}

// ---------------------------------------------------------------- summaries

/** What a list needs from a compile: counts, the plan digest and the cost headline. */
export interface GraphTemplateCompileSummary {
  ok: boolean;
  /** The compiler's `launchable`: no errors and no pending acknowledgement. Trust is separate. */
  launchable: boolean;
  errors: number;
  warnings: number;
  infos: number;
  pendingAcknowledgements: number;
  /** Null when there are errors. */
  planDigest: string | null;
  cost: { agentSessions: { best: number; worst: number }; peakParallelism: number } | null;
}

export interface GraphTemplateSummary {
  ref: GraphTemplateRef;
  scope: GraphTemplateScope;
  /** The template's own `id` (project files may share one; `ref` is the identity). */
  id: string;
  name: string;
  description?: string;
  engine?: GraphTemplateEngine;
  /**
   * Built-ins only: `active` when the engine named by `engine` runs the flow
   * today, `retired` when it was removed (Looped Review). Either way a
   * built-in runs on its engine, never on the graph runtime (D5): duplicate it
   * to run a copy there.
   */
  engineStatus?: GraphBuiltInEngineStatus;
  /** Store revision for user templates; the file's `revision` field otherwise. */
  revision: number;
  /** {@link graphTemplateDigest}. */
  digest: string;
  /** Built-in and project templates are read-only: duplicate to edit. */
  readOnly: boolean;
  trust: GraphTemplateTrustState;
  /** When the current digest was approved (trusted project templates). */
  approvedAt?: string;
  /**
   * Trusted, the compiler's `launchable`, and runs on the graph runtime (a
   * built-in with an `engine` does not, D5).
   */
  launchable: boolean;
  /** Compiled under the project's ceiling (or the default ceiling without a project). */
  compile: GraphTemplateCompileSummary;
  /** User templates: last save (RFC 3339 UTC). */
  updatedAt?: string;
}

/** Why a project file is listed without a template. */
export const GRAPH_PROJECT_TEMPLATE_PROBLEM_CODES = [
  "invalid-template",
  "invalid-name",
  "too-large",
  "not-a-file",
  "unreadable",
  "too-many-files",
  "total-too-large",
] as const;
export type GraphProjectTemplateProblemCode = (typeof GRAPH_PROJECT_TEMPLATE_PROBLEM_CODES)[number];

export interface GraphProjectTemplateProblem {
  /** `.orkestrator/graphs/<name>` (or the directory for directory-wide problems). */
  path: string;
  code: GraphProjectTemplateProblemCode;
  /** Bounded; never file contents. */
  message: string;
  /** Guard errors for `invalid-template` (at most 5). */
  errors?: FieldError[];
}

/**
 * Where a project's templates came from. `no-checkout`: the project has no
 * local checkout on this machine. `unavailable`: the checkout or directory
 * could not be read (or escapes the checkout). A missing directory is `ok`
 * with no files.
 */
export interface GraphProjectTemplateSource {
  projectId: string;
  status: "ok" | "no-checkout" | "unavailable";
  directory: typeof GRAPH_PROJECT_TEMPLATE_DIRECTORY;
  /** Template files read (valid or not). */
  files: number;
  /** More files than {@link GRAPH_LIBRARY_BOUNDS.maxProjectFiles} matched. */
  truncated: boolean;
  problems: GraphProjectTemplateProblem[];
}

// ---------------------------------------------------------------- commands

/** `graph_templates_list {projectId?}`. */
export interface GraphTemplatesListResult {
  /** Built-in, then user (by name), then project (by path). */
  templates: GraphTemplateSummary[];
  /** Present when a project was named. */
  project: GraphProjectTemplateSource | null;
  /** The ceiling the compile summaries used. */
  ceiling: GraphCapabilityCeiling;
}

/** `graph_template_get`, `_save`, `_duplicate`. */
export interface GraphTemplateDetail {
  summary: GraphTemplateSummary;
  template: GraphTemplateV1;
}

/** `graph_template_import {text, projectId?}`: refused text is reported, not thrown. */
export type GraphTemplateImportResult =
  | { ok: true; detail: GraphTemplateDetail; renamedFrom?: string }
  | { ok: false; errors: FieldError[]; omittedErrors: number };

/** `graph_template_compile {ref | template, projectId?, includePlan?, forLaunch?}`. */
export interface GraphTemplateCompileResponse {
  /** Null when a draft (`template`) was compiled. */
  summary: GraphTemplateSummary | null;
  ok: boolean;
  /** The compiler's `launchable`, and trusted. */
  launchable: boolean;
  /** Set when trust alone stops a launch. */
  blockedBy?: "untrusted" | "changed";
  diagnostics: GraphCompileDiagnostic[];
  omittedDiagnostics: number;
  cost: GraphCompileCost | null;
  pendingAcknowledgements: GraphPlanAcknowledgementRef[];
  planDigest: string | null;
  /** Only with `includePlan: true`. */
  plan?: CompiledGraphPlan | null;
  ceiling: GraphCapabilityCeiling;
  /**
   * `forLaunch` with a plan only: per role, every enabled provider's tier on
   * this host (probed afresh) and whether it meets each node's
   * `minEnforcement`. The launch pickers offer exactly the `allowed` ones
   * (item 209); dispatch re-checks the same judgement.
   */
  providerChoices?: GraphRoleProviders[];
}

/** `graph_template_export {ref}`. */
export interface GraphTemplateExport {
  fileName: string;
  /** {@link graphTemplateExportText}. */
  text: string;
  digest: string;
}

/** `graph_template_trust {projectId, path, action, digest?}`. */
export interface GraphTemplateTrustResult {
  projectId: string;
  path: string;
  trust: GraphTemplateTrustState;
  /** The file's current digest; null when the file is gone or invalid. */
  digest: string | null;
  approvedAt?: string;
  records: GraphTemplateTrustRecord[];
}

/** `graph_capability_ceiling_get {projectId}` and `_set {projectId, ceiling, expectedRevision?}`. */
export interface GraphProjectCeiling {
  projectId: string;
  ceiling: GraphCapabilityCeiling;
  /** No ceiling stored: every agent capability, up to the environment's policy (D18). */
  isDefault: boolean;
  /** Compare-and-swap revision of the ceiling; 0 when never set. */
  revision: number;
  updatedAt?: string;
}

/** `code` on a refused command (the gateway forwards it beside the message). */
export const GRAPH_TEMPLATE_ERROR_CODES = [
  "invalid-request",
  "not-found",
  "revision-conflict",
  "invalid-template",
  "untrusted",
  "digest-mismatch",
  "limit",
  "invalid-ceiling",
  "engine-template",
] as const;
export type GraphTemplateErrorCode = (typeof GRAPH_TEMPLATE_ERROR_CODES)[number];

// ---------------------------------------------------------------- export

/**
 * Canonical export text: keys sorted (as {@link canonicalJson}), two-space
 * indentation, trailing newline. The same template always exports the same
 * bytes, so exports diff cleanly in a repository.
 */
export function graphTemplateExportText(template: GraphTemplateV1): string {
  // Validates the value (finite numbers, depth) exactly as digests do.
  canonicalJson(template, 128);
  return graphCanonicalJsonText(template);
}

/**
 * Any JSON value as canonical pretty text: sorted keys, two-space indentation,
 * trailing newline (share bundles, item 405). The caller validates the value.
 */
export function graphCanonicalJsonText(value: unknown): string {
  return `${prettyCanonicalJson(value, "")}\n`;
}

function prettyCanonicalJson(value: unknown, indent: string): string {
  if (value === null || typeof value !== "object") {
    return typeof value === "number" && Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${inner}${prettyCanonicalJson(item ?? null, inner)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "{}";
  const fields = entries.map(
    ([key, item]) => `${inner}${JSON.stringify(key)}: ${prettyCanonicalJson(item, inner)}`,
  );
  return `{\n${fields.join(",\n")}\n${indent}}`;
}

/** `<id>.graph.json`, ready for `.orkestrator/graphs/`. */
export function graphTemplateExportFileName(template: Pick<GraphTemplateV1, "id">): string {
  return `${template.id}${GRAPH_PROJECT_TEMPLATE_SUFFIX}`;
}
