import type {
  GraphTemplateCompileResponse,
  GraphTemplateDetail,
  GraphTemplateExport,
  GraphTemplateImportResult,
  GraphTemplateRef,
  GraphTemplatesListResult,
  GraphTemplateTrustResult,
} from "@orkestrator/protocol/graphs/library";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { type AccountMachine } from "./agent-accounts";
import { graphsOn } from "@/lib/node-scope/domains/graphs";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * The graph template library (item 109): built-in, user and project
 * templates, project-template trust and the per-project capability ceiling.
 * Every call goes to the machine that owns the project (`machine`, as in
 * `machineInvoke`); user templates are kept per machine. A refused call
 * rejects with the backend's message and a `code` from
 * `GRAPH_TEMPLATE_ERROR_CODES` (`revision-conflict` on a stale save). Calls go
 * through the `graphs` domain client (`graphsOn`, plan item 7007).
 */

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createGraphTemplatesApi(client: BackendClient) {
  function listGraphTemplates(
    input: { projectId?: string } = {},
    machine?: AccountMachine,
  ): Promise<GraphTemplatesListResult> {
    return graphsOn(client, machine).graph_templates_list({ ...input });
  }

  function getGraphTemplate(
    ref: GraphTemplateRef,
    input: { projectId?: string } = {},
    machine?: AccountMachine,
  ): Promise<GraphTemplateDetail> {
    return graphsOn(client, machine).graph_template_get({ ref, ...input });
  }

  /** Saves a user template; `expectedRevision` defaults to `template.revision` (0 creates). */
  function saveGraphTemplate(
    template: GraphTemplateV1,
    input: { expectedRevision?: number; projectId?: string } = {},
    machine?: AccountMachine,
  ): Promise<GraphTemplateDetail> {
    return graphsOn(client, machine).graph_template_save({ template, ...input });
  }

  /** Copies any template into a new user template; a project template needs the digest reviewed. */
  function duplicateGraphTemplate(
    ref: GraphTemplateRef,
    input: { id?: string; name?: string; digest?: string; projectId?: string } = {},
    machine?: AccountMachine,
  ): Promise<GraphTemplateDetail> {
    return graphsOn(client, machine).graph_template_duplicate({ ref, ...input });
  }

  /**
   * Compiles a stored template (`ref`) or an unsaved draft (`template`) in the
   * backend, under the project's capability ceiling.
   */
  function compileGraphTemplateInBackend(
    target: { ref: GraphTemplateRef } | { template: unknown },
    input: { projectId?: string; includePlan?: boolean; forLaunch?: boolean } = {},
    machine?: AccountMachine,
  ): Promise<GraphTemplateCompileResponse> {
    return graphsOn(client, machine).graph_template_compile({ ...target, ...input });
  }

  /** JSON text to a new user template; refused text resolves with `ok: false` and errors. */
  function importGraphTemplate(
    text: string,
    input: { projectId?: string } = {},
    machine?: AccountMachine,
  ): Promise<GraphTemplateImportResult> {
    return graphsOn(client, machine).graph_template_import({ text, ...input });
  }

  function exportGraphTemplate(
    ref: GraphTemplateRef,
    machine?: AccountMachine,
  ): Promise<GraphTemplateExport> {
    return graphsOn(client, machine).graph_template_export({ ref });
  }

  /** Approve a project template at the digest the user reviewed, or revoke its approval. */
  function setGraphTemplateTrust(
    input: { projectId: string; path: string } & (
      { action: "approve"; digest: string } | { action: "revoke" }
    ),
    machine?: AccountMachine,
  ): Promise<GraphTemplateTrustResult> {
    return graphsOn(client, machine).graph_template_trust({ ...input });
  }

  return {
    listGraphTemplates,
    getGraphTemplate,
    saveGraphTemplate,
    duplicateGraphTemplate,
    compileGraphTemplateInBackend,
    importGraphTemplate,
    exportGraphTemplate,
    setGraphTemplateTrust,
  };
}

export type GraphTemplatesApi = ReturnType<typeof createGraphTemplatesApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  listGraphTemplates,
  getGraphTemplate,
  saveGraphTemplate,
  duplicateGraphTemplate,
  compileGraphTemplateInBackend,
  importGraphTemplate,
  exportGraphTemplate,
  setGraphTemplateTrust,
} = createGraphTemplatesApi(commandBackendClient);
