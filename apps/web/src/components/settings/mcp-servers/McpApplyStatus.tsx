import { useState } from "react";
import { toast } from "sonner";

import type {
  McpApplyState,
  McpOperationSnapshot,
  McpRuntimeApplyEntry,
} from "@orkestrator/protocol/mcp-management";

import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
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
  "restart-required": "Saved; restart required to load it",
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

/**
 * Headline for an operation whose sessions ended up in different states, e.g.
 * "Saved; loaded in 2 of 3 sessions, 1 waiting". Null when every listed
 * session shares one state (the aggregate state already says it).
 */
export function partialOutcomeText(
  runtimes: readonly McpRuntimeApplyEntry[],
  omitted = 0,
): string | null {
  if (new Set(runtimes.map((runtime) => runtime.state)).size < 2) return null;
  const count = (match: (state: McpApplyState) => boolean) =>
    runtimes.filter((runtime) => match(runtime.state)).length;
  const loaded = count((state) => state === "applied");
  const waiting = count((state) => WAITING.has(state));
  const failed = count((state) => state === "failed");
  const other = runtimes.length - loaded - waiting - failed;
  const total = runtimes.length + omitted;
  const parts = [`loaded in ${loaded} of ${total} ${total === 1 ? "session" : "sessions"}`];
  if (waiting) parts.push(`${waiting} waiting`);
  if (failed) parts.push(`${failed} failed`);
  if (other) parts.push(`${other} need attention`);
  return `Saved; ${parts.join(", ")}`;
}

function OperationCard({
  operation,
  applyBlockedReason,
}: {
  operation: McpOperationSnapshot;
  applyBlockedReason?: string;
}) {
  const [busy, setBusy] = useState(false);
  const saved = operation.phase === "saved";
  const runtimes = operation.apply.runtimes;
  const waiting = runtimes.some((runtime) => runtime.state === "queued");
  // Cancelling is always allowed; starting an apply is not while gated.
  const retryable =
    !applyBlockedReason &&
    saved &&
    (runtimes.some((runtime) => runtime.state === "failed" || runtime.state === "cancelled") ||
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
      : (partialOutcomeText(runtimes, operation.apply.omitted) ??
        (runtimes.length || operation.apply.state === "failed"
          ? STATE_TEXT[operation.apply.state]
          : "Saved; no running session uses it yet"));
  const loaded =
    saved &&
    (operation.apply.state === "applied" ||
      runtimes.some((runtime) => runtime.state === "applied"));
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
                  () => backend.applyMcpConfiguration(operation.operationId),
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
                  () => backend.applyMcpConfiguration(operation.operationId),
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
                void run(() => backend.cancelMcpApply(operation.operationId), "Could not cancel")
              }
            >
              Cancel apply
            </Button>
          ) : null}
        </span>
      </div>
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
            <li className="text-muted-foreground">…and {operation.apply.omitted} more</li>
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
