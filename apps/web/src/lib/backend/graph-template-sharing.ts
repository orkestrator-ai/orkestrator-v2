import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import type {
  GraphProjectTemplateReview,
  GraphProjectTemplateReviewDecision,
  GraphSharingKeys,
  GraphTemplateShareExport,
  GraphTemplateShareImportResult,
} from "@orkestrator/protocol/graphs/sharing";
import { type AccountMachine } from "./agent-accounts";
import { graphsOn } from "@/lib/node-scope/domains/graphs";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * Template sharing and the project template review (item 405): share
 * bundles (digest-checked, optionally signed), the installation's signing key
 * and trusted keys, and the review of untrusted or changed project templates.
 * Like item 109's wrappers, each call goes to the machine that owns the
 * project (`machine`); keys and user templates are kept per machine.
 */

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createGraphTemplateSharingApi(client: BackendClient) {
  /** A share bundle for `ref`; `sign` uses this installation's key. */
  function exportGraphTemplateBundle(
    ref: GraphTemplateRef,
    input: { sign?: boolean; author?: string } = {},
    machine?: AccountMachine,
  ): Promise<GraphTemplateShareExport> {
    return graphsOn(client, machine).graph_template_share_export({ ref, ...input });
  }

  /**
   * Checks a bundle (or plain template JSON): without `confirmDigest` it
   * resolves with a preview and saves nothing; with the preview's digest it
   * saves a new user template. A tampered text resolves with `status: "refused"`.
   */
  function importGraphTemplateBundle(
    text: string,
    input: { projectId?: string; confirmDigest?: string } = {},
    machine?: AccountMachine,
  ): Promise<GraphTemplateShareImportResult> {
    return graphsOn(client, machine).graph_template_share_import({ text, ...input });
  }

  /** The installation's public key (created with `create`) and the trusted keys. */
  function getGraphSharingKeys(
    input: { create?: boolean } = {},
    machine?: AccountMachine,
  ): Promise<GraphSharingKeys> {
    return graphsOn(client, machine).graph_sharing_keys({ ...input });
  }

  function setGraphSharingKeyTrust(
    input:
      { action: "add"; publicKey: string; label: string } | { action: "remove"; publicKey: string },
    machine?: AccountMachine,
  ): Promise<GraphSharingKeys> {
    return graphsOn(client, machine).graph_sharing_key_trust({ ...input });
  }

  /** Untrusted and changed project templates, with capability summaries and diffs. */
  function reviewGraphProjectTemplates(
    projectId: string,
    input: { path?: string } = {},
    machine?: AccountMachine,
  ): Promise<GraphProjectTemplateReview> {
    return graphsOn(client, machine).graph_project_template_review({ projectId, ...input });
  }

  /** Approve or reject a project template at the digest the user reviewed. */
  function decideGraphProjectTemplateReview(
    input: { projectId: string; path: string; digest: string; decision: "approve" | "reject" },
    machine?: AccountMachine,
  ): Promise<GraphProjectTemplateReviewDecision> {
    return graphsOn(client, machine).graph_project_template_review_decide({ ...input });
  }

  return {
    exportGraphTemplateBundle,
    importGraphTemplateBundle,
    getGraphSharingKeys,
    setGraphSharingKeyTrust,
    reviewGraphProjectTemplates,
    decideGraphProjectTemplateReview,
  };
}

export type GraphTemplateSharingApi = ReturnType<typeof createGraphTemplateSharingApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  exportGraphTemplateBundle,
  importGraphTemplateBundle,
  getGraphSharingKeys,
  setGraphSharingKeyTrust,
  reviewGraphProjectTemplates,
  decideGraphProjectTemplateReview,
} = createGraphTemplateSharingApi(commandBackendClient);
