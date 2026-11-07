import { parseGraphTemplateRef, type GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import {
  graphProjectTemplateReviewCommand,
  graphProjectTemplateReviewDecideCommand,
  graphSharingKeysCommand,
  graphSharingKeyTrustCommand,
  graphTemplateShareExportCommand,
  graphTemplateShareImportCommand,
} from "@orkestrator/protocol/contract/domains/graphs";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { GraphTemplateError } from "./graph-template-errors.js";
import type { GraphTemplateSharing } from "./graph-template-sharing.js";

/**
 * Template sharing and the project template review (item 405): export and
 * import share bundles, read and manage signing keys, and review untrusted or
 * changed project templates. Inputs and results are the shapes in
 * `@orkestrator/protocol/graphs/sharing`. Registered with item 109's
 * `graph_template*` commands and defined in the `graphs` contract domain
 * (plan item 7007); refusals throw a `GraphTemplateError` whose `code` the
 * gateway forwards, and unknown argument keys are dropped.
 */

function sharing(context: CommandContext): GraphTemplateSharing {
  if (!context.graphTemplates) {
    throw new GraphTemplateError("invalid-request", "Graph templates are unavailable");
  }
  return context.graphTemplates.sharing;
}

function invalid(message: string): never {
  throw new GraphTemplateError("invalid-request", message);
}

function projectIdArg(value: unknown, required: true): string;
function projectIdArg(value: unknown, required?: false): string | undefined;
function projectIdArg(value: unknown, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalid("projectId is required");
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    invalid("projectId must be a project id");
  }
  return value;
}

function refArg(value: unknown): GraphTemplateRef {
  const ref = parseGraphTemplateRef(value);
  if ("error" in ref) invalid(ref.error);
  return ref;
}

function stringArg(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) invalid(`${name} must be a string`);
  return value;
}

function digestArg(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    invalid(`${name} must be a SHA-256 hex digest`);
  }
  return value;
}

export function registerGraphSharingCommands(register: CommandRegistrar): void {
  register(graphTemplateShareExportCommand, async (args, context) => {
    if (args.sign !== undefined && typeof args.sign !== "boolean")
      invalid("sign must be a boolean");
    const author = stringArg(args.author, "author", 1000);
    return sharing(context).exportBundle(refArg(args.ref), {
      ...(args.sign === true ? { sign: true } : {}),
      ...(author !== undefined ? { author } : {}),
    });
  });

  register(graphTemplateShareImportCommand, async (args, context) => {
    if (typeof args.text !== "string") invalid("text must be the bundle's (or template's) text");
    const projectId = projectIdArg(args.projectId);
    const confirmDigest = digestArg(args.confirmDigest, "confirmDigest");
    return sharing(context).importShared(args.text, {
      ...(projectId ? { projectId } : {}),
      ...(confirmDigest !== undefined ? { confirmDigest } : {}),
    });
  });

  register(graphSharingKeysCommand, async (args, context) => {
    if (args.create !== undefined && typeof args.create !== "boolean") {
      invalid("create must be a boolean");
    }
    return sharing(context).keys(args.create === true ? { create: true } : {});
  });

  register(graphSharingKeyTrustCommand, async (args, context) => {
    if (args.action !== "add" && args.action !== "remove") invalid("action must be add or remove");
    const publicKey =
      stringArg(args.publicKey, "publicKey", 64) ?? invalid("publicKey is required");
    const label = stringArg(args.label, "label", 1000);
    if (args.action === "add" && label === undefined) invalid("Trusting a key needs a label");
    return sharing(context).trustKey({
      action: args.action,
      publicKey,
      ...(label !== undefined ? { label } : {}),
    });
  });

  register(graphProjectTemplateReviewCommand, async (args, context) => {
    const path = stringArg(args.path, "path", 400);
    return sharing(context).review(projectIdArg(args.projectId, true), path);
  });

  register(graphProjectTemplateReviewDecideCommand, async (args, context) => {
    if (args.decision !== "approve" && args.decision !== "reject") {
      invalid("decision must be approve or reject");
    }
    const path = stringArg(args.path, "path", 400) ?? invalid("path is required");
    const digest = digestArg(args.digest, "digest") ?? invalid("digest is required");
    return sharing(context).decide({
      projectId: projectIdArg(args.projectId, true),
      path,
      digest,
      decision: args.decision,
    });
  });
}
