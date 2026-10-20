import {
  environmentChangeResourceKey,
  type ChangeError,
  type ChangeProjection,
  type ChangeViewResult,
} from "@orkestrator/protocol/change-resources";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import {
  PUBLIC_CHANGE_SCOPES,
  type PublicChangeFilePage,
  type PublicChangeScope,
  type PublicChangesHistory,
  type PublicChangesHistoryEntry,
  type PublicChangesView,
} from "@orkestrator/protocol/public-api-resources";
import type { ChangeTrackingService } from "../change-tracking/service.js";
import { requireEnvironment } from "./actions-discovery.js";
import { PublicActionError } from "./errors.js";
import {
  onlyActionKeys,
  oneOf,
  optionalInteger,
  optionalString,
  requiredId,
  sessionTarget,
} from "./input.js";
import { resolveSession } from "./sessions.js";
import type { PublicActionContext, PublicActionHandler, ReadActionHandler } from "./types.js";

/**
 * Read-only change tracking (docs/architecture/change-tracking.md).
 *
 * Both actions answer with the backend's own `ChangeProjection` — the one the
 * `changes_*` commands give every UI client — never a separate count. Nothing
 * here counts lines, sums pages or turns a missing count into zero.
 */

const UNAVAILABLE = "Change tracking is unavailable in this backend";

function changeTracking(context: PublicActionContext): ChangeTrackingService {
  const service = context.command.runtime.changeTracking;
  if (!service) throw new PublicActionError("capability-unavailable", UNAVAILABLE);
  return service;
}

function unavailableReason(context: PublicActionContext): string | null {
  return context.command.runtime.changeTracking ? null : UNAVAILABLE;
}

/** A `changes_*` error as a public error; reason keys are content-free. */
function changeError(error: ChangeError): PublicActionError {
  const details = { reasonKey: error.reasonKey };
  switch (error.code) {
    case "stale-cursor":
    case "stale-revision":
    case "owner-replaced":
      return new PublicActionError(
        "cursor-expired",
        "The changes moved on since this cursor was issued; read the first page again",
        { details },
      );
    case "not-found":
    case "resource-deleted":
      return new PublicActionError("not-found", "These changes are no longer tracked", {
        details,
      });
    case "unsupported-capability":
      return new PublicActionError(
        "capability-unavailable",
        "This backend cannot read these changes",
        {
          details,
        },
      );
    case "invalid-request":
      return new PublicActionError("invalid-input", "The change request was refused", { details });
    default:
      return new PublicActionError("operation-failed", "The changes could not be read", {
        details: { ...details, code: error.code },
        retryable: true,
      });
  }
}

/** The projection of a view result, or the public error it stands for. */
function viewProjection(view: ChangeViewResult): ChangeProjection {
  if (view.kind === "projection" || view.kind === "reset") return view.projection;
  if (view.kind === "deleted") {
    throw new PublicActionError("not-found", "These changes are no longer tracked");
  }
  if (view.kind === "error") throw changeError(view.error);
  // Only conditional reads (known generation and revision) answer `unchanged`.
  throw new PublicActionError("internal-error", "The change view answered without a projection");
}

const changesView: ReadActionHandler<{
  environmentId: string;
  scope: PublicChangeScope;
  pageSize?: number;
  cursor?: string;
}> = {
  kind: "read",
  action: "changes.view",
  parse(input) {
    onlyActionKeys(input, "changes.view");
    const pageSize = optionalInteger(input, "pageSize", 1, PUBLIC_API_LIMITS.pageMaxItems);
    const cursor = optionalString(input, "cursor", 1024);
    return {
      environmentId: requiredId(input, "environmentId"),
      scope: oneOf(input, "scope", PUBLIC_CHANGE_SCOPES) ?? "environment",
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };
  },
  unavailableReason,
  async run(input, context) {
    const environment = await requireEnvironment(context, input.environmentId);
    const tracking = changeTracking(context);
    // As `changes_get_view` and `get_environment_diff_stats` do: make sure the
    // environment's scan owner is tracking it before reading.
    await context.command.runtime.diffStats.sync(context.command);
    const resourceKey = environmentChangeResourceKey(environment.id);
    const projection = viewProjection(
      tracking.getView({
        resourceKey,
        ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
      }),
    );
    let files: PublicChangeFilePage;
    if (input.cursor !== undefined) {
      // The cursor is pinned to the revision it came from; a newer revision
      // refuses it instead of mixing two measurements in one listing.
      if (!projection.filePage) {
        throw changeError({ code: "stale-cursor", reasonKey: "changes.error.stale-cursor" });
      }
      const page = tracking.projections.files(
        resourceKey,
        projection.filePage.snapshotToken,
        input.cursor,
        input.pageSize ?? tracking.policies.policy.filePageRows,
      );
      if (page.kind === "error") throw changeError(page.error);
      files = { rows: page.rows, nextCursor: page.nextCursor, totalRows: page.totalRows };
    } else {
      files = projection.filePage
        ? {
            rows: projection.filePage.rows,
            nextCursor: projection.filePage.nextCursor,
            totalRows: projection.filePage.totalRows,
          }
        : { rows: [], nextCursor: null, totalRows: null };
    }
    const result: PublicChangesView = {
      environmentId: environment.id,
      scope: input.scope,
      projection,
      files,
    };
    return { result };
  },
};

const changesHistory: ReadActionHandler<{
  sessionId: string;
  environmentId: string;
  tabId: string;
  limit: number;
  cursor?: string;
}> = {
  kind: "read",
  action: "changes.history",
  parse(input) {
    onlyActionKeys(input, "changes.history");
    const target = sessionTarget(input);
    const limit =
      optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.pageMaxItems) ??
      PUBLIC_API_LIMITS.pageDefaultItems;
    const cursor = optionalString(input, "cursor", 64);
    return { ...target, limit, ...(cursor !== undefined ? { cursor } : {}) };
  },
  unavailableReason,
  async run(input, context) {
    const session = await resolveSession(context, input);
    const tracking = changeTracking(context);
    // Persisted turns only: no worktree scan, no provider or transcript read.
    const page = tracking.getHistory({
      environmentId: session.environment.id,
      logicalSessionKey: session.logicalSessionKey,
      cursor: input.cursor ?? null,
      pageSize: input.limit,
    });
    if (page.kind === "error") throw changeError(page.error);
    const entries: PublicChangesHistoryEntry[] = page.entries.map((entry) => {
      const projections: Record<string, ChangeProjection> = {};
      for (const change of entry.presentation.changes) {
        // Counts only: the turn's files are a separate, explicit read.
        const view = tracking.getView({ resourceKey: change.resourceKey, pageSize: 0 });
        if (view.kind === "projection" || view.kind === "reset") {
          projections[change.resourceKey] = view.projection;
        }
      }
      return { ...entry, projections };
    });
    const result: PublicChangesHistory = {
      sessionId: session.sessionId,
      entries,
      nextCursor: page.nextCursor,
    };
    return { result };
  },
};

export const CHANGE_HANDLERS: PublicActionHandler[] = [changesView, changesHistory];
