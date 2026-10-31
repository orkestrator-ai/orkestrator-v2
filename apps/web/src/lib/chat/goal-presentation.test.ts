import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { describe, expect, test } from "bun:test";
import { parseGoalCommandArguments } from "@orkestrator/protocol/native-agent-goal";
import { nativeAgentApprovalModes } from "@orkestrator/protocol/native-agent";
import {
  composeGoalCommand,
  goalApprovalWarning,
  goalClock,
  goalLimitToRaise,
  goalTokenBudgetAvailable,
} from "./goal-presentation";

const FORM = { objective: "Ship it", check: "", maxIterations: "20", tokenBudget: "" };

describe("composeGoalCommand", () => {
  test("the form and the typed command are one path", () => {
    const composed = composeGoalCommand({
      objective: "  Fix login\nand logout  ",
      check: "bun test --grep 'a b'",
      maxIterations: "30",
      tokenBudget: "5000",
    });
    expect("text" in composed).toBe(true);
    expect(parseGoalCommandArguments((composed as { text: string }).text)).toEqual({
      kind: "set",
      objective: "Fix login\nand logout",
      check: "bun test --grep 'a b'",
      maxIterations: 30,
      tokenBudget: 5000,
    });
  });

  test("refuses what it cannot state, with the parser's own words", () => {
    expect(composeGoalCommand({ ...FORM, objective: "   " })).toEqual({
      error: "Describe the objective.",
    });
    expect(composeGoalCommand({ ...FORM, maxIterations: "" })).toEqual({
      error: "--max-iterations takes a positive whole number.",
    });
    expect(composeGoalCommand({ ...FORM, maxIterations: "500" })).toEqual({
      error: "--max-iterations can be at most 100.",
    });
  });

  test("an objective that reads as a subcommand or flag is never silently changed", () => {
    for (const objective of ["resume", "run it --check rm -rf /", "fix --budget 5"]) {
      const composed = composeGoalCommand({ ...FORM, objective });
      expect(composed).toEqual({
        error: "That objective reads as a /goal subcommand or flag. Reword it so it is plain text.",
      });
    }
    // Words that only look like subcommands inside an objective are fine.
    expect("text" in composeGoalCommand({ ...FORM, objective: "pause the rollout" })).toBe(true);
    expect("text" in composeGoalCommand({ ...FORM, objective: "pause" })).toBe(true);
  });
});

describe("goalApprovalWarning", () => {
  const modes = nativeAgentApprovalModes("claude", { approvals: "auto-approve" });
  const warning = (
    selectedApprovalModeId: string | undefined,
    selectedModeId: "build" | "plan" = "build",
  ) =>
    goalApprovalWarning({
      composer: { approvalModes: modes, selectedApprovalModeId, selectedModeId },
      policy: undefined,
      agentLabel: "Claude",
    });

  test("modes that stop for a person warn, and say a goal never changes them", () => {
    expect(warning("default")).toBe(
      "The Ask approval mode stops for approvals, so this goal will wait for you each time Claude asks. A goal never changes the mode.",
    );
    expect(warning("acceptEdits")).toContain("Accept edits");
  });

  test("modes that do not stop for a person say nothing", () => {
    expect(warning("bypassPermissions")).toBeUndefined();
    expect(warning("auto")).toBeUndefined();
  });

  test("plan mode stops for plan approval whatever the approval mode", () => {
    expect(warning("bypassPermissions", "plan")).toContain("Plan mode stops for plan approval");
  });

  test("a provider with no mode list falls back to the session's policy", () => {
    expect(
      goalApprovalWarning({
        composer: undefined,
        policy: { approvals: "ask" },
        agentLabel: "Pi",
      }),
    ).toContain("This session's approval mode");
    expect(
      goalApprovalWarning({
        composer: undefined,
        policy: { approvals: "auto-approve" },
        agentLabel: "Pi",
      }),
    ).toBeUndefined();
  });
});

describe("goalClock", () => {
  const setAt = "2026-10-31T10:00:00.000Z";

  test("runs from the backend's own clock while the loop runs", () => {
    for (const status of ["active", "checking", "verifying"] as const) {
      expect(goalClock({ status, setAt, updatedAt: setAt })).toEqual({
        startedAt: Date.parse(setAt),
        running: true,
      });
    }
  });

  test("stops at the last change, or the end", () => {
    expect(goalClock({ status: "paused", setAt, updatedAt: "2026-10-31T10:01:30.000Z" })).toEqual({
      seconds: 90,
      running: false,
    });
    expect(
      goalClock({
        status: "complete",
        setAt,
        updatedAt: "2026-10-31T11:00:00.000Z",
        endedAt: "2026-10-31T10:00:10.000Z",
      }),
    ).toEqual({ seconds: 10, running: false });
  });

  test("an unreadable clock shows nothing rather than a guess", () => {
    expect(goalClock({ status: "active", setAt: "nope", updatedAt: "nope" })).toBeUndefined();
  });
});

test("goalLimitToRaise names the limit that stopped the goal", () => {
  const goal = {
    goalId: "g",
    objective: "o",
    iterations: 20,
    maxIterations: 20,
    noProgressStreak: 0,
    setAt: "",
    updatedAt: "",
  };
  expect(goalLimitToRaise({ ...goal, status: "paused" })).toBeUndefined();
  expect(
    goalLimitToRaise({ ...goal, status: "limited", statusReason: "iteration-cap" }),
  ).toMatchObject({ flag: "--max-iterations", suggested: 30, max: 100 });
  expect(
    goalLimitToRaise({
      ...goal,
      status: "limited",
      statusReason: "token-budget",
      tokenBudget: 1000,
    }),
  ).toMatchObject({ flag: "--budget", suggested: 2000 });
});

test("a token budget is offered only where usage can back it", () => {
  expect(goalTokenBudgetAvailable("claude")).toBe(true);
  expect(goalTokenBudgetAvailable("codex")).toBe(true);
  expect(goalTokenBudgetAvailable("pi")).toBe(true);
  expect(goalTokenBudgetAvailable("unknown" as AgentPlatform)).toBe(false);
});
