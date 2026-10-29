import { parseGraphTemplateRef, type GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { GraphTemplateError } from "./graph-template-errors.js";
import type { GraphTemplateSharing } from "./graph-template-sharing.js";

/**
 * Template sharing and the project template review (item 405): export and
 * import share bundles, read and manage signing keys, and review untrusted or
 * changed project templates. Inputs and results are the shapes in
 * `@orkestrator/protocol/graphs/sharing`. Registered with item 109's
 * `graph_template*` commands; refusals throw a `GraphTemplateError` whose
 * `code` the gateway forwards.
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

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) invalid(`Unknown arguments: ${unknown.slice(0, 5).join(", ")}`);
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
  register("graph_template_share_export", async (args, context) => {
    onlyKeys(args, ["ref", "sign", "author"]);
    if (args.sign !== undefined && typeof args.sign !== "boolean")
      invalid("sign must be a boolean");
    const author = stringArg(args.author, "author", 1000);
    return sharing(context).exportBundle(refArg(args.ref), {
      ...(args.sign === true ? { sign: true } : {}),
      ...(author !== undefined ? { author } : {}),
    });
  });

  register("graph_template_share_import", async (args, context) => {
    onlyKeys(args, ["text", "projectId", "confirmDigest"]);
    if (typeof args.text !== "string") invalid("text must be the bundle's (or template's) text");
    const projectId = projectIdArg(args.projectId);
    const confirmDigest = digestArg(args.confirmDigest, "confirmDigest");
    return sharing(context).importShared(args.text, {
      ...(projectId ? { projectId } : {}),
      ...(confirmDigest !== undefined ? { confirmDigest } : {}),
    });
  });

  register("graph_sharing_keys", async (args, context) => {
    onlyKeys(args, ["create"]);
    if (args.create !== undefined && typeof args.create !== "boolean") {
      invalid("create must be a boolean");
    }
    return sharing(context).keys(args.create === true ? { create: true } : {});
  });

  register("graph_sharing_key_trust", async (args, context) => {
    onlyKeys(args, ["action", "publicKey", "label"]);
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

  register("graph_project_template_review", async (args, context) => {
    onlyKeys(args, ["projectId", "path"]);
    const path = stringArg(args.path, "path", 400);
    return sharing(context).review(projectIdArg(args.projectId, true), path);
  });

  register("graph_project_template_review_decide", async (args, context) => {
    onlyKeys(args, ["projectId", "path", "digest", "decision"]);
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
