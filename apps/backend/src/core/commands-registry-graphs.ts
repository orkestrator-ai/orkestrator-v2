import { parseGraphTemplateRef, type GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import { GRAPH_ID_PATTERN, GRAPH_TEMPLATE_BOUNDS } from "@orkestrator/protocol/graphs/grammar";
import {
  graphCapabilityCeilingGetCommand,
  graphCapabilityCeilingSetCommand,
  graphTemplateCompileCommand,
  graphTemplateDeleteCommand,
  graphTemplateDuplicateCommand,
  graphTemplateExportCommand,
  graphTemplateGetCommand,
  graphTemplateImportCommand,
  graphTemplateSaveCommand,
  graphTemplatesListCommand,
  graphTemplateTrustCommand,
} from "@orkestrator/protocol/contract/domains/graphs";
import type { CommandContext } from "./commands-context.js";
import { registerGraphSharingCommands } from "./commands-registry-graph-sharing.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { GraphTemplateError } from "./graph-template-errors.js";
import type { GraphTemplateService } from "./graph-template-service.js";

/**
 * The graph template library (item 109, plan P1.9): list, read, save
 * (compare-and-swap on revision), delete, duplicate, compile, import, export
 * and trust templates, and read or set a project's capability ceiling (D18).
 * Inputs and results are the shapes in `@orkestrator/protocol/graphs/library`,
 * defined in the `graphs` contract domain (plan item 7007). A refused request
 * throws a `GraphTemplateError` whose `code` the gateway forwards; unknown
 * argument keys are dropped (a defined command is tolerant).
 */

function service(context: CommandContext): GraphTemplateService {
  if (!context.graphTemplates) {
    throw new GraphTemplateError("invalid-request", "Graph templates are unavailable");
  }
  return context.graphTemplates;
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

function revisionArg(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${name} must be a non-negative integer`);
  }
  return value as number;
}

function templateIdArg(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > GRAPH_TEMPLATE_BOUNDS.maxIdChars ||
    !GRAPH_ID_PATTERN.test(value)
  ) {
    invalid(
      `${name} must be a template id (kebab-case, at most ${GRAPH_TEMPLATE_BOUNDS.maxIdChars} characters)`,
    );
  }
  return value;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) invalid(`${name} must be a string`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalid(`${name} must be a boolean`);
  return value;
}

export function registerGraphTemplateCommands(register: CommandRegistrar): void {
  register(graphTemplatesListCommand, async (args, context) => {
    const projectId = projectIdArg(args.projectId);
    return service(context).list(projectId ? { projectId } : {});
  });

  register(graphTemplateGetCommand, async (args, context) => {
    const projectId = projectIdArg(args.projectId);
    return service(context).get(refArg(args.ref), projectId ? { projectId } : {});
  });

  register(graphTemplateSaveCommand, async (args, context) => {
    if (args.template === undefined) invalid("template is required");
    const expectedRevision = revisionArg(args.expectedRevision, "expectedRevision");
    const projectId = projectIdArg(args.projectId);
    return service(context).save(args.template, {
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      ...(projectId ? { projectId } : {}),
    });
  });

  register(graphTemplateDeleteCommand, async (args, context) => {
    const id = templateIdArg(args.id, "id") ?? invalid("id is required");
    return service(context).delete(id, revisionArg(args.expectedRevision, "expectedRevision"));
  });

  register(graphTemplateDuplicateCommand, async (args, context) => {
    const id = templateIdArg(args.id, "id");
    const name = optionalString(args.name, "name", 400);
    const digest = optionalString(args.digest, "digest", 64);
    const projectId = projectIdArg(args.projectId);
    return service(context).duplicate(refArg(args.ref), {
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(digest !== undefined ? { digest } : {}),
      ...(projectId ? { projectId } : {}),
    });
  });

  register(graphTemplateCompileCommand, async (args, context) => {
    if ((args.ref === undefined) === (args.template === undefined)) {
      invalid("Pass exactly one of ref and template");
    }
    const projectId = projectIdArg(args.projectId);
    const includePlan = optionalBoolean(args.includePlan, "includePlan");
    const forLaunch = optionalBoolean(args.forLaunch, "forLaunch");
    return service(context).compile(
      args.ref !== undefined ? { ref: refArg(args.ref) } : { template: args.template },
      {
        ...(projectId ? { projectId } : {}),
        ...(includePlan !== undefined ? { includePlan } : {}),
        ...(forLaunch !== undefined ? { forLaunch } : {}),
      },
    );
  });

  register(graphTemplateImportCommand, async (args, context) => {
    if (typeof args.text !== "string") invalid("text must be the template's JSON text");
    const projectId = projectIdArg(args.projectId);
    return service(context).importText(args.text, projectId ? { projectId } : {});
  });

  register(graphTemplateExportCommand, async (args, context) => {
    return service(context).export(refArg(args.ref));
  });

  register(graphTemplateTrustCommand, async (args, context) => {
    if (args.action !== "approve" && args.action !== "revoke") {
      invalid("action must be approve or revoke");
    }
    if (typeof args.path !== "string") invalid("path is required");
    const digest = optionalString(args.digest, "digest", 64);
    if (args.action === "approve" && digest === undefined) {
      invalid("Approving needs the digest you reviewed");
    }
    return service(context).trust({
      projectId: projectIdArg(args.projectId, true),
      path: args.path,
      action: args.action,
      ...(digest !== undefined ? { digest } : {}),
    });
  });

  register(graphCapabilityCeilingGetCommand, async (args, context) => {
    return service(context).getCeiling(projectIdArg(args.projectId, true));
  });

  register(graphCapabilityCeilingSetCommand, async (args, context) => {
    if (args.ceiling === undefined) invalid("ceiling is required (null resets it to the default)");
    return service(context).setCeiling(
      projectIdArg(args.projectId, true),
      args.ceiling,
      revisionArg(args.expectedRevision, "expectedRevision"),
    );
  });

  // Item 405: share bundles, signing keys and the project template review.
  registerGraphSharingCommands(register);
}
