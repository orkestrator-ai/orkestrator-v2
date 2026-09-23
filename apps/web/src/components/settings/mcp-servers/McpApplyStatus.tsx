import { useState } from "react";
import { toast } from "sonner";

import type { McpApplyState, McpOperationSnapshot } from "@orkestrator/protocol/mcp-management";

import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";

import { describeMcpError } from "./useMcpManagement";

const STATE_TEXT: Record<McpApplyState, string> = {
  "not-requested": "Saved; used when this provider next loads it",
  queued: "Saved; waiting for current work to finish",
  applying: "Saved; applying now",
  applied: "Saved and applied",
  "pending-next-turn": "Saved; loads on the next message",
  "pending-reattach": "Saved; loads when the session reconnects",
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

function OperationCard({ operation }: { operation: McpOperationSnapshot }) {
  const [busy, setBusy] = useState(false);
  const saved = operation.phase === "saved";
  const runtimes = operation.apply.runtimes;
  const waiting = runtimes.some((runtime) => runtime.state === "queued");
  const retryable =
    saved &&
    (runtimes.some((runtime) => runtime.state === "failed" || runtime.state === "cancelled") ||
      (!runtimes.length && operation.apply.state === "failed"));
  const applicable =
    saved && operation.applyIntent === "save" && operation.apply.state === "not-requested";
  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(`${failure}: ${describeMcpError(error)}`);
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
      : runtimes.length || operation.apply.state === "failed"
        ? STATE_TEXT[operation.apply.state]
        : "Saved; no running session uses it yet";
  return (
    <li className="rounded-md border border-white/10 bg-zinc-900/40 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">
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
            </li>
          ))}
          {operation.apply.omitted ? (
            <li className="text-muted-foreground">…and {operation.apply.omitted} more</li>
          ) : null}
        </ul>
      ) : null}
      {saved && operation.apply.terminalGuidance && operation.applyIntent === "save-and-apply" ? (
        <p className="mt-1 text-muted-foreground">{operation.apply.terminalGuidance}</p>
      ) : null}
    </li>
  );
}

/** Recent operations for the selected target, rehydrated from the snapshot. */
export function McpApplyStatus({ operations }: { operations: McpOperationSnapshot[] }) {
  if (!operations.length) return null;
  return (
    <section aria-label="Recent changes" className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">Recent changes</h2>
      <ul className="space-y-2" aria-live="polite">
        {operations.slice(0, 8).map((operation) => (
          <OperationCard key={operation.operationId} operation={operation} />
        ))}
      </ul>
    </section>
  );
}
