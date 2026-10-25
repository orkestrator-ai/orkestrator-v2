import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import type {
  ChangeHistoryEntry,
  ChangesGetHistoryResult,
} from "@orkestrator/protocol/change-resources";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { useChangeProjection } from "@/hooks/useChangeProjection";
import { changeLabel, changeReason, projectionTitle } from "@/lib/changes/labels";
import { cn } from "@/lib/utils";
import { ChangeCountBadge } from "./ChangeCountBadge";
import { ChangeStateTag, isProvisionalProjection } from "./ChangeStateTag";
import { RestoreChangesButton } from "./RestoreChangesButton";

export const TURN_HISTORY_PAGE_SIZE = 25;

type OpenDiff = (title: string, target: ChangeDiffTarget) => void;

interface HistoryState {
  /** Which first-page read this state answers; a newer read replaces it. */
  pageKey: string;
  status: "loading" | "ready" | "error";
  entries: ChangeHistoryEntry[];
  nextCursor: string | null;
  message?: string;
}

function formatTurnTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function historyErrorMessage(result: ChangesGetHistoryResult | unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    (result as { kind?: unknown }).kind === "error"
  ) {
    const reasonKey = (result as { error?: { reasonKey?: unknown } }).error?.reasonKey;
    if (typeof reasonKey === "string") return changeReason(reasonKey);
  }
  return "Turn history is unavailable";
}

function isHistoryPage(
  value: unknown,
): value is Extract<ChangesGetHistoryResult, { kind: "page" }> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "page" &&
    Array.isArray(candidate.entries) &&
    (candidate.nextCursor === null || typeof candidate.nextCursor === "string")
  );
}

/**
 * Persisted turns of a thread, paged from the backend. Each turn shows its
 * `turn-net` projection and, when the provider reported one, its
 * `provider-turn-diff` projection as a separate secondary line. The two are
 * different questions and are never combined; turns are never summed.
 *
 * `refreshToken` re-reads the first page (for example on a turn edge).
 */
export function TurnChangesHistory({
  environmentId,
  logicalSessionKey,
  refreshToken,
  onOpenDiff,
  pageSize = TURN_HISTORY_PAGE_SIZE,
}: {
  environmentId: string;
  logicalSessionKey: string;
  refreshToken?: unknown;
  onOpenDiff?: OpenDiff;
  pageSize?: number;
}) {
  const owner = `${environmentId}\0${logicalSessionKey}`;
  const pageKey = `${owner}\0${String(refreshToken ?? "")}`;
  const [state, setState] = useState<HistoryState | null>(null);

  const read = useCallback(
    (cursor: string | null) =>
      Promise.resolve().then(() =>
        backend.getChangeHistory({ environmentId, logicalSessionKey, cursor, pageSize }),
      ),
    [environmentId, logicalSessionKey, pageSize],
  );

  useEffect(() => {
    let cancelled = false;
    void read(null).then(
      (result: unknown) => {
        if (cancelled) return;
        setState(
          isHistoryPage(result)
            ? { pageKey, status: "ready", entries: result.entries, nextCursor: result.nextCursor }
            : {
                pageKey,
                status: "error",
                entries: [],
                nextCursor: null,
                message: historyErrorMessage(result),
              },
        );
      },
      () => {
        if (cancelled) return;
        setState({
          pageKey,
          status: "error",
          entries: [],
          nextCursor: null,
          message: "Turn history is unavailable",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pageKey, read]);

  const loadMore = useCallback(
    (cursor: string) => {
      const requestKey = pageKey;
      setState((current) =>
        current && current.pageKey === requestKey ? { ...current, status: "loading" } : current,
      );
      void read(cursor).then(
        (result: unknown) => {
          setState((current) => {
            if (!current || current.pageKey !== requestKey) return current;
            if (!isHistoryPage(result))
              return { ...current, status: "error", message: historyErrorMessage(result) };
            const known = new Set(current.entries.map((entry) => entry.turnId));
            return {
              pageKey: requestKey,
              status: "ready",
              entries: [
                ...current.entries,
                ...result.entries.filter((entry) => !known.has(entry.turnId)),
              ],
              nextCursor: result.nextCursor,
            };
          });
        },
        () => {
          setState((current) =>
            current && current.pageKey === requestKey
              ? { ...current, status: "error", message: "Turn history is unavailable" }
              : current,
          );
        },
      );
    },
    [pageKey, read],
  );

  // While a newer first page is pending, keep this session's previous rows on
  // screen (marked loading) rather than flashing an empty list.
  const current = state?.pageKey === pageKey ? state : null;
  const previous = state && state.pageKey.startsWith(`${owner}\0`) ? state : null;
  const status = current?.status ?? "loading";
  const entries = (current ?? previous)?.entries ?? [];
  const nextCursor = current?.nextCursor ?? null;
  const message = current?.message;

  return (
    <div data-testid="turn-changes-history" className="flex flex-col gap-1">
      {entries.length === 0 && status === "ready" ? (
        <p className="px-1 py-1 text-xs text-muted-foreground">No turns recorded yet.</p>
      ) : null}
      {entries.length > 0 ? (
        <ol className="flex flex-col gap-1">
          {entries.map((entry) => (
            <TurnChangesEntry key={entry.turnId} entry={entry} onOpenDiff={onOpenDiff} />
          ))}
        </ol>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="px-1 py-1 text-xs text-destructive">
          {message}
        </p>
      ) : null}
      {status === "loading" ? (
        <div
          role="status"
          className="flex items-center gap-1.5 px-1 py-1 text-xs text-muted-foreground"
        >
          <Loader2 className="size-3.5 animate-spin" />
          Loading turn changes…
        </div>
      ) : nextCursor ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 self-start text-xs"
          onClick={() => loadMore(nextCursor)}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}

function TurnChangesEntry({
  entry,
  onOpenDiff,
}: {
  entry: ChangeHistoryEntry;
  onOpenDiff?: OpenDiff;
}) {
  const providerDiff = entry.presentation.changes.find(
    (change) => change.role === "provider-turn-diff",
  );
  const volume = entry.presentation.changes.find((change) => change.role === "operation-volume");
  const time = formatTurnTime(entry.startedAt);
  return (
    <li
      data-testid="turn-changes-entry"
      data-turn-id={entry.turnId}
      className="flex flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5"
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{time ? `Turn · ${time}` : "Turn"}</span>
        <span>{entry.lifecycle}</span>
      </div>
      <TurnChangeLine
        resourceKey={entry.turnResourceKey}
        fallbackLabelKey="changes.scope.turn-net"
        prominence="primary"
        timeLabel={time}
        testId="turn-net-line"
        onOpenDiff={onOpenDiff}
      />
      {providerDiff ? (
        <TurnChangeLine
          resourceKey={providerDiff.resourceKey}
          fallbackLabelKey="changes.scope.provider-turn-diff"
          prominence="secondary"
          timeLabel={time}
          testId="provider-turn-diff-line"
          onOpenDiff={onOpenDiff}
        />
      ) : null}
      {volume ? (
        <TurnChangeLine
          resourceKey={volume.resourceKey}
          fallbackLabelKey="changes.scope.operation-volume"
          prominence="secondary"
          timeLabel={time}
          testId="operation-volume-line"
          onOpenDiff={onOpenDiff}
        />
      ) : null}
    </li>
  );
}

function TurnChangeLine({
  resourceKey,
  fallbackLabelKey,
  prominence,
  timeLabel,
  testId,
  onOpenDiff,
}: {
  resourceKey: string;
  fallbackLabelKey: string;
  prominence: "primary" | "secondary";
  timeLabel: string | null;
  testId: string;
  onOpenDiff?: OpenDiff;
}) {
  const projection = useChangeProjection(resourceKey);
  const label = projection
    ? changeLabel(projection.labelKey, projection.labelArgs)
    : changeLabel(fallbackLabelKey);
  const diffIdentityId = projection?.detail?.diffIdentityId ?? null;
  const tabTitle = timeLabel ? `${label} (${timeLabel})` : label;
  return (
    <div
      data-testid={testId}
      data-resource-key={resourceKey}
      title={projection ? projectionTitle(projection) : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 text-xs",
        prominence === "secondary" ? "pl-3 text-muted-foreground" : "text-foreground",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      {projection ? (
        <>
          <ChangeCountBadge projection={projection} testId={`${testId}-badge`} />
          <ChangeStateTag
            projection={projection}
            showReason={isProvisionalProjection(projection)}
          />
          {prominence === "primary" ? <RestoreChangesButton projection={projection} /> : null}
        </>
      ) : (
        <span className="text-[10px] text-muted-foreground">Loading…</span>
      )}
      {diffIdentityId && onOpenDiff ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="ml-auto size-6"
          aria-label={`Open ${tabTitle}`}
          title={`Open ${label}`}
          onClick={() =>
            onOpenDiff(tabTitle, { kind: "historical", diffIdentityId, title: tabTitle })
          }
        >
          <ExternalLink className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
