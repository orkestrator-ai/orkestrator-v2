/**
 * Authenticated, bounded command surface for web annotations.
 *
 * Every handler parses an explicit strict schema matching
 * `WebAnnotationCommandArgs`, rejects oversized payloads before the service
 * runs, verifies the environment exists and is not being deleted, and scopes
 * every lookup to that environment (records of another environment are never
 * reachable). Declared provenance on client payloads is rejected: the backend
 * assigns it.
 *
 * Every handler also passes the backend rollout switch (`enabled` /
 * `read-only` / `disabled`, see `web-annotation-rollout.ts`) and records a
 * content-free outcome metric (command name + typed error code).
 */
import { z } from "zod";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_CONTRACT_VERSION,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_ROLLOUT_MODES,
  formatWebAnnotationError,
  isWebAnnotationRolloutMode,
  normalizeWebAnnotationRolloutSettings,
  type WebAnnotationCapabilities,
  type WebAnnotationCommandArgs,
  type WebAnnotationDestination,
  type WebAnnotationRolloutSnapshot,
} from "@orkestrator/protocol/web-annotations";
import {
  assertNoDeclaredProvenance,
  isWebAnnotationDestination,
  isWebAnnotationId,
  validateWebAnnotationCaptureInput,
} from "@orkestrator/protocol/web-annotations-validation";
import { maxBase64Chars } from "./web-annotation-assets.js";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { WebAnnotationMetrics } from "./web-annotation-metrics.js";
import {
  webAnnotationAccessAllowed,
  webAnnotationCommandAccess,
} from "./web-annotation-rollout.js";
import { errorOutcome, rolloutError } from "./web-annotation-service-errors.js";
import type { WebAnnotationService } from "./web-annotation-service.js";

/** Default ceiling for one command's JSON arguments. */
const MAX_ARGS_BYTES = 256 * 1024;
/** Asset uploads carry one base64 PNG plus a small envelope. */
const MAX_ASSET_ARGS_BYTES = maxBase64Chars(WEB_ANNOTATION_LIMITS.imageBytes) + 4 * 1024;
/** A dirty compose draft value (text, mentions, attachment references). */
const MAX_DRAFT_VALUE_ARGS_BYTES = 2 * 1024 * 1024;

const id = z.string().refine(isWebAnnotationId, "must be a bounded opaque id");
const environmentId = id;
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const text = (max: number) => z.string().max(max);
const destination = z.custom<WebAnnotationDestination>(
  isWebAnnotationDestination,
  "destination is invalid",
);
const capture = z.unknown().superRefine((value, ctx) => {
  try {
    assertNoDeclaredProvenance(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid" });
    return;
  }
  const result = validateWebAnnotationCaptureInput(value);
  if (!result.ok) ctx.addIssue({ code: "custom", message: result.error });
});
const body = text(WEB_ANNOTATION_LIMITS.entryChars * 2);
const operationId = id;

const schemas = {
  capabilities: z.object({ environmentId: environmentId.optional() }).strict(),
  list: z
    .object({
      environmentId,
      filter: z
        .object({
          pageKey: text(4_200).optional(),
          state: z.enum(["open", "resolved", "all"]).optional(),
          destinationTabId: id.optional(),
          includeHidden: z.boolean().optional(),
          importedOnly: z.boolean().optional(),
          includeArchived: z.boolean().optional(),
        })
        .strict()
        .optional(),
      cursor: text(2_000).optional(),
      limit: z.number().int().min(1).max(WEB_ANNOTATION_LIMITS.listPageItems).optional(),
    })
    .strict(),
  changes: z.object({ environmentId, generation: text(100).optional(), after: revision }).strict(),
  get: z
    .object({
      environmentId,
      annotationId: id,
      entryLimit: z.number().int().min(1).max(WEB_ANNOTATION_LIMITS.entryPageItems).optional(),
      entryWindow: z.enum(["oldest", "latest"]).optional(),
    })
    .strict(),
  entries: z
    .object({
      environmentId,
      annotationId: id,
      afterSequence: revision,
      beforeSequence: revision.optional(),
      limit: z.number().int().min(1).max(WEB_ANNOTATION_LIMITS.entryPageItems).optional(),
    })
    .strict(),
  capture: z.object({ environmentId, captureId: id }).strict(),
  draftGet: z.object({ environmentId, editorId: text(400) }).strict(),
  draftSave: z
    .object({
      environmentId,
      editorId: text(400),
      expectedRevision: revision,
      text: text(WEB_ANNOTATION_LIMITS.entryChars * 2),
      annotationId: id.nullable().optional(),
      captureId: id.nullable().optional(),
      pendingCaptureId: id.nullable().optional(),
      operation: z.enum(["discuss", "implement"]).nullable().optional(),
      destination: destination.nullable().optional(),
    })
    .strict(),
  draftDelete: z
    .object({ environmentId, editorId: text(400), expectedRevision: revision })
    .strict(),
  create: z
    .object({
      environmentId,
      operationId,
      capture,
      body,
      title: text(WEB_ANNOTATION_LIMITS.titleChars * 2).optional(),
      draftId: id.optional(),
    })
    .strict(),
  receipt: z.object({ environmentId, operationId }).strict(),
  entryAppend: z
    .object({
      environmentId,
      operationId,
      annotationId: id,
      expectedContentRevision: revision,
      body,
      editorId: text(400).optional(),
    })
    .strict(),
  entryEdit: z
    .object({
      environmentId,
      operationId,
      annotationId: id,
      entryId: id,
      expectedContentRevision: revision,
      body,
    })
    .strict(),
  update: z
    .object({
      environmentId,
      operationId,
      annotationId: id,
      expectedMetadataRevision: revision,
      title: text(WEB_ANNOTATION_LIMITS.titleChars * 2).optional(),
      defaultDestination: destination.nullable().optional(),
      hidden: z.boolean().optional(),
    })
    .strict(),
  captureReplace: z
    .object({
      environmentId,
      operationId,
      annotationId: id,
      expectedContentRevision: revision,
      capture,
      body: body.optional(),
    })
    .strict(),
  resolve: z
    .object({
      environmentId,
      operationId,
      annotationId: id,
      expectedContentRevision: revision,
      expectedCaptureId: id,
      requestId: id.optional(),
      resultId: id.optional(),
      expectedResultRevision: revision.optional(),
      note: text(WEB_ANNOTATION_LIMITS.entryChars).optional(),
    })
    .strict(),
  reopen: z
    .object({
      environmentId,
      operationId,
      annotationId: id,
      expectedMetadataRevision: revision,
      body: body.optional(),
    })
    .strict(),
  delete: z
    .object({ environmentId, operationId, annotationId: id, expectedMetadataRevision: revision })
    .strict(),
  assetStage: z
    .object({
      environmentId,
      operationId,
      mediaType: z.literal("image/png"),
      data: z.string().min(1).max(maxBase64Chars(WEB_ANNOTATION_LIMITS.imageBytes)),
    })
    .strict(),
  assetGet: z.object({ environmentId, assetId: id }).strict(),
  destinations: z.object({ environmentId }).strict(),
  requestPrepare: z
    .object({
      environmentId,
      operation: z.enum(["discuss", "implement"]),
      destination,
      annotations: z
        .array(
          z
            .object({
              annotationId: id,
              expectedContentRevision: revision,
              expectedCaptureId: id,
              desiredOutcome: text(WEB_ANNOTATION_LIMITS.desiredOutcomeChars).nullable().optional(),
              allowHistoricalEvidence: z.boolean().optional(),
            })
            .strict(),
        )
        // Empty only with followUpOf/retargetOf (the service selects defaults).
        .max(WEB_ANNOTATION_LIMITS.briefAnnotations),
      instruction: text(WEB_ANNOTATION_LIMITS.instructionChars),
      textOnly: z.boolean().optional(),
      followUpOf: id.optional(),
      retargetOf: id.optional(),
    })
    .strict(),
  requestSend: z
    .object({
      environmentId,
      preparationId: id,
      requestId: id,
      bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  requestGet: z.object({ environmentId, requestId: id }).strict(),
  requestList: z
    .object({ environmentId, annotationId: id.optional(), activeOnly: z.boolean().optional() })
    .strict(),
  requestCancel: z.object({ environmentId, requestId: id, expectedRevision: revision }).strict(),
  requestRecover: z
    .object({ environmentId, requestId: id, action: z.enum(["reconcile", "retry", "discard"]) })
    .strict(),
  requestResponse: z.object({ environmentId, requestId: id }).strict(),
  requestFollowUp: z.object({ environmentId, requestId: id }).strict(),
  // Comparison metadata is optional and bounds-checked by the service
  // (`validateWebAnnotationResultCaptureMetadata`).
  resultCapture: z
    .object({
      environmentId,
      operationId,
      requestId: id,
      annotationId: id.optional(),
      capture,
      zoomFactor: z.number().optional(),
      deviceScaleFactor: z.number().optional(),
      scroll: z.object({ x: z.number(), y: z.number() }).strict().optional(),
      stability: z.enum(["stable", "unstable"]).optional(),
      masks: z
        .array(
          z
            .object({
              source: z.enum(["sensitive-field", "manual"]),
              rect: z
                .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
                .strict(),
            })
            .strict(),
        )
        .max(WEB_ANNOTATION_LIMITS.redactionRegions)
        .optional(),
      targetResolution: z.unknown().optional(),
    })
    .strict(),
  migrate: z.object({ environmentId }).strict(),
  migrationStatus: z.object({ environmentId }).strict(),
  archive: z
    .object({
      environmentId,
      operationId,
      annotationId: id,
      expectedMetadataRevision: revision,
      title: text(WEB_ANNOTATION_LIMITS.titleChars * 2).optional(),
      body: body.optional(),
    })
    .strict(),
  reconcileDraft: z.object({ environmentId, value: z.unknown() }).strict(),
  rollout: z.object({}).strict(),
  rolloutSet: z.object({ mode: z.enum(WEB_ANNOTATION_ROLLOUT_MODES) }).strict(),
  metrics: z.object({}).strict(),
} satisfies Record<keyof typeof WEB_ANNOTATION_COMMANDS, z.ZodType>;

function argsBytes(args: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(args) ?? "");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parse<K extends keyof typeof schemas>(
  key: K,
  args: Record<string, unknown>,
  maxBytes = MAX_ARGS_BYTES,
): z.infer<(typeof schemas)[K]> {
  const bytes = argsBytes(args);
  if (bytes > maxBytes) {
    throw new Error(
      formatWebAnnotationError(
        `${WEB_ANNOTATION_CAPACITY} ${WEB_ANNOTATION_COMMANDS[key]} payload is too large`,
        {
          code: "capacity",
          resource: "payload",
          limit: maxBytes,
          ...(Number.isSafeInteger(bytes) ? { requested: bytes } : {}),
        },
      ),
    );
  }
  const result = schemas[key].safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "arguments";
    throw new Error(
      `Invalid ${WEB_ANNOTATION_COMMANDS[key]} ${where}: ${issue?.message ?? "invalid"}`,
    );
  }
  return result.data as z.infer<(typeof schemas)[K]>;
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
 * Wrap a registrar so every web annotation command passes the rollout switch
 * and records a content-free outcome (command name + typed error code).
 */
function gatedRegistrar(register: CommandRegistrar): CommandRegistrar {
  return (name, handler) =>
    register(name, async (args, context) => {
      const startedAt = Date.now();
      const service = context.webAnnotations;
      const metrics =
        service?.metrics instanceof WebAnnotationMetrics ? service.metrics : FALLBACK_METRICS;
      try {
        const reported: unknown = service?.rolloutMode;
        const mode = isWebAnnotationRolloutMode(reported) ? reported : "enabled";
        if (!webAnnotationAccessAllowed(mode, webAnnotationCommandAccess(name))) {
          throw rolloutError(mode);
        }
        const result = await handler(args, context);
        metrics.recordCommand(name, "ok", Math.max(0, Date.now() - startedAt));
        return result;
      } catch (error) {
        metrics.recordCommand(name, errorOutcome(error), Math.max(0, Date.now() - startedAt));
        throw error;
      }
    });
}

function rolloutSnapshot(context: CommandContext): WebAnnotationRolloutSnapshot {
  if (context.webAnnotationRollout) return context.webAnnotationRollout.snapshot();
  const reported: unknown = context.webAnnotations?.rolloutMode;
  const mode = isWebAnnotationRolloutMode(reported) ? reported : "enabled";
  return { mode, configured: mode, override: null };
}

export function registerWebAnnotationCommands(registerCommand: CommandRegistrar): void {
  const register = gatedRegistrar(registerCommand);
  const c = WEB_ANNOTATION_COMMANDS;

  register(c.capabilities, async (args, context) => {
    const input = parse("capabilities", args);
    if (!context.webAnnotations)
      return unavailableCapabilities("Web annotation service unavailable");
    if (input.environmentId) await requireEnvironment(context, input.environmentId);
    return context.webAnnotations.capabilities(input.environmentId);
  });

  register(c.list, async (args, context) => {
    const input = parse("list", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.list(input);
  });

  register(c.changes, async (args, context) => {
    const input = parse("changes", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.changes(input.environmentId, input.generation, input.after);
  });

  register(c.get, async (args, context) => {
    const input = parse("get", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.get(
      input.environmentId,
      input.annotationId,
      input.entryLimit,
      input.entryWindow,
    );
  });

  register(c.entries, async (args, context) => {
    const input = parse("entries", args);
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

  register(c.capture, async (args, context) => {
    const input = parse("capture", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return { capture: await annotations.capture(input.environmentId, input.captureId) };
  });

  register(c.draftGet, async (args, context) => {
    const input = parse("draftGet", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return { draft: await annotations.getDraft(input.environmentId, input.editorId) };
  });

  register(c.draftSave, async (args, context) => {
    const input = parse("draftSave", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return { draft: await annotations.saveDraft(input) };
  });

  register(c.draftDelete, async (args, context) => {
    const input = parse("draftDelete", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.deleteDraft(input.environmentId, input.editorId, input.expectedRevision);
  });

  register(c.create, async (args, context) => {
    assertNoDeclaredProvenance(args);
    const input = parse("create", args) as WebAnnotationCommandArgs["web_annotation_create"];
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.create(input);
  });

  register(c.receipt, async (args, context) => {
    const input = parse("receipt", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return { receipt: await annotations.receipt(input.environmentId, input.operationId) };
  });

  register(c.entryAppend, async (args, context) => {
    assertNoDeclaredProvenance(args);
    const input = parse("entryAppend", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.appendEntryCommand(input);
  });

  register(c.entryEdit, async (args, context) => {
    assertNoDeclaredProvenance(args);
    const input = parse("entryEdit", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.editEntry(input);
  });

  register(c.update, async (args, context) => {
    const input = parse("update", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.update(input);
  });

  register(c.captureReplace, async (args, context) => {
    assertNoDeclaredProvenance(args);
    const input = parse(
      "captureReplace",
      args,
    ) as WebAnnotationCommandArgs["web_annotation_capture_replace"];
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.replaceCapture(input);
  });

  register(c.resolve, async (args, context) => {
    const input = parse("resolve", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.resolve(input);
  });

  register(c.reopen, async (args, context) => {
    assertNoDeclaredProvenance(args);
    const input = parse("reopen", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.reopen(input);
  });

  register(c.delete, async (args, context) => {
    const input = parse("delete", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.delete(input);
  });

  register(c.assetStage, async (args, context) => {
    const input = parse("assetStage", args, MAX_ASSET_ARGS_BYTES);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.stageAsset(input);
  });

  register(c.assetGet, async (args, context) => {
    const input = parse("assetGet", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.getAsset(input.environmentId, input.assetId);
  });

  register(c.destinations, async (args, context) => {
    const input = parse("destinations", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.destinations(input.environmentId);
  });

  register(c.requestPrepare, async (args, context) => {
    assertNoDeclaredProvenance(args);
    const input = parse("requestPrepare", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.prepare(input as WebAnnotationCommandArgs["web_annotation_request_prepare"]);
  });

  register(c.requestSend, async (args, context) => {
    const input = parse("requestSend", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.send(input);
  });

  register(c.requestGet, async (args, context) => {
    const input = parse("requestGet", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.getRequest(input.environmentId, input.requestId);
  });

  register(c.requestList, async (args, context) => {
    const input = parse("requestList", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.listRequests(input.environmentId, {
      ...(input.annotationId !== undefined ? { annotationId: input.annotationId } : {}),
      ...(input.activeOnly !== undefined ? { activeOnly: input.activeOnly } : {}),
    });
  });

  register(c.requestCancel, async (args, context) => {
    const input = parse("requestCancel", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.cancelRequest(input.environmentId, input.requestId, input.expectedRevision);
  });

  register(c.requestRecover, async (args, context) => {
    const input = parse("requestRecover", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.recoverRequest(input.environmentId, input.requestId, input.action);
  });

  register(c.requestResponse, async (args, context) => {
    const input = parse("requestResponse", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.requestResponse(input.environmentId, input.requestId);
  });

  register(c.requestFollowUp, async (args, context) => {
    const input = parse("requestFollowUp", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.followUp(input.environmentId, input.requestId);
  });

  register(c.resultCapture, async (args, context) => {
    assertNoDeclaredProvenance(args);
    const input = parse(
      "resultCapture",
      args,
    ) as WebAnnotationCommandArgs["web_annotation_result_capture"];
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.captureResult(input);
  });

  register(c.migrate, async (args, context) => {
    const input = parse("migrate", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.migrate(input.environmentId);
  });

  register(c.migrationStatus, async (args, context) => {
    const input = parse("migrationStatus", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.migrationStatus(input.environmentId);
  });

  register(c.archive, async (args, context) => {
    assertNoDeclaredProvenance(args);
    const input = parse("archive", args);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.archive(input);
  });

  register(c.reconcileDraft, async (args, context) => {
    const input = parse("reconcileDraft", args, MAX_DRAFT_VALUE_ARGS_BYTES);
    const annotations = service(context);
    await requireEnvironment(context, input.environmentId);
    return annotations.reconcileDraft(input.environmentId, input.value);
  });

  register(c.rollout, async (args, context) => {
    parse("rollout", args);
    await context.webAnnotationRollout?.refresh();
    return rolloutSnapshot(context);
  });

  register(c.rolloutSet, async (args, context) => {
    const input = parse("rolloutSet", args);
    const current = await context.storage.loadConfig();
    const next = normalizeWebAnnotationRolloutSettings({ mode: input.mode });
    await context.storage.updateGlobalConfig({ ...current.global, webAnnotations: next });
    context.webAnnotationRollout?.setConfigured(next.mode);
    return rolloutSnapshot(context);
  });

  register(c.metrics, async (args, context) => {
    parse("metrics", args);
    return (context.webAnnotations?.metrics ?? FALLBACK_METRICS).snapshot();
  });
}
