/**
 * What the goal pill and panel say. The rules for what a status means live in
 * `@orkestrator/protocol/native-agent-goal`; this is only their presentation.
 */
import {
  GOAL_TOKEN_BUDGET_PLATFORMS,
  goalIsRunning,
  NATIVE_AGENT_GOAL_LIMITS,
  parseGoalCommandArguments,
  type NativeAgentGoalStatus,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentComposerState,
  NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";

/** The pill's one word for each status; the panel says the rest. */
export const GOAL_STATUS_LABELS: Record<NativeAgentGoalStatus, string> = {
  active: "Running",
  checking: "Checking",
  verifying: "Verifying",
  paused: "Paused",
  blocked: "Blocked",
  limited: "At limit",
  claimed: "Unverified",
  complete: "Complete",
};

export function goalTokenBudgetAvailable(platform: AgentPlatform): boolean {
  return (GOAL_TOKEN_BUDGET_PLATFORMS as readonly AgentPlatform[]).includes(platform);
}

/**
 * The goal's clock: live while the loop runs, otherwise fixed at the last
 * change. Backend timestamps only, so a remount or reload never restarts it.
 */
export function goalClock(
  goal: Pick<NativeAgentGoalView, "status" | "setAt" | "updatedAt" | "endedAt">,
): { startedAt: number; running: true } | { seconds: number; running: false } | undefined {
  const startedAt = Date.parse(goal.setAt);
  if (!Number.isFinite(startedAt)) return undefined;
  if (goalIsRunning(goal.status)) return { startedAt, running: true };
  const stoppedAt = Date.parse(goal.endedAt ?? goal.updatedAt);
  if (!Number.isFinite(stoppedAt)) return undefined;
  return { seconds: Math.max(0, Math.floor((stoppedAt - startedAt) / 1000)), running: false };
}

/**
 * Why a goal in this session will stop and wait for a person, if it will. The
 * mode's own kind decides, so a provider's mode is judged by what it does rather
 * than by what its SDK calls it.
 */
export function goalApprovalWarning(input: {
  composer:
    | Pick<NativeAgentComposerState, "approvalModes" | "selectedApprovalModeId" | "selectedModeId">
    | undefined;
  policy: Pick<NativeAgentExecutionPolicy, "approvals"> | undefined;
  agentLabel: string;
}): string | undefined {
  const { composer, policy, agentLabel } = input;
  if (composer?.selectedModeId === "plan") {
    return `Plan mode stops for plan approval, so this goal will wait for you each time ${agentLabel} finishes a plan. A goal never changes the mode.`;
  }
  const mode = composer?.approvalModes?.find(
    (candidate) => candidate.id === composer.selectedApprovalModeId,
  );
  const stops = mode
    ? mode.kind === "ask" || mode.kind === "auto-edits"
    : policy?.approvals === "ask";
  if (!stops) return undefined;
  const named = mode ? `The ${mode.label} approval mode` : "This session's approval mode";
  return `${named} stops for approvals, so this goal will wait for you each time ${agentLabel} asks. A goal never changes the mode.`;
}

export interface GoalFormValues {
  objective: string;
  check: string;
  maxIterations: string;
  tokenBudget: string;
}

/**
 * The form's values as `/goal` arguments, so the form and the typed command are
 * one path. The result is parsed back: an objective that reads as a subcommand
 * or swallows a flag must not silently become something else.
 */
export function composeGoalCommand(values: GoalFormValues): { text: string } | { error: string } {
  const objective = values.objective.trim();
  if (!objective) return { error: "Describe the objective." };
  const check = values.check.trim();
  const budget = values.tokenBudget.trim();
  const text = [
    objective,
    `--max-iterations ${values.maxIterations.trim()}`.trimEnd(),
    ...(budget ? [`--budget ${budget}`] : []),
    ...(check ? [`--check ${check}`] : []),
  ].join(" ");
  const parsed = parseGoalCommandArguments(text);
  if (parsed.kind === "error") return { error: parsed.message };
  if (parsed.kind !== "set" || parsed.objective !== objective || (parsed.check ?? "") !== check) {
    return {
      error: "That objective reads as a /goal subcommand or flag. Reword it so it is plain text.",
    };
  }
  return { text };
}

/** What Resume must raise for a goal stopped at a limit, if anything. */
export type GoalLimitToRaise =
  | { flag: "--max-iterations"; label: string; suggested: number; max: number }
  | { flag: "--budget"; label: string; suggested: number };

export function goalLimitToRaise(goal: NativeAgentGoalView): GoalLimitToRaise | undefined {
  if (goal.status !== "limited") return undefined;
  if (goal.statusReason === "token-budget") {
    return {
      flag: "--budget",
      label: "New token budget",
      suggested: (goal.tokenBudget ?? 0) * 2 || 100_000,
    };
  }
  const max = NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit;
  return {
    flag: "--max-iterations",
    label: "New iteration limit",
    suggested: Math.min(max, goal.maxIterations + 10),
    max,
  };
}
