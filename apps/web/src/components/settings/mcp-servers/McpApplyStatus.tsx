import { useState } from "react";
import { toast } from "sonner";

import type {
  McpApplyState,
  McpOperationSnapshot,
  McpRuntimeApplyEntry,
} from "@orkestrator/protocol/mcp-management";

import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { useAccountMachine } from "@/components/settings/account-machine";
import { cn } from "@/lib/utils";

import { mcpProblemFrom, mcpProblemText } from "./McpErrorNotice";

const STATE_TEXT: Record<McpApplyState, string> = {
  "not-requested": "Saved; used when this provider next loads it",
  queued: "Saved; waiting for current work to finish",
  applying: "Saved; applying now",
  // Loaded is all application can prove: whether the server then connected
  // or needs a sign-in is live health, shown in the session's MCP panel.
  applied: "Saved and loaded",
  "pending-next-turn": "Saved; not loaded until the session's next message",
  "pending-reattach": "Saved; not loaded until the session reconnects",
  // Neutral on purpose: a removal needs the restart to unload, not to load.
  "restart-required": "Saved; takes effect after a restart",
  "blocked-policy": "Saved; this session's policy excludes it",
  failed: "Saved, but applying failed",
  reconciling: "Saved; checking state after an interruption",
  cancelled: "Saved; applying was cancelled",
};

const TONE: Partial<Record<McpApplyState, string>> = {
  failed: "text-red-300",
  "restart-required": "text-amber-300",
  "blocked-policy": "text-amber-300",
  queued: "text-blue-300",
  applying: "text-blue-300",
  applied: "text-emerald-300",
};

const KIND_TEXT: Record<McpOperationSnapshot["kind"], string> = {
  add: "Added",
  update: "Edited",
  rename: "Renamed",
  remove: "Removed",
  "set-enabled": "Changed enablement of",
  apply: "Applied",
};

export function applyStateText(state: McpApplyState): string {
  return STATE_TEXT[state];
}

const WAITING: ReadonlySet<McpApplyState> = new Set([
  "queued",
  "applying",
  "pending-next-turn",
  "pending-reattach",
  "reconciling",
]);

type OmittedStates = McpOperationSnapshot["apply"]["omittedStates"];

interface OutcomeCounts {
  loaded: number;
  waiting: number;
  failed: number;
  other: number;
  /** Past what one apply tracks: never scheduled, so in no state at all. */
  untracked: number;
}

function outcomeCounts(
  states: ReadonlyArray<readonly [McpApplyState, number]>,
  untracked: number,
): OutcomeCounts {
  const counts: OutcomeCounts = { loaded: 0, waiting: 0, failed: 0, other: 0, untracked };
  for (const [state, count] of states) {
    if (state === "applied") counts.loaded += count;
    else if (WAITING.has(state)) counts.waiting += count;
    else if (state === "failed") counts.failed += count;
    else counts.other += count;
  }
  return counts;
}

function countParts(counts: OutcomeCounts, includeLoaded: boolean): string[] {
  const parts: string[] = [];
  if (includeLoaded && counts.loaded) parts.push(`${counts.loaded} loaded`);
  if (counts.waiting) parts.push(`${counts.waiting} waiting`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.other) parts.push(`${counts.other} need attention`);
  if (counts.untracked) parts.push(`${counts.untracked} not tracked`);
  return parts;
}

/** Unlisted sessions by state; any remainder of `omitted` was never tracked. */
function omittedEntries(omitted: number, omittedStates: OmittedStates) {
  const entries = Object.entries(omittedStates ?? {}).filter(([, count]) => !!count) as Array<
    [McpApplyState, number]
  >;
  const tracked = entries.reduce((sum, [, count]) => sum + count, 0);
  return { entries, untracked: Math.max(0, omitted - tracked) };
}

/**
 * Headline for an operation whose sessions ended up in different states, e.g.
 * "Saved; loaded in 2 of 3 sessions, 1 waiting". Unlisted sessions count by
 * their state, and sessions past what one apply tracks as "not tracked". Null
 * when every session shares one state (the aggregate state already says it).
 */
export function partialOutcomeText(
  runtimes: readonly McpRuntimeApplyEntry[],
  omitted = 0,
  omittedStates?: OmittedStates,
): string | null {
  const hidden = omittedEntries(omitted, omittedStates);
  const states = new Set<string>(runtimes.map((runtime) => runtime.state));
  for (const [state] of hidden.entries) states.add(state);
  if (hidden.untracked) states.add("untracked");
  if (states.size < 2) return null;
  const counts = outcomeCounts(
    [...runtimes.map((runtime) => [runtime.state, 1] as const), ...hidden.entries],
    hidden.untracked,
  );
  const total = runtimes.length + omitted;
  const parts = [`loaded in ${counts.loaded} of ${total} ${total === 1 ? "session" : "sessions"}`];
  return `Saved; ${[...parts, ...countParts(counts, false)].join(", ")}`;
}

/** The line under the listed sessions, e.g. "…and 70 more: 64 loaded, 6 not tracked". */
export function omittedText(omitted: number, omittedStates?: OmittedStates): string {
  const hidden = omittedEntries(omitted, omittedStates);
  const parts = countParts(outcomeCounts(hidden.entries, hidden.untracked), true);
  return `…and ${omitted} more${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

function OperationCard({
  operation,
  applyBlockedReason,
}: {
  operation: McpOperationSnapshot;
  applyBlockedReason?: string;
}) {
  const { machine } = useAccountMachine();
  const [busy, setBusy] = useState(false);
  const saved = operation.phase === "saved";
  const runtimes = operation.apply.runtimes;
  // Unlisted sessions are still tracked, so their states offer actions too.
  const hidden = operation.apply.omittedStates ?? {};
  const waiting = runtimes.some((runtime) => runtime.state === "queued") || !!hidden.queued;
  // The file no longer holds this change, so the backend refuses to apply it
  // again; an older backend never sets the reason and keeps Retry. The backend
  // always lists a superseded session when it has one.
  const superseded = runtimes.some(
    (runtime) => runtime.state === "cancelled" && runtime.cancelReason !== undefined,
  );
  // Cancelling is always allowed; starting an apply is not while gated.
  const retryable =
    !applyBlockedReason &&
    saved &&
    !superseded &&
    (runtimes.some((runtime) => runtime.state === "failed" || runtime.state === "cancelled") ||
      !!hidden.failed ||
      !!hidden.cancelled ||
      (!runtimes.length && operation.apply.state === "failed"));
  const applicable =
    !applyBlockedReason &&
    saved &&
    operation.applyIntent === "save" &&
    operation.apply.state === "not-requested";
  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(`${failure}: ${mcpProblemText(mcpProblemFrom(error))}`);
    } finally {
      setBusy(false);
    }
  };
  const headline = !saved
    ? operation.phase === "conflict"
      ? "Not saved: the file changed elsewhere"
      : operation.phase === "pending" || operation.phase === "reconciling"
        ? "Saving…"
        : `Not saved${operation.message ? `: ${operation.message}` : ""}`
    : operation.applyIntent === "save" && !runtimes.length
      ? STATE_TEXT["not-requested"]
      : (partialOutcomeText(runtimes, operation.apply.omitted, operation.apply.omittedStates) ??
        (runtimes.length || operation.apply.state === "failed"
          ? STATE_TEXT[operation.apply.state]
          : "Saved; no running session uses it yet"));
  const loaded =
    saved &&
    (operation.apply.state === "applied" ||
      runtimes.some((runtime) => runtime.state === "applied"));
  const untracked = omittedEntries(
    operation.apply.omitted,
    operation.apply.omittedStates,
  ).untracked;
  return (
    <li className="rounded-md border border-white/10 bg-zinc-900/40 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-all font-medium text-foreground">
          {KIND_TEXT[operation.kind]} <span className="font-mono">{operation.entryName}</span>
        </span>
        <span className={cn("text-muted-foreground", saved && TONE[operation.apply.state])}>
          {headline}
        </span>
        <span className="ml-auto flex gap-1">
          {applicable ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={busy}
              onClick={() =>
                void run(
                  () => backend.applyMcpConfiguration(operation.operationId, machine),
                  "Could not apply",
                )
              }
            >
              Apply now
            </Button>
          ) : null}
          {retryable ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={busy}
              onClick={() =>
                void run(
                  () => backend.applyMcpConfiguration(operation.operationId, machine),
                  "Could not retry",
                )
              }
            >
              Retry apply
            </Button>
          ) : null}
          {waiting ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              disabled={busy}
              onClick={() =>
                void run(
                  () => backend.cancelMcpApply(operation.operationId, machine),
                  "Could not cancel",
                )
              }
            >
              Cancel apply
            </Button>
          ) : null}
        </span>
      </div>
      {saved && superseded ? (
        <p className="mt-1 text-muted-foreground">
          Nothing to retry: the file no longer holds this change. Open the server again to review
          it, or save the change again.
        </p>
      ) : null}
      {saved && operation.affectedEnvironments?.length ? (
        <p className="mt-1 break-words text-muted-foreground">
          Environments:{" "}
          {operation.affectedEnvironments.map((environment) => environment.name).join(", ")}
        </p>
      ) : null}
      {operation.message && saved ? (
        <p className="mt-1 text-muted-foreground">{operation.message}</p>
      ) : null}
      {runtimes.length ? (
        <ul
          className="mt-1.5 space-y-0.5"
          aria-label={`Sessions affected by ${operation.entryName}`}
        >
          {runtimes.map((runtime) => (
            <li key={runtime.runtimeId} className="flex flex-wrap gap-x-2 text-muted-foreground">
              <span className="text-foreground/80">{runtime.label}</span>
              <span className={TONE[runtime.state]}>{STATE_TEXT[runtime.state]}</span>
              {runtime.reason ? <span>— {runtime.reason}</span> : null}
              {runtime.savedRevision &&
              operation.savedRevision &&
              runtime.savedRevision !== operation.savedRevision ? (
                // The session has moved on to a different saved revision, so
                // this change's state no longer describes what it runs.
                <span>— now tracking a later saved change</span>
              ) : null}
            </li>
          ))}
          {operation.apply.omitted ? (
            <li className="text-muted-foreground">
              {omittedText(operation.apply.omitted, operation.apply.omittedStates)}
            </li>
          ) : null}
          {untracked ? (
            <li className="text-muted-foreground">
              Sessions not tracked were past what one apply follows. They were not scheduled; each
              reads the saved file the next time its provider loads its configuration.
            </li>
          ) : null}
        </ul>
      ) : null}
      {loaded ? (
        <p className="mt-1 text-muted-foreground">
          Loaded is not the same as connected: the agent's info panel shows each server's live
          connection and sign-in status.
        </p>
      ) : null}
      {saved && operation.apply.terminalGuidance && operation.applyIntent === "save-and-apply" ? (
        <p className="mt-1 text-muted-foreground">{operation.apply.terminalGuidance}</p>
      ) : null}
    </li>
  );
}

/** Recent operations for the selected target, rehydrated from the snapshot. */
export function McpApplyStatus({
  operations,
  applyBlockedReason,
}: {
  operations: McpOperationSnapshot[];
  /** Backend rollout gate: applying is switched off, so no apply is offered. */
  applyBlockedReason?: string;
}) {
  if (!operations.length) return null;
  return (
    <section aria-label="Recent changes" className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">Recent changes</h2>
      <ul className="space-y-2" aria-live="polite">
        {operations.slice(0, 8).map((operation) => (
          <OperationCard
            key={operation.operationId}
            operation={operation}
            applyBlockedReason={applyBlockedReason}
          />
        ))}
      </ul>
    </section>
  );
}
