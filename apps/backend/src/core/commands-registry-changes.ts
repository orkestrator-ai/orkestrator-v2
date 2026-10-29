/**
 * `changes_*` commands: the read and command API of backend change tracking
 * (docs/architecture/change-tracking.md#client-contract).
 *
 * Every answer is a backend-prepared DTO. Arguments are validated and
 * bounded here; identifiers are resolved by the service into ledger records,
 * never trusted as paths.
 */

import {
  CHANGE_TRACKING_PROTOCOL_CAPABILITY,
  parseChangeResourceKey,
  type ChangeTrackingCapabilities,
  type ChangesApplyRestoreResult,
  type ChangesGetDiffResult,
  type ChangesGetFilesResult,
  type ChangesGetHandoffResult,
  type ChangesGetHistoryResult,
  type ChangesPrepareRestoreResult,
  type ChangesRefreshResult,
  type ChangesResolveLiveDetailResult,
  type ChangeViewResult,
} from "@orkestrator/protocol/change-resources";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { measureLegacyPayload, type ChangeTrackingService } from "./change-tracking/index.js";

const MAX_ID = 512;

function text(value: unknown, field: string, max = MAX_ID): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, field: string, max = MAX_ID): string | undefined {
  return value === undefined || value === null ? undefined : text(value, field, max);
}

function optionalInteger(
  value: unknown,
  field: string,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(`${field} must be a nonnegative integer`);
  }
  return value as number;
}

function stringList(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must be a list`);
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

function tracking(context: CommandContext): ChangeTrackingService {
  const service = context.runtime.changeTracking;
  if (!service) throw new Error("Change tracking is unavailable in this backend");
  return service;
}

export function registerChangeCommands(register: CommandRegistrar): void {
  register("changes_get_view", async (args, context): Promise<ChangeViewResult> => {
    const resourceKey = text(args.resourceKey, "resourceKey", 1_024);
    const parts = parseChangeResourceKey(resourceKey);
    if (
      parts?.scope === "environment-net" &&
      !context.runtime.diffStats.service.isTracked(parts.ownerId)
    ) {
      // Arm the environment's scan owner on first demand. A full reconcile
      // reloads every environment, so an already-tracked read skips it.
      await context.runtime.diffStats.sync(context);
    }
    // Git source-control scopes are computed on first demand.
    await tracking(context).ensureResource(resourceKey);
    return tracking(context).getView({
      resourceKey,
      knownGeneration: optionalText(args.knownGeneration, "knownGeneration", 128),
      knownRevision: optionalInteger(args.knownRevision, "knownRevision"),
      pageSize: optionalInteger(args.pageSize, "pageSize", 200),
    });
  });

  register("changes_get_files", async (args, context): Promise<ChangesGetFilesResult> => {
    return tracking(context).projections.files(
      text(args.resourceKey, "resourceKey", 1_024),
      text(args.snapshotToken, "snapshotToken", 1_024),
      optionalText(args.cursor, "cursor", 4_096) ?? null,
      optionalInteger(args.pageSize, "pageSize", 200) ?? 200,
    );
  });

  register("changes_get_tool_presentations", async (args, context) => {
    return tracking(context).getToolPresentations({
      environmentId: text(args.environmentId, "environmentId"),
      provider: text(args.provider, "provider", 64),
      conversationId: text(args.conversationId, "conversationId"),
      callIds: stringList(args.callIds, "callIds", 500),
    });
  });

  register("changes_get_history", async (args, context): Promise<ChangesGetHistoryResult> => {
    return tracking(context).getHistory({
      newestFirst: true,
      environmentId: text(args.environmentId, "environmentId"),
      logicalSessionKey: text(args.logicalSessionKey, "logicalSessionKey"),
      cursor: optionalText(args.cursor, "cursor", 64) ?? null,
      pageSize: optionalInteger(args.pageSize, "pageSize", 200),
    });
  });

  register("changes_get_thread", async (args, context) => {
    return tracking(context).threadResource(
      text(args.environmentId, "environmentId"),
      text(args.logicalSessionKey, "logicalSessionKey"),
    );
  });

  register(
    "changes_resolve_live_detail",
    async (args, context): Promise<ChangesResolveLiveDetailResult> => {
      return tracking(context).diffBodies.resolveLiveDetail({
        resourceKey: text(args.resourceKey, "resourceKey", 1_024),
        revision: optionalInteger(args.revision, "revision"),
        rowId: optionalText(args.rowId, "rowId"),
        pathId: optionalText(args.pathId, "pathId", 8_192),
        path: optionalText(args.path, "path", 4_096),
      });
    },
  );

  register("changes_get_diff", async (args, context): Promise<ChangesGetDiffResult> => {
    const display =
      args.display && typeof args.display === "object"
        ? (args.display as Record<string, unknown>)
        : {};
    const whitespace = display.whitespace === "ignore-for-view" ? "ignore-for-view" : "preserve";
    return tracking(context).diffBodies.getDiff({
      diffIdentityId: text(args.diffIdentityId, "diffIdentityId"),
      cursor: optionalText(args.cursor, "cursor", 32) ?? null,
      display: {
        whitespace,
        ...(optionalInteger(display.contextLines, "contextLines", 20) !== undefined
          ? { contextLines: display.contextLines as number }
          : {}),
      },
    });
  });

  register("changes_refresh", async (args, context): Promise<ChangesRefreshResult> => {
    const resourceKey = text(args.resourceKey, "resourceKey", 1_024);
    if (parseChangeResourceKey(resourceKey)?.scope === "environment-net") {
      await context.runtime.diffStats.sync(context);
    }
    return tracking(context).refresh({ resourceKey });
  });

  register("changes_get_handoff", async (args, context): Promise<ChangesGetHandoffResult> => {
    const result = tracking(context).handoff.serialize(
      stringList(args.measurementIds, "measurementIds", 200),
      optionalInteger(args.maxCharacters, "maxCharacters", 200_000) ?? 8_000,
    );
    return { kind: "handoff", ...result };
  });

  register(
    "changes_prepare_restore",
    async (args, context): Promise<ChangesPrepareRestoreResult> => {
      return tracking(context).restore.prepare({
        measurementId: text(args.measurementId, "measurementId"),
        ...(args.pathIds !== undefined
          ? { pathIds: stringList(args.pathIds, "pathIds", 2_000) }
          : {}),
      });
    },
  );

  register("changes_apply_restore", async (args, context): Promise<ChangesApplyRestoreResult> => {
    return tracking(context).restore.apply({
      actionToken: text(args.actionToken, "actionToken"),
      idempotencyKey: text(args.idempotencyKey, "idempotencyKey", 128),
    });
  });

  register("changes_get_diagnostics", async (_args, context) => tracking(context).diagnostics());

  register(
    "changes_get_capabilities",
    async (_args, context): Promise<ChangeTrackingCapabilities> => {
      const policy = tracking(context).policies.policy;
      return {
        capability: CHANGE_TRACKING_PROTOCOL_CAPABILITY,
        policyVersion: policy.version,
        history: true,
        restore: policy.restoreEnabled,
        gitScopes: true,
        operationVolume: true,
        strictCheckpoints: policy.strictCheckpoints,
      };
    },
  );

  // Compatibility: measure a legacy transcript tool payload on the backend so
  // clients never count lines themselves. Not persisted.
  register("changes_measure_legacy_payload", async (args) => {
    // Sides may legitimately be empty strings (an empty file).
    const side = (value: unknown, field: string): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string" || value.length > 16 * 1024 * 1024)
        throw new Error(`${field} must be a string`);
      return value;
    };
    return measureLegacyPayload({
      toolName: optionalText(args.toolName, "toolName", 128),
      filePath: optionalText(args.filePath, "filePath", 4_096),
      before: side(args.before, "before"),
      after: side(args.after, "after"),
      diff: side(args.diff, "diff"),
      additions: optionalInteger(args.additions, "additions"),
      deletions: optionalInteger(args.deletions, "deletions"),
    });
  });
}
