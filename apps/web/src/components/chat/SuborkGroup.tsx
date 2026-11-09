import { memo, useContext, useId, useState } from "react";
import { Bot, ChevronRight, ChevronUp, Square } from "lucide-react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  suborkGroupTitle,
  suborkStatusSummary,
  type NativeAgentSuborkBatchView,
  type NativeAgentSuborkView,
  type SuborkStatus,
} from "@orkestrator/protocol/suborks";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import { formatElapsedWithHours } from "@/lib/format-elapsed";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import { cn } from "@/lib/utils";
import { SuborkGroupActionsContext } from "./subork-context";

const STATUS_DOT: Record<SuborkStatus, string> = {
  starting: "bg-blue-500",
  running: "bg-blue-500",
  finished: "bg-emerald-500",
  failed: "bg-red-500",
  stopped: "bg-muted-foreground",
};

const STATUS_LABEL: Record<SuborkStatus, string> = {
  starting: "Starting",
  running: "Running",
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

function isWorking(status: SuborkStatus): boolean {
  return status === "starting" || status === "running";
}

/** The clock as its own component: only this re-renders each second of a call. */
function SuborkElapsed({ startedAt, endedAt }: { startedAt?: string; endedAt?: string }) {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const running = Number.isFinite(startedMs) && !endedAt;
  const { elapsedSeconds } = useElapsedTimer(running, undefined, running ? startedMs : undefined);
  if (!Number.isFinite(startedMs)) return null;
  const seconds = endedAt
    ? Math.max(0, Math.round((Date.parse(endedAt) - startedMs) / 1000))
    : elapsedSeconds;
  if (seconds === null || seconds === undefined) return null;
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {formatElapsedWithHours(seconds)}
    </span>
  );
}

function ProviderMark({ agent, className }: { agent?: AgentPlatform; className?: string }) {
  return agent ? (
    <AgentPlatformIcon platform={agent} accent className={className} />
  ) : (
    <Bot className={cn("text-muted-foreground", className)} aria-hidden="true" />
  );
}

/** The line under a row's name: what it is doing, what it said, or why it failed. */
function rowLine(subork: NativeAgentSuborkView): string {
  if (subork.line) return subork.line;
  return STATUS_LABEL[subork.status];
}

function SuborkRow({ subork, onOpen }: { subork: NativeAgentSuborkView; onOpen?: () => void }) {
  const line = rowLine(subork);
  const model = subork.modelLabel ?? subork.model;
  const label = `${subork.name}${model && !subork.name.includes(model) ? `, ${model}` : ""}. ${STATUS_LABEL[subork.status]}: ${line}. Open its transcript.`;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        title={line}
        data-subork-status={subork.status}
        className="group/subork flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-hairline"
      >
        <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted/70">
          <ProviderMark agent={subork.agent} className="size-4" />
          <span
            aria-hidden="true"
            className={cn(
              "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background",
              STATUS_DOT[subork.status],
              isWorking(subork.status) && "motion-safe:animate-pulse",
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">
            {subork.name}
          </span>
          <span className="block truncate text-[13px] text-muted-foreground">{line}</span>
        </span>
        <SuborkElapsed startedAt={subork.startedAt} endedAt={subork.endedAt} />
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-colors group-hover/subork:text-foreground"
        />
      </button>
    </li>
  );
}

function deliveryNote(batch: NativeAgentSuborkBatchView): string | undefined {
  if (batch.delivery === "stored") {
    return "The answers are in this tab's inbox. Its delivery is off, so they did not wake the agent.";
  }
  if (batch.delivery === "failed") {
    return `The answers could not be delivered to the agent${batch.deliveryDetail ? `: ${batch.deliveryDetail}` : "."}`;
  }
  return undefined;
}

/**
 * One `ask_agents` call in the caller's transcript: a header with the group's
 * providers, counts and clock, and a row per subork naming it with one line of
 * its latest action. Everything here comes from the session snapshot, so it
 * survives a reload, and a row opens that subork's transcript.
 */
export const SuborkGroup = memo(function SuborkGroup({
  batch,
  expansionKey,
}: {
  batch: NativeAgentSuborkBatchView;
  expansionKey: string;
}) {
  const [collapsed, setCollapsed] = useMessagePartExpansion(expansionKey);
  const actions = useContext(SuborkGroupActionsContext);
  const panelId = useId();
  const [stopError, setStopError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const { suborks } = batch;
  const running = batch.status === "running";
  const note = deliveryNote(batch);
  const stop = () => {
    if (!actions) return;
    setStopping(true);
    setStopError(undefined);
    void Promise.resolve()
      .then(() => actions.stop(batch.id))
      .catch(() => setStopError("Could not stop these suborks. Try again."))
      .finally(() => setStopping(false));
  };
  return (
    <div className="px-2 py-1 @sm:px-4" data-subork-group="true" data-status={batch.status}>
      <div data-transcript-item="subork-group" className="mx-auto min-w-0 max-w-3xl rounded-lg">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={panelId}
            onClick={() => setCollapsed(!collapsed)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-hairline"
          >
            <span aria-hidden="true" className="flex shrink-0 items-center">
              {suborks.slice(0, 3).map((subork, index) => (
                <span
                  key={subork.id}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full bg-muted ring-2 ring-background",
                    index > 0 && "-ml-2",
                  )}
                >
                  <ProviderMark agent={subork.agent} className="size-3.5" />
                </span>
              ))}
              {suborks.length > 3 ? (
                <span className="ml-1 text-xs text-muted-foreground">+{suborks.length - 3}</span>
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                {suborkGroupTitle(suborks.length)}
              </span>
              <span aria-live="polite" className="block break-words text-xs text-blue-400">
                {suborkStatusSummary(suborks)}
              </span>
            </span>
            <SuborkElapsed
              startedAt={batch.createdAt}
              {...(batch.settledAt ? { endedAt: batch.settledAt } : {})}
            />
            <ChevronUp
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                collapsed && "rotate-180",
              )}
            />
          </button>
          {running && actions ? (
            <button
              type="button"
              aria-label="Stop these suborks"
              title="Stop these suborks"
              disabled={stopping}
              onClick={stop}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-hairline disabled:opacity-50"
            >
              <Square className="size-3 fill-current" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {collapsed ? null : (
          <ul
            id={panelId}
            aria-label={suborkGroupTitle(suborks.length)}
            className="mt-1 rounded-xl border border-border/60 bg-card/30 p-1"
          >
            {suborks.map((subork) => (
              <SuborkRow
                key={subork.id}
                subork={subork}
                {...(actions ? { onOpen: () => actions.openTranscript(batch.id, subork.id) } : {})}
              />
            ))}
          </ul>
        )}
        {stopError ? (
          <p role="alert" className="mt-1 px-1 text-xs text-destructive">
            {stopError}
          </p>
        ) : null}
        {note ? <p className="mt-1 px-1 text-xs text-amber-300">{note}</p> : null}
      </div>
    </div>
  );
});
