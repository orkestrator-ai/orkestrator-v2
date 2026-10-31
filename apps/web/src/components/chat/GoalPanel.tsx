import { useId, useRef, useState, type ReactNode } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  describeGoalStatus,
  goalIsRunning,
  goalIsTerminal,
  NATIVE_AGENT_GOAL_LIMITS,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { NativeAgentGoalDetail } from "@/lib/backend";
import {
  composeGoalCommand,
  goalLimitToRaise,
  goalTokenBudgetAvailable,
} from "@/lib/chat/goal-presentation";
import { formatElapsedWithHours } from "@/lib/format-elapsed";
import { GoalElapsed } from "./GoalPill";

export interface GoalPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal: NativeAgentGoalView | undefined;
  platform: AgentPlatform;
  agentLabel: string;
  /** Why this session will stop for a person during a goal, if it will. */
  approvalWarning?: string;
  /** The session's own approval control, offered beside the warning. */
  approvalControl?: ReactNode;
  /** Run `/goal` with these arguments. Rejects with a message the user can read. */
  onCommand: (text: string) => Promise<unknown>;
  loadDetail: () => Promise<NativeAgentGoalDetail>;
}

/**
 * See and control a session's goal without typing. Everything shown comes from
 * the session snapshot, except the check output, which loads on demand.
 */
export function GoalPanel({ open, onOpenChange, ...body }: GoalPanelProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" data-testid="goal-panel">
        {/* Unmounted on close, so a half-written form or a stale error goes with it. */}
        {open ? <GoalPanelBody {...body} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function GoalPanelBody({
  goal,
  platform,
  agentLabel,
  approvalWarning,
  approvalControl,
  onCommand,
  loadDetail,
  onClose,
}: Omit<GoalPanelProps, "open" | "onOpenChange"> & { onClose: () => void }) {
  const [replacing, setReplacing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);

  /** One command at a time; a refusal keeps the panel and what was typed in it. */
  const run = async (key: string, text: string, options: { close?: boolean } = {}) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(key);
    setError(null);
    try {
      await onCommand(text);
      if (options.close) onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const showForm = !goal || replacing;
  const warning = approvalWarning ? (
    <div
      role="note"
      data-testid="goal-approval-warning"
      className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/[0.05] p-2.5 text-xs"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden="true" />
      <p className="min-w-0 flex-1">{approvalWarning}</p>
      {approvalControl}
    </div>
  ) : null;
  const failure = error ? (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
    >
      {error}
    </p>
  ) : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{showForm ? "Set a goal" : "Goal"}</DialogTitle>
        <DialogDescription>
          {showForm
            ? `${agentLabel} keeps working across turns until a check proves the objective, it needs you, or a limit stops it.`
            : describeGoalStatus(goal)}
        </DialogDescription>
      </DialogHeader>
      <div className="flex max-h-[70vh] min-w-0 flex-col gap-3 overflow-y-auto pr-1">
        {warning}
        {showForm ? (
          <GoalForm
            platform={platform}
            pending={pending !== null}
            failure={failure}
            onCancel={replacing ? () => setReplacing(false) : undefined}
            onSubmit={(text) => void run("set", text, { close: true })}
          />
        ) : (
          <GoalDetails
            goal={goal}
            pending={pending}
            failure={failure}
            loadDetail={loadDetail}
            onRun={(key, text, options) => void run(key, text, options)}
            onReplace={() => {
              setError(null);
              setReplacing(true);
            }}
          />
        )}
      </div>
    </>
  );
}

function GoalForm({
  platform,
  pending,
  failure,
  onCancel,
  onSubmit,
}: {
  platform: AgentPlatform;
  pending: boolean;
  failure: ReactNode;
  onCancel?: () => void;
  onSubmit: (text: string) => void;
}) {
  const fieldId = useId();
  const [objective, setObjective] = useState("");
  const [check, setCheck] = useState("");
  const [maxIterations, setMaxIterations] = useState(
    String(NATIVE_AGENT_GOAL_LIMITS.maxIterationsDefault),
  );
  const [tokenBudget, setTokenBudget] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const budgetAvailable = goalTokenBudgetAvailable(platform);
  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const composed = composeGoalCommand({
          objective,
          check,
          maxIterations,
          tokenBudget: budgetAvailable ? tokenBudget : "",
        });
        if ("error" in composed) {
          setProblem(composed.error);
          return;
        }
        setProblem(null);
        onSubmit(composed.text);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${fieldId}-objective`}>Objective</Label>
        <Textarea
          id={`${fieldId}-objective`}
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          maxLength={NATIVE_AGENT_GOAL_LIMITS.objectiveMaxChars}
          placeholder="What should be true when this is finished?"
          className="max-h-48"
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${fieldId}-check`}>Check command</Label>
        <Input
          id={`${fieldId}-check`}
          value={check}
          onChange={(event) => setCheck(event.target.value)}
          placeholder="bun test"
          spellCheck={false}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground" data-testid="goal-check-note">
          {check.trim()
            ? "The goal completes when this exits with 0, and proves only what it runs."
            : "With no check, the goal ends as unverified when the agent says it is done."}{" "}
          Checks may run more than once, so use a command that is safe to repeat.
        </p>
      </div>
      <div className="grid gap-3 @sm:grid-cols-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${fieldId}-iterations`}>Iteration limit</Label>
          <Input
            id={`${fieldId}-iterations`}
            type="number"
            inputMode="numeric"
            min={1}
            max={NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit}
            value={maxIterations}
            onChange={(event) => setMaxIterations(event.target.value)}
          />
        </div>
        {budgetAvailable ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${fieldId}-budget`}>Token budget (optional)</Label>
            <Input
              id={`${fieldId}-budget`}
              type="number"
              inputMode="numeric"
              min={1}
              value={tokenBudget}
              onChange={(event) => setTokenBudget(event.target.value)}
            />
          </div>
        ) : null}
      </div>
      {problem ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
        >
          {problem}
        </p>
      ) : null}
      {failure}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={pending || !objective.trim()}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          Set goal
        </Button>
      </div>
    </form>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function tokensText(goal: NativeAgentGoalView): string {
  const used = goal.tokensUsed?.toLocaleString();
  if (goal.tokenBudget !== undefined) {
    return `${used ?? "0"} of ${goal.tokenBudget.toLocaleString()}`;
  }
  return used ?? "Not reported yet";
}

function GoalDetails({
  goal,
  pending,
  failure,
  loadDetail,
  onRun,
  onReplace,
}: {
  goal: NativeAgentGoalView;
  pending: string | null;
  failure: ReactNode;
  loadDetail: () => Promise<NativeAgentGoalDetail>;
  onRun: (key: string, text: string, options?: { close?: boolean }) => void;
  onReplace: () => void;
}) {
  const running = goalIsRunning(goal.status);
  const canResume = !running && !goalIsTerminal(goal.status);
  const limit = goalLimitToRaise(goal);
  const [raised, setRaised] = useState(limit ? String(limit.suggested) : "");
  const limitId = useId();
  const atLargestLimit = limit?.flag === "--max-iterations" && goal.maxIterations >= limit.max;
  const busy = pending !== null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <dl className="flex min-w-0 flex-col gap-2.5">
        <Fact label="Objective">
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap">{goal.objective}</p>
        </Fact>
        <Fact label="Check">
          {goal.check ? (
            <code className="font-mono text-xs">{goal.check}</code>
          ) : (
            <span className="text-muted-foreground">
              {goal.verifier
                ? "None."
                : "None. The goal will end as unverified when the agent says it is done."}
            </span>
          )}
        </Fact>
        {goal.verifier ? (
          <Fact label="Verifier">
            {goal.verifier.agent}
            {goal.verifier.model ? ` (${goal.verifier.model})` : ""}
            {goal.lastVerdict ? (
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {goal.lastVerdict.passed ? "Passed: " : "Failed: "}
                {goal.lastVerdict.summary}
              </p>
            ) : null}
          </Fact>
        ) : null}
        <Fact label="Turns">
          {goal.iterations} of {goal.maxIterations}
        </Fact>
        <Fact label="Time">
          <GoalElapsed goal={goal} className="tabular-nums" />
        </Fact>
        <Fact label="Tokens">{tokensText(goal)}</Fact>
        {goal.lastReport ? (
          <Fact label="Last report">
            <span className="text-xs text-muted-foreground">
              The agent reported {goal.lastReport.status}:
            </span>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap">
              {goal.lastReport.message}
            </p>
          </Fact>
        ) : null}
        {goal.lastCheck ? (
          <Fact label="Last check">
            {/* A newer run starts closed: its output is not the one on screen. */}
            <GoalCheckResult key={goal.lastCheck.at} check={goal.lastCheck} load={loadDetail} />
          </Fact>
        ) : null}
      </dl>
      {limit && !atLargestLimit ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={limitId}>{limit.label}</Label>
          <Input
            id={limitId}
            type="number"
            inputMode="numeric"
            min={1}
            max={limit.flag === "--max-iterations" ? limit.max : undefined}
            value={raised}
            onChange={(event) => setRaised(event.target.value)}
          />
        </div>
      ) : null}
      {atLargestLimit ? (
        <p className="text-xs text-muted-foreground">
          This goal is at the largest iteration limit, so it can't resume. Set a new goal instead.
        </p>
      ) : null}
      {failure}
      <div className="flex flex-wrap justify-end gap-2">
        {!running ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onReplace}>
            Set a new goal
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          className="text-destructive hover:text-destructive"
          onClick={() => onRun("clear", "clear", { close: true })}
        >
          Clear
        </Button>
        {running ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onRun("pause", "pause")}
          >
            Pause
          </Button>
        ) : null}
        {canResume ? (
          <Button
            type="button"
            size="sm"
            disabled={busy || atLargestLimit}
            onClick={() =>
              onRun("resume", limit ? `resume ${limit.flag} ${raised.trim()}`.trimEnd() : "resume")
            }
          >
            Resume
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function checkResultText(check: NonNullable<NativeAgentGoalView["lastCheck"]>): string {
  const outcome = check.passed
    ? "Passed"
    : check.timedOut
      ? "Timed out"
      : check.exitCode === null
        ? "Failed"
        : `Failed with exit code ${check.exitCode}`;
  return `${outcome} in ${formatElapsedWithHours(Math.round(check.durationMs / 1000))}`;
}

function GoalCheckResult({
  check,
  load,
}: {
  check: NonNullable<NativeAgentGoalView["lastCheck"]>;
  load: () => Promise<NativeAgentGoalDetail>;
}) {
  const [output, setOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const show = async () => {
    setLoading(true);
    setProblem(null);
    try {
      const detail = await load();
      const latest = detail.goal?.lastCheck;
      if (latest?.at === check.at) setOutput(latest.outputTail);
      else setProblem("This output is no longer available.");
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span>{checkResultText(check)}</span>
        {output === null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={loading}
            onClick={() => void show()}
          >
            {loading ? "Loading…" : "Show output"}
          </Button>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      {output !== null ? (
        <pre
          data-testid="goal-check-output"
          className="max-h-64 overflow-auto rounded border border-border/60 bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-words"
        >
          {output || "(no output)"}
        </pre>
      ) : null}
    </div>
  );
}
