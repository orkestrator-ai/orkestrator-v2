import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import type {
  GraphProjectTemplateReview,
  GraphProjectTemplateReviewDecision,
  GraphSharingKeys,
  GraphTemplateShareExport,
  GraphTemplateShareImportResult,
} from "@orkestrator/protocol/graphs/sharing";
import { machineInvoke, type AccountMachine } from "./agent-accounts";

/**
 * Template sharing and the project template review (item 405): share
 * bundles (digest-checked, optionally signed), the installation's signing key
 * and trusted keys, and the review of untrusted or changed project templates.
 * Like item 109's wrappers, each call goes to the machine that owns the
 * project (`machine`); keys and user templates are kept per machine.
 */

/** A share bundle for `ref`; `sign` uses this installation's key. */
export function exportGraphTemplateBundle(
  ref: GraphTemplateRef,
  input: { sign?: boolean; author?: string } = {},
  machine?: AccountMachine,
): Promise<GraphTemplateShareExport> {
  return machineInvoke(machine, "graph_template_share_export", { ref, ...input });
}

/**
 * Checks a bundle (or plain template JSON): without `confirmDigest` it
 * resolves with a preview and saves nothing; with the preview's digest it
 * saves a new user template. A tampered text resolves with `status: "refused"`.
 */
export function importGraphTemplateBundle(
  text: string,
  input: { projectId?: string; confirmDigest?: string } = {},
  machine?: AccountMachine,
): Promise<GraphTemplateShareImportResult> {
  return machineInvoke(machine, "graph_template_share_import", { text, ...input });
}

/** The installation's public key (created with `create`) and the trusted keys. */
export function getGraphSharingKeys(
  input: { create?: boolean } = {},
  machine?: AccountMachine,
): Promise<GraphSharingKeys> {
  return machineInvoke(machine, "graph_sharing_keys", { ...input });
}

export function setGraphSharingKeyTrust(
  input:
    { action: "add"; publicKey: string; label: string } | { action: "remove"; publicKey: string },
  machine?: AccountMachine,
): Promise<GraphSharingKeys> {
  return machineInvoke(machine, "graph_sharing_key_trust", { ...input });
}

/** Untrusted and changed project templates, with capability summaries and diffs. */
export function reviewGraphProjectTemplates(
  projectId: string,
  input: { path?: string } = {},
  machine?: AccountMachine,
): Promise<GraphProjectTemplateReview> {
  return machineInvoke(machine, "graph_project_template_review", { projectId, ...input });
}

/** Approve or reject a project template at the digest the user reviewed. */
export function decideGraphProjectTemplateReview(
  input: { projectId: string; path: string; digest: string; decision: "approve" | "reject" },
  machine?: AccountMachine,
): Promise<GraphProjectTemplateReviewDecision> {
  return machineInvoke(machine, "graph_project_template_review_decide", { ...input });
}
