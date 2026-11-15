import { createHash } from "node:crypto";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { isBackendId } from "@orkestrator/protocol/federation";
import type { CommandContext } from "./commands-context.js";
import { NodeOutcomeUnknownError, NodeUnavailableError } from "./nodes/index.js";
import {
  applyPatchInWorker,
  assertRootChangeSelection,
  buildSelectedRootChangesPatch,
  patchPaths,
  withReceivingWorker,
} from "./root-changes.js";

/**
 * The checkout's uncommitted changes applied to a worker on another node
 * (to-do 0395 (retired) task 2; coordinator.md, "Worker surfaces").
 *
 * The changes are the command node's: the user picked them from this node's
 * checkout in the approval dialog, so the patch is built here, after the
 * approval, exactly as for a local worker. It then crosses the node link in
 * one `apply_controller_root_patch` call, which the worker's node runs as
 * `git apply --check` and `git apply` under the same lock and fence a local
 * apply takes. The checkout is only read; the worker gets all of the patch
 * or none of it.
 *
 * The patch travels base64-encoded inside one invoke body, which a node's
 * gateway caps at 48 MiB (`MAX_INVOKE_BODY_BYTES`), and within one node-link
 * call's 60-second budget. {@link MAX_NODE_ROOT_CHANGE_PATCH_BYTES} keeps it
 * well inside both, and a larger patch is refused here before anything is
 * sent. A lost answer is never resent: the request settles outcome-unknown.
 */

/** The largest patch sent to another node: 16 MiB, about 21 MiB once encoded. */
export const MAX_NODE_ROOT_CHANGE_PATCH_BYTES = 16 * 1024 * 1024;

const MIB = 1024 * 1024;

export interface ApplyRootChangesOnNodeInput {
  /** This node's project, whose checkout the patch is built from. */
  projectId: string;
  environmentId: string;
  paths: readonly string[];
  nodeId: string;
  nodeName: string;
  /** The same project's copy on that node, which owns the worker. */
  nodeProjectId: string;
  /** Names the call in the node-link outcome ledger. */
  requestKey: string;
}

export type ApplyRootChangesOnNodeOutcome =
  | { files: string[] }
  /** The node may or may not have applied it; nothing was resent. */
  | { files: string[]; outcomeUnknown: true };

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the approved selection's patch here and have the worker's node apply
 * it. Refuses, with nothing sent, an empty or oversized selection, a patch
 * over {@link MAX_NODE_ROOT_CHANGE_PATCH_BYTES}, a node that is not
 * connected and a node too old to have the command.
 */
export async function applyRootChangesOnNode(
  context: CommandContext,
  input: ApplyRootChangesOnNodeInput,
): Promise<ApplyRootChangesOnNodeOutcome> {
  assertRootChangeSelection(input.paths);
  const portal = context.nodePortal;
  if (!portal || !isBackendId(input.nodeId))
    throw new Error("Cross-node changes are not available in this backend. Nothing was sent.");
  // The build itself stops at the node limit, so any larger selection, even
  // one past the local 32 MiB cap, gets this node-specific refusal.
  const { patch, files } = await buildSelectedRootChangesPatch(
    context.storage,
    input.projectId,
    input.paths,
    {
      maxBytes: MAX_NODE_ROOT_CHANGE_PATCH_BYTES,
      message: `The selected changes are larger than ${MAX_NODE_ROOT_CHANGE_PATCH_BYTES / MIB} MiB; at most ${MAX_NODE_ROOT_CHANGE_PATCH_BYTES / MIB} MiB can be sent to ${input.nodeName}. Pick fewer files, or commit and push them instead. Nothing was sent.`,
    },
  );
  let routed: Awaited<ReturnType<typeof portal.invokeOnNode>>;
  try {
    routed = await portal.invokeOnNode({
      nodeId: input.nodeId,
      command: "apply_controller_root_patch",
      args: {
        projectId: input.nodeProjectId,
        environmentId: input.environmentId,
        patch: patch.toString("base64"),
        sha256: sha256(patch),
      },
      requestKey: input.requestKey,
    });
  } catch (error) {
    if (error instanceof NodeOutcomeUnknownError) return { files, outcomeUnknown: true };
    if (error instanceof NodeUnavailableError)
      throw new Error(`${input.nodeName} is not connected. Nothing was sent.`);
    if (incompatibility(error, "apply_controller_root_patch")?.code === "unknown-command")
      throw new Error(
        `${input.nodeName} runs an older Orkestrator that cannot receive uncommitted changes; update that node, then ask again. Nothing was sent.`,
      );
    throw error;
  }
  if (routed.outcome !== "ok") return { files, outcomeUnknown: true };
  const result = routed.result as { files?: unknown } | null;
  return {
    files:
      Array.isArray(result?.files) && result.files.every((file) => typeof file === "string")
        ? (result.files as string[])
        : files,
  };
}

export interface ApplyControllerRootPatchInput {
  projectId: string;
  environmentId: string;
  patch: unknown;
  sha256: unknown;
}

/**
 * The worker's node: apply a patch a command node built from its checkout
 * after the user approved it there. Only an attached command node reaches
 * this (`apply_controller_root_patch` is `internal`, and coordinators are
 * refused it by name). The worker must be a worker of `projectId` here,
 * never the project checkout, and the patch must arrive whole.
 */
export async function applyControllerRootPatch(
  context: CommandContext,
  input: ApplyControllerRootPatchInput,
): Promise<{ files: string[] }> {
  // Base64 of the largest patch a command node sends, with room for padding.
  const maxEncoded = Math.ceil(MAX_NODE_ROOT_CHANGE_PATCH_BYTES / 3) * 4;
  if (
    typeof input.patch !== "string" ||
    input.patch.length === 0 ||
    input.patch.length > maxEncoded ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.patch)
  )
    throw new Error(
      `Expected a base64 patch of at most ${MAX_NODE_ROOT_CHANGE_PATCH_BYTES / MIB} MiB.`,
    );
  if (typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256))
    throw new Error("Expected the patch's sha256.");
  const patch = Buffer.from(input.patch, "base64");
  if (patch.length > MAX_NODE_ROOT_CHANGE_PATCH_BYTES || sha256(patch) !== input.sha256)
    throw new Error("The patch did not arrive whole; nothing was applied.");
  const files = patchPaths(patch);
  if (files.length === 0) throw new Error("The patch names no files; nothing was applied.");
  return withReceivingWorker(context, input.projectId, input.environmentId, async (environment) => {
    await applyPatchInWorker(environment, patch);
    return { files };
  });
}
