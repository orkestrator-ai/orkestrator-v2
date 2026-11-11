/**
 * Authenticated, bounded command surface for web annotations.
 *
 * Every command is defined in `@orkestrator/protocol/contract/domains/web-annotations`
 * (plan item 7004): the registry decodes its arguments with the definition's
 * schema (the former strict Zod map, now tolerant: unknown keys are dropped,
 * a declared `provenance` is still refused). Each handler verifies the
 * environment exists and is not being deleted, and scopes every lookup to
 * that environment (records of another environment are never reachable).
 *
 * Before the arguments are decoded (`beforeDecode`), every call passes the
 * backend rollout switch (`enabled` / `read-only` / `disabled`, see
 * `web-annotation-rollout.ts`) and the payload ceiling, and records a
 * content-free outcome metric (command name + typed error code), exactly in
 * the order the handlers checked them before the conversion.
 */
import {
  InvalidCommandArgsError,
  type AnyCommandDef,
} from "@orkestrator/protocol/contract/command";
import * as wa from "@orkestrator/protocol/contract/domains/web-annotations";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_CONTRACT_VERSION,
  WEB_ANNOTATION_LIMITS,
  formatWebAnnotationError,
  isWebAnnotationRolloutMode,
  normalizeWebAnnotationRolloutSettings,
  type WebAnnotationCapabilities,
  type WebAnnotationCommandArgs,
  type WebAnnotationRolloutSnapshot,
} from "@orkestrator/protocol/web-annotations";
import type * as SchemaIssue from "effect/SchemaIssue";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import type {
  CommandRegistrar,
  CommandTarget,
  DefinedCommandHandler,
} from "./commands-registry-types.js";
import { commandTargetName } from "./commands-registry-contracts.js";
import {
  errorOutcome,
  maxBase64Chars,
  rolloutError,
  webAnnotationAccessAllowed,
  webAnnotationCommandAccess,
  WebAnnotationMetrics,
  type WebAnnotationService,
} from "./web-annotations/index.js";

/** Default ceiling for one command's JSON arguments. */
const MAX_ARGS_BYTES = 256 * 1024;
/** Asset uploads carry one base64 PNG plus a small envelope. */
const MAX_ASSET_ARGS_BYTES = maxBase64Chars(WEB_ANNOTATION_LIMITS.imageBytes) + 4 * 1024;
/** A dirty compose draft value (text, mentions, attachment references). */
const MAX_DRAFT_VALUE_ARGS_BYTES = 2 * 1024 * 1024;

const MAX_BYTES_BY_COMMAND: Readonly<Record<string, number>> = {
  [WEB_ANNOTATION_COMMANDS.assetStage]: MAX_ASSET_ARGS_BYTES,
  [WEB_ANNOTATION_COMMANDS.reconcileDraft]: MAX_DRAFT_VALUE_ARGS_BYTES,
};

function argsBytes(args: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(args) ?? "");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Refuses an oversized payload before it is decoded, with the typed capacity error. */
function assertPayloadBounded(command: string, args: unknown): void {
  const maxBytes = MAX_BYTES_BY_COMMAND[command] ?? MAX_ARGS_BYTES;
  const bytes = argsBytes(args);
  if (bytes <= maxBytes) return;
  throw new Error(
    formatWebAnnotationError(`${WEB_ANNOTATION_CAPACITY} ${command} payload is too large`, {
      code: "capacity",
      resource: "payload",
      limit: maxBytes,
      ...(Number.isSafeInteger(bytes) ? { requested: bytes } : {}),
    }),
  );
}

/**
 * The first failure's path and its own message: a validator's text (a
 * capture's `validateWebAnnotationCaptureInput` error) or a check's `message`.
 */
function firstFailure(
  issue: SchemaIssue.Issue,
  path: readonly PropertyKey[] = [],
): { path: readonly PropertyKey[]; message: string | undefined } {
  switch (issue._tag) {
    case "Pointer":
      return firstFailure(issue.issue, [...path, ...issue.path]);
    case "Composite":
      return firstFailure(issue.issues[0], path);
    case "Encoding":
      return firstFailure(issue.issue, path);
    case "Filter": {
      const inner = firstFailure(issue.issue, path);
      const own = issue.filter.annotations?.message;
      return { path, message: inner.message ?? (typeof own === "string" ? own : undefined) };
    }
    case "InvalidValue": {
      const message = issue.annotations?.message;
      return { path, message: typeof message === "string" ? message : undefined };
    }
    case "MissingKey":
      return { path, message: "is required" };
    default:
      return { path, message: undefined };
  }
}

/**
 * The registry's argument failure in the wording these commands always used,
 * `Invalid <command> <field>: <reason>` (the outcome metric and the renderer
 * read the prefix). Values never appear.
 */
function invalidArguments(
  command: string,
  error: InvalidCommandArgsError,
): InvalidCommandArgsError {
  const failure = firstFailure(error.cause.issue);
  const where = failure.path.length > 0 ? failure.path.map(String).join(".") : "arguments";
  const message =
    failure.message !== undefined
      ? `Invalid ${command} ${where}: ${failure.message}`
      : `Invalid ${command}: ${error.message}`;
  return new InvalidCommandArgsError({ message, command, cause: error.cause });
}

function service(context: CommandContext): WebAnnotationService {
  if (!context.webAnnotations) throw new Error("Web annotation service unavailable");
  return context.webAnnotations;
}

/** The environment must exist and not be scheduled for deletion. */
async function requireEnvironment(context: CommandContext, environmentId: string): Promise<void> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment || environment.deletionRequestedAt) throw new Error("Environment not found");
}

function unavailableCapabilities(reason: string): WebAnnotationCapabilities {
  return {
    contractVersion: WEB_ANNOTATION_CONTRACT_VERSION,
    storage: "unavailable",
    degradedReason: reason,
    operations: {
      read: false,
      author: false,
      captureAccept: false,
      dispatch: false,
      batch: false,
      resultTools: false,
      comparison: false,
      migration: false,
      resolve: false,
      recover: false,
      archive: false,
    },
    targets: [],
    maxRequestAnnotations: 0,
    limits: WEB_ANNOTATION_LIMITS,
  };
}

/** Used when the backend has no annotation service (metrics still answer). */
const FALLBACK_METRICS = new WebAnnotationMetrics();

/**
 * The rollout switch, the payload ceiling and the outcome metric around one
 * command's whole call, before its arguments are decoded.
 */
function gate(name: string, run: CommandHandler): CommandHandler {
  return (args, context, invocation) => {
    const startedAt = Date.now();
    const service = context.webAnnotations;
    const metrics =
      service?.metrics instanceof WebAnnotationMetrics ? service.metrics : FALLBACK_METRICS;
    const record = (outcome: string) =>
      metrics.recordCommand(name, outcome, Math.max(0, Date.now() - startedAt));
    const failed = (error: unknown) => {
      record(errorOutcome(error));
      return error;
    };
    try {
      const reported: unknown = service?.rolloutMode;
      const mode = isWebAnnotationRolloutMode(reported) ? reported : "enabled";
      if (!webAnnotationAccessAllowed(mode, webAnnotationCommandAccess(name))) {
        throw rolloutError(mode);
      }
      assertPayloadBounded(name, args);
    } catch (error) {
      return Promise.reject(failed(error));
    }
    let result: unknown;
    try {
      result = run(args, context, invocation);
    } catch (error) {
      // Argument decoding fails synchronously, as for every defined command.
      throw failed(
        error instanceof InvalidCommandArgsError ? invalidArguments(name, error) : error,
      );
    }
    return Promise.resolve(result).then(
      (value) => {
        record("ok");
        return value;
      },
      (error: unknown) => {
        throw failed(error);
      },
    );
  };
}

/**
 * Wrap a registrar so every web annotation command passes the rollout switch
 * and the payload ceiling and records a content-free outcome (command name +
 * typed error code), before a definition's arguments are decoded.
 */
export function gatedRegistrar(register: CommandRegistrar): CommandRegistrar {
  const gated = (target: CommandTarget, handler: CommandHandler): void => {
    const name = commandTargetName(target);
    if (typeof target === "string") register(name, gate(name, handler));
    else
      register(target, handler as DefinedCommandHandler<AnyCommandDef>, {
        beforeDecode: (run) => gate(name, run),
      });
  };
  return gated as CommandRegistrar;
}

function rolloutSnapshot(context: CommandContext): WebAnnotationRolloutSnapshot {
  if (context.webAnnotationRollout) return context.webAnnotationRollout.snapshot();
  const reported: unknown = context.webAnnotations?.rolloutMode;
  const mode = isWebAnnotationRolloutMode(reported) ? reported : "enabled";
  return { mode, configured: mode, override: null };
}

type Args = WebAnnotationCommandArgs;

export function registerWebAnnotationCommands(registerCommand: CommandRegistrar): void {
  const register = gatedRegistrar(registerCommand);

  register(wa.webAnnotationsCapabilitiesCommand, async (input, context) => {
    if (!context.webAnnotations)
      return unavailableCapabilities("Web annotation service unavailable");
    if (input.environmentId) await requireEnvironment(context, input.environmentId);
    return context.webAnnotations.capabilities(input.environmentId);
  });

  register(wa.webAnnotationsListCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.list(input);
  });

  register(wa.webAnnotationsChangesCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.changes(input.environmentId, input.generation, input.after);
  });

  register(wa.webAnnotationGetCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.get(
      input.environmentId,
      input.annotationId,
      input.entryLimit,
      input.entryWindow,
    );
  });

  register(wa.webAnnotationEntriesCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.entries(
      input.environmentId,
      input.annotationId,
      input.afterSequence,
      input.limit,
      input.beforeSequence,
    );
  });

  register(wa.webAnnotationCaptureCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return { capture: await annotations.capture(input.environmentId, input.captureId) };
  });

  register(wa.webAnnotationDraftGetCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return { draft: await annotations.getDraft(input.environmentId, input.editorId) };
  });

  register(wa.webAnnotationDraftSaveCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return { draft: await annotations.saveDraft(input) };
  });

  register(wa.webAnnotationDraftDeleteCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.deleteDraft(input.environmentId, input.editorId, input.expectedRevision);
  });

  register(wa.webAnnotationCreateCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.create(input as Args["web_annotation_create"]);
  });

  register(wa.webAnnotationOperationReceiptCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return { receipt: await annotations.receipt(input.environmentId, input.operationId) };
  });

  register(wa.webAnnotationEntryAppendCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.appendEntryCommand(input);
  });

  register(wa.webAnnotationEntryEditCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.editEntry(input);
  });

  register(wa.webAnnotationUpdateCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.update(input);
  });

  register(wa.webAnnotationCaptureReplaceCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.replaceCapture(input as Args["web_annotation_capture_replace"]);
  });

  register(wa.webAnnotationResolveCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.resolve(input);
  });

  register(wa.webAnnotationReopenCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.reopen(input);
  });

  register(wa.webAnnotationDeleteCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.delete(input);
  });

  register(wa.webAnnotationAssetStageCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.stageAsset(input);
  });

  register(wa.webAnnotationAssetGetCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.getAsset(input.environmentId, input.assetId);
  });

  register(wa.webAnnotationDestinationsCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.destinations(input.environmentId);
  });

  register(wa.webAnnotationRequestPrepareCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.prepare(input as Args["web_annotation_request_prepare"]);
  });

  register(wa.webAnnotationRequestSendCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.send(input);
  });

  register(wa.webAnnotationRequestGetCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.getRequest(input.environmentId, input.requestId);
  });

  register(wa.webAnnotationRequestsCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.listRequests(input.environmentId, {
      ...(input.annotationId !== undefined ? { annotationId: input.annotationId } : {}),
      ...(input.activeOnly !== undefined ? { activeOnly: input.activeOnly } : {}),
    });
  });

  register(wa.webAnnotationRequestCancelCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.cancelRequest(input.environmentId, input.requestId, input.expectedRevision);
  });

  register(wa.webAnnotationRequestRecoverCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.recoverRequest(input.environmentId, input.requestId, input.action);
  });

  register(wa.webAnnotationRequestResponseCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.requestResponse(input.environmentId, input.requestId);
  });

  register(wa.webAnnotationRequestFollowUpCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.followUp(input.environmentId, input.requestId);
  });

  register(wa.webAnnotationResultCaptureCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.captureResult(input as Args["web_annotation_result_capture"]);
  });

  register(wa.webAnnotationsMigrateCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.migrate(input.environmentId);
  });

  register(wa.webAnnotationsMigrationStatusCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.migrationStatus(input.environmentId);
  });

  register(wa.webAnnotationArchiveCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.archive(input);
  });

  register(wa.webAnnotationsReconcileDraftCommand, async (input, context) => {
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.reconcileDraft(input.environmentId, input.value);
  });

  register(wa.webAnnotationsRolloutCommand, async (_input, context) => {
    await context.webAnnotationRollout?.refresh();
    return rolloutSnapshot(context);
  });

  register(wa.webAnnotationsRolloutSetCommand, async (input, context) => {
    const next = normalizeWebAnnotationRolloutSettings({ mode: input.mode });
    await context.storage.patchGlobalConfig({ webAnnotations: next });
    context.webAnnotationRollout?.setConfigured(next.mode);
    return rolloutSnapshot(context);
  });

  register(wa.webAnnotationsMetricsCommand, async (_input, context) =>
    (context.webAnnotations?.metrics ?? FALLBACK_METRICS).snapshot(),
  );
}
