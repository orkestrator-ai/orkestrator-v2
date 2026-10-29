import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import type {
  GraphProjectCeiling,
  GraphTemplateCompileResponse,
  GraphTemplateDetail,
  GraphTemplateExport,
  GraphTemplateImportResult,
  GraphTemplateRef,
  GraphTemplatesListResult,
  GraphTemplateTrustResult,
} from "@orkestrator/protocol/graphs/library";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { machineInvoke, type AccountMachine } from "./agent-accounts";

/**
 * The graph template library (item 109): built-in, user and project
 * templates, project-template trust and the per-project capability ceiling.
 * Every call goes to the machine that owns the project (`machine`, as in
 * `machineInvoke`); user templates are kept per machine. A refused call
 * rejects with the backend's message and a `code` from
 * `GRAPH_TEMPLATE_ERROR_CODES` (`revision-conflict` on a stale save).
 */

export function listGraphTemplates(
  input: { projectId?: string } = {},
  machine?: AccountMachine,
): Promise<GraphTemplatesListResult> {
  return machineInvoke(machine, "graph_templates_list", { ...input });
}

export function getGraphTemplate(
  ref: GraphTemplateRef,
  input: { projectId?: string } = {},
  machine?: AccountMachine,
): Promise<GraphTemplateDetail> {
  return machineInvoke(machine, "graph_template_get", { ref, ...input });
}

/** Saves a user template; `expectedRevision` defaults to `template.revision` (0 creates). */
export function saveGraphTemplate(
  template: GraphTemplateV1,
  input: { expectedRevision?: number; projectId?: string } = {},
  machine?: AccountMachine,
): Promise<GraphTemplateDetail> {
  return machineInvoke(machine, "graph_template_save", { template, ...input });
}

export function deleteGraphTemplate(
  id: string,
  expectedRevision?: number,
  machine?: AccountMachine,
): Promise<{ deleted: boolean }> {
  return machineInvoke(machine, "graph_template_delete", {
    id,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  });
}

/** Copies any template into a new user template; a project template needs the digest reviewed. */
export function duplicateGraphTemplate(
  ref: GraphTemplateRef,
  input: { id?: string; name?: string; digest?: string; projectId?: string } = {},
  machine?: AccountMachine,
): Promise<GraphTemplateDetail> {
  return machineInvoke(machine, "graph_template_duplicate", { ref, ...input });
}

/**
 * Compiles a stored template (`ref`) or an unsaved draft (`template`) in the
 * backend, under the project's capability ceiling.
 */
export function compileGraphTemplateInBackend(
  target: { ref: GraphTemplateRef } | { template: unknown },
  input: { projectId?: string; includePlan?: boolean; forLaunch?: boolean } = {},
  machine?: AccountMachine,
): Promise<GraphTemplateCompileResponse> {
  return machineInvoke(machine, "graph_template_compile", { ...target, ...input });
}

/** JSON text to a new user template; refused text resolves with `ok: false` and errors. */
export function importGraphTemplate(
  text: string,
  input: { projectId?: string } = {},
  machine?: AccountMachine,
): Promise<GraphTemplateImportResult> {
  return machineInvoke(machine, "graph_template_import", { text, ...input });
}

export function exportGraphTemplate(
  ref: GraphTemplateRef,
  machine?: AccountMachine,
): Promise<GraphTemplateExport> {
  return machineInvoke(machine, "graph_template_export", { ref });
}

/** Approve a project template at the digest the user reviewed, or revoke its approval. */
export function setGraphTemplateTrust(
  input: { projectId: string; path: string } & (
    { action: "approve"; digest: string } | { action: "revoke" }
  ),
  machine?: AccountMachine,
): Promise<GraphTemplateTrustResult> {
  return machineInvoke(machine, "graph_template_trust", { ...input });
}

export function getGraphCapabilityCeiling(
  projectId: string,
  machine?: AccountMachine,
): Promise<GraphProjectCeiling> {
  return machineInvoke(machine, "graph_capability_ceiling_get", { projectId });
}

/** Tightens (or with `null` resets) a project's ceiling; `git.push`/`github.write` are refused. */
export function setGraphCapabilityCeiling(
  projectId: string,
  ceiling: GraphCapabilityCeiling | null,
  expectedRevision?: number,
  machine?: AccountMachine,
): Promise<GraphProjectCeiling> {
  return machineInvoke(machine, "graph_capability_ceiling_set", {
    projectId,
    ceiling,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  });
}
