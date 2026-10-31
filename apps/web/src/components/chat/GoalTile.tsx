import { memo, useContext, useEffect, useId, useState } from "react";
import { ChevronRight, CircleAlert, CircleCheck, CircleX, Goal, Info } from "lucide-react";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import type {
  GoalStatusPresentation,
  GoalStatusRowTone,
  GoalTurnPresentation,
} from "@/lib/chat/native-message-types";
import { cn } from "@/lib/utils";
import { ChatFindActiveContext } from "./chat-find-context";
import { GoalDetailLoaderContext } from "./goal-detail-context";

function goalTurnLabel(turn: GoalTurnPresentation): string {
  if (turn.iteration === undefined) return "Goal turn";
  const number = turn.iteration + 1;
  return turn.maxIterations === undefined
    ? `Goal turn ${number}`
    : `Goal turn ${number} of ${turn.maxIterations}`;
}

function failedCheckLabel(check: NonNullable<GoalTurnPresentation["failedCheck"]>): string {
  if (check.timedOut) return "Check timed out";
  return check.exitCode === null ? "Check failed" : `Check failed, exit ${check.exitCode}`;
}

/**
 * One turn the goal loop sent, as a collapsed tile. D12: a continuation is never
 * a user bubble, and twenty of them must not take over the transcript, so it
 * shows one line until the reader opens it.
 *
 * The objective and the check output are shown as plain text: this is not a
 * message to read as Markdown, and the output is untrusted.
 */
export const GoalTurnTile = memo(function GoalTurnTile({
  turn,
  expansionKey,
  timestampLabel,
}: {
  turn: GoalTurnPresentation;
  expansionKey: string;
  timestampLabel?: string;
}) {
  const [preferredOpen, setOpen] = useMessagePartExpansion(expansionKey);
  const findActive = useContext(ChatFindActiveContext);
  const open = preferredOpen || findActive;
  const bodyId = useId();
  const failedCheck = turn.failedCheck;
  return (
    <div
      className="px-2 py-1 @sm:px-4"
      data-goal-turn-tile="true"
      data-expanded={open ? "true" : "false"}
    >
      <div className="mx-auto min-w-0 max-w-3xl rounded-lg border border-border/60 bg-muted/20">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Goal className="size-3.5 shrink-0 text-sky-300" aria-hidden="true" />
          <span className="shrink-0 text-xs font-medium text-foreground/80">
            {goalTurnLabel(turn)}
          </span>
          {turn.objective && !open ? (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {turn.objective}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {failedCheck || turn.failedVerdict ? (
            <span className="shrink-0 rounded bg-red-400/10 px-1.5 text-[10px] leading-4 text-red-300">
              {failedCheck ? failedCheckLabel(failedCheck) : "Verifier failed"}
            </span>
          ) : null}
          {timestampLabel ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {timestampLabel}
            </span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </button>
        {open ? (
          <div id={bodyId} className="space-y-2 px-3 pb-2.5 pl-[2.125rem] text-xs">
            {turn.objective ? (
              <p
                data-agent-chat-search-content="true"
                className="whitespace-pre-wrap break-words text-foreground/85"
              >
                {turn.objective}
              </p>
            ) : (
              <p className="text-muted-foreground">
                Orkestrator sent this turn to continue a goal.
              </p>
            )}
            {turn.check ? (
              <p className="break-words text-muted-foreground">
                Check: <code className="font-mono">{turn.check}</code>
              </p>
            ) : null}
            {turn.failedVerdict ? (
              <p className="break-words whitespace-pre-wrap text-muted-foreground">
                The verifier said: {turn.failedVerdict}
              </p>
            ) : null}
            {failedCheck ? (
              <div className="space-y-1">
                <p className="text-muted-foreground">
                  The last check&apos;s output, sent to the agent as evidence:
                </p>
                <pre className="max-h-64 overflow-auto rounded border border-border/60 bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-words">
                  {failedCheck.outputTail || "(no output)"}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

const STATUS_TONES: Record<
  GoalStatusRowTone,
  { icon: typeof Info; className: string; label: string }
> = {
  neutral: { icon: Info, className: "text-muted-foreground", label: "Goal" },
  success: { icon: CircleCheck, className: "text-emerald-400", label: "Goal passed" },
  failure: { icon: CircleX, className: "text-red-400", label: "Goal check failed" },
  attention: { icon: CircleAlert, className: "text-amber-400", label: "Goal needs attention" },
};

type CheckOutput =
  | { state: "idle" | "loading" }
  | { state: "loaded"; output: string }
  | { state: "gone" }
  | { state: "failed"; message: string };

/** Reads one check's output when its row opens. A newer run has replaced an older one's. */
function useCheckOutput(checkAt: string | undefined, open: boolean): CheckOutput {
  const load = useContext(GoalDetailLoaderContext);
  const [result, setResult] = useState<{ checkAt: string; output: CheckOutput } | null>(null);
  const current = result && result.checkAt === checkAt ? result.output : null;
  const pending = open && Boolean(load) && checkAt !== undefined && current === null;
  useEffect(() => {
    if (!pending || !load || checkAt === undefined) return;
    let cancelled = false;
    void load()
      .then((detail): CheckOutput => {
        const check = detail.goal?.lastCheck;
        return check && check.at === checkAt
          ? { state: "loaded", output: check.outputTail }
          : { state: "gone" };
      })
      .catch((error: unknown): CheckOutput => ({
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      }))
      .then((output) => {
        if (!cancelled) setResult({ checkAt, output });
      });
    return () => {
      cancelled = true;
    };
  }, [checkAt, load, pending]);
  if (current) return current;
  return pending ? { state: "loading" } : { state: "idle" };
}

/**
 * A short goal status row. Derived from the session snapshot, not a transcript
 * row. Its text can hold a turn's error or the agent's words, so it stays text.
 */
export const GoalStatusRow = memo(function GoalStatusRow({
  status,
  text,
  expansionKey,
  timestampLabel,
}: {
  status: GoalStatusPresentation;
  text: string;
  expansionKey: string;
  timestampLabel?: string;
}) {
  const expandable = status.checkAt !== undefined;
  const [open, setOpen] = useMessagePartExpansion(expansionKey);
  const output = useCheckOutput(status.checkAt, expandable && open);
  const tone = STATUS_TONES[status.tone];
  const Icon = tone.icon;
  const content = (
    <>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone.className)} aria-hidden="true" />
      <span className="sr-only">{tone.label}: </span>
      <span
        data-agent-chat-search-content="true"
        className="min-w-0 break-words whitespace-pre-line"
      >
        {text}
      </span>
      {timestampLabel ? (
        <span className="mt-px shrink-0 text-[10px] tabular-nums">{timestampLabel}</span>
      ) : null}
    </>
  );
  return (
    <div
      className="px-2 py-1 @sm:px-4"
      data-goal-status-row={status.kind}
      data-goal-status-tone={status.tone}
    >
      <div className="mx-auto min-w-0 max-w-3xl text-xs text-muted-foreground">
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="mx-auto flex max-w-full min-w-0 items-start gap-1.5 rounded px-1 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {content}
            <ChevronRight
              aria-hidden="true"
              className={cn("mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-90")}
            />
          </button>
        ) : (
          <div className="mx-auto flex w-fit max-w-full min-w-0 items-start gap-1.5 px-1">
            {content}
          </div>
        )}
        {expandable && open ? (
          <div className="mt-1" data-goal-check-output={output.state}>
            {output.state === "loaded" ? (
              <pre className="max-h-64 overflow-auto rounded border border-border/60 bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-words">
                {output.output || "(no output)"}
              </pre>
            ) : (
              <p className="text-center" role={output.state === "failed" ? "alert" : undefined}>
                {output.state === "failed"
                  ? `Couldn't read the output: ${output.message}`
                  : output.state === "gone"
                    ? "This output is no longer available."
                    : "Loading the output…"}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
});
