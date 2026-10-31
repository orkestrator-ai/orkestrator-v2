import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  describeGoalStatus,
  NATIVE_AGENT_GOAL_STATUSES,
  type NativeAgentGoal,
  type NativeAgentGoalCheckResult,
  type NativeAgentGoalStatus,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import { GoalPanel, type GoalPanelProps } from "./GoalPanel";
import { GoalPill } from "./GoalPill";

const SET_AT = "2026-10-31T10:00:00.000Z";

const STOP_FIELDS: Partial<Record<NativeAgentGoalStatus, Partial<NativeAgentGoalView>>> = {
  paused: { statusReason: "turn-failed", statusDetail: "rate limited" },
  blocked: { statusReason: "agent-blocked", statusDetail: "needs a key" },
  limited: { statusReason: "iteration-cap" },
  claimed: { statusReason: "agent-claimed", endedAt: "2026-10-31T10:01:00.000Z" },
  complete: { statusReason: "check-passed", endedAt: "2026-10-31T10:01:00.000Z" },
};

function goal(
  status: NativeAgentGoalStatus = "active",
  overrides: Partial<NativeAgentGoalView> = {},
): NativeAgentGoalView {
  return {
    goalId: "goal-1",
    objective: "Make the build green",
    status,
    iterations: 3,
    maxIterations: 20,
    noProgressStreak: 0,
    setAt: SET_AT,
    updatedAt: "2026-10-31T10:00:30.000Z",
    ...STOP_FIELDS[status],
    ...overrides,
  };
}

const onCommand = mock(async (_text: string) => undefined as unknown);
/** A detail read holding one check, with only the fields the panel looks at. */
function detailWith(lastCheck: NativeAgentGoalCheckResult) {
  return { goal: { lastCheck } as NativeAgentGoal, history: [] };
}

const loadDetail = mock(
  async () => ({ history: [] }) as Awaited<ReturnType<GoalPanelProps["loadDetail"]>>,
);
const onOpenChange = mock((_open: boolean) => {});

function renderPanel(overrides: Partial<GoalPanelProps> = {}) {
  return render(
    <GoalPanel
      open
      onOpenChange={onOpenChange}
      goal={undefined}
      platform="claude"
      agentLabel="Claude"
      onCommand={onCommand}
      loadDetail={loadDetail}
      {...overrides}
    />,
  );
}

function button(name: string) {
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  onCommand.mockReset();
  onCommand.mockImplementation(async () => undefined);
  loadDetail.mockReset();
  loadDetail.mockImplementation(async () => ({ history: [] }));
  onOpenChange.mockClear();
});

afterEach(cleanup);

describe("GoalPill", () => {
  test.each([...NATIVE_AGENT_GOAL_STATUSES])("shows %s with its progress", (status) => {
    const onOpen = mock(() => {});
    render(<GoalPill goal={goal(status)} onOpen={onOpen} />);
    const pill = screen.getByTestId("goal-pill");
    expect(pill.dataset.goalStatus).toBe(status);
    expect(pill.textContent).toContain("3/20");
    expect(pill.getAttribute("title")).toBe(describeGoalStatus(goal(status)));
    fireEvent.click(pill);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("a stopped goal's clock is fixed at its last change", () => {
    render(<GoalPill goal={goal("paused")} onOpen={() => {}} />);
    expect(screen.getByTestId("goal-pill").textContent).toContain("30s");
  });

  test("a running goal's clock comes from when it was set, so a reload does not restart it", () => {
    const startedLongAgo = new Date(Date.now() - 3_700_000).toISOString();
    render(<GoalPill goal={goal("active", { setAt: startedLongAgo })} onOpen={() => {}} />);
    expect(screen.getByTestId("goal-pill").textContent).toContain("1h 1m");
  });

  test("the numbers survive a narrow composer; the objective gives way first", () => {
    render(<GoalPill goal={goal()} onOpen={() => {}} />);
    const pill = screen.getByTestId("goal-pill");
    expect(pill.className).toContain("min-w-0");
    const objective = screen.getByText("Make the build green");
    expect(objective.className).toContain("hidden");
    expect(objective.className).toContain("@lg:inline");
    expect(screen.getByText("3/20").className).toContain("shrink-0");
  });
});

describe("GoalPanel controls per status", () => {
  const expected: Record<NativeAgentGoalStatus, string[]> = {
    active: ["Clear", "Pause"],
    checking: ["Clear", "Pause"],
    verifying: ["Clear", "Pause"],
    paused: ["Set a new goal", "Clear", "Resume"],
    blocked: ["Set a new goal", "Clear", "Resume"],
    limited: ["Set a new goal", "Clear", "Resume"],
    claimed: ["Set a new goal", "Clear"],
    complete: ["Set a new goal", "Clear"],
  };

  test.each([...NATIVE_AGENT_GOAL_STATUSES])("%s offers only what applies", (status) => {
    renderPanel({ goal: goal(status) });
    expect(screen.getByText(describeGoalStatus(goal(status)))).toBeTruthy();
    for (const name of ["Pause", "Resume", "Clear", "Set a new goal"]) {
      expect(screen.queryByRole("button", { name }) !== null).toBe(expected[status].includes(name));
    }
  });

  test.each([
    ["paused because a turn failed", "turn-failed", "a turn failed"],
    ["paused by its own limit of no progress", "no-progress", "several turns changed nothing"],
    ["paused by a stopped environment", "environment-stopped", "the environment stopped"],
    ["paused by a replaced session", "session-replaced", "a different conversation"],
    ["paused when the check could not run", "check-unavailable", "the check could not run"],
  ] as const)("%s says why", (_name, statusReason, text) => {
    renderPanel({ goal: goal("paused", { statusReason, statusDetail: undefined }) });
    expect(screen.getByRole("dialog").textContent).toContain(text);
  });

  test("Pause, Resume and Clear run the matching command", async () => {
    const { unmount } = renderPanel({ goal: goal("active") });
    fireEvent.click(button("Pause"));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith("pause"));
    unmount();

    const paused = renderPanel({ goal: goal("paused") });
    fireEvent.click(button("Resume"));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith("resume"));
    paused.unmount();

    renderPanel({ goal: goal("paused") });
    fireEvent.click(button("Clear"));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith("clear"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test("a refusal is shown, and the panel stays open", async () => {
    onCommand.mockImplementation(async () => {
      throw new Error("No running goal to pause.");
    });
    renderPanel({ goal: goal("active") });
    fireEvent.click(button("Pause"));
    expect((await screen.findByRole("alert")).textContent).toBe("No running goal to pause.");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("Resume at a limit raises that limit", async () => {
    renderPanel({ goal: goal("limited") });
    fireEvent.change(screen.getByLabelText("New iteration limit"), { target: { value: "45" } });
    fireEvent.click(button("Resume"));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith("resume --max-iterations 45"));
  });

  test("Resume at a token budget raises the budget", async () => {
    renderPanel({
      goal: goal("limited", { statusReason: "token-budget", tokenBudget: 1000, tokensUsed: 1200 }),
    });
    expect(screen.getByRole("dialog").textContent).toContain("1,200 of 1,000");
    fireEvent.change(screen.getByLabelText("New token budget"), { target: { value: "9000" } });
    fireEvent.click(button("Resume"));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith("resume --budget 9000"));
  });

  test("a goal already at the largest limit cannot resume, and says so", () => {
    renderPanel({ goal: goal("limited", { maxIterations: 100 }) });
    expect((button("Resume") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("dialog").textContent).toContain("largest iteration limit");
  });
});

describe("GoalPanel details", () => {
  test("shows the objective, check, tokens and last report as text", () => {
    renderPanel({
      goal: goal("active", {
        check: "bun test",
        tokensUsed: 1234,
        lastReport: { status: "progress", message: "**half** done", at: SET_AT },
      }),
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Make the build green");
    expect(screen.getByText("bun test")).toBeTruthy();
    expect(dialog.textContent).toContain("1,234");
    expect(dialog.textContent).toContain("3 of 20");
    // Agent text is untrusted: it is never rendered as Markdown.
    expect(screen.getByText("**half** done")).toBeTruthy();
  });

  test("a goal with no check says it will end as unverified", () => {
    renderPanel({ goal: goal("active") });
    expect(screen.getByRole("dialog").textContent).toContain("will end as unverified");
  });

  test("loads the check's output only when asked", async () => {
    const at = "2026-10-31T10:00:40.000Z";
    loadDetail.mockImplementation(async () =>
      detailWith({ passed: false, exitCode: 1, durationMs: 2000, outputTail: "1 failing", at }),
    );
    renderPanel({
      goal: goal("active", {
        check: "bun test",
        lastCheck: { passed: false, exitCode: 1, durationMs: 2000, at },
      }),
    });
    expect(screen.getByRole("dialog").textContent).toContain("Failed with exit code 1 in 2s");
    expect(loadDetail).not.toHaveBeenCalled();
    fireEvent.click(button("Show output"));
    expect((await screen.findByTestId("goal-check-output")).textContent).toBe("1 failing");
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  test("output from a newer run is not passed off as this run's", async () => {
    loadDetail.mockImplementation(async () =>
      detailWith({
        passed: true,
        exitCode: 0,
        durationMs: 1,
        outputTail: "newer",
        at: "2026-10-31T11:00:00.000Z",
      }),
    );
    renderPanel({
      goal: goal("active", {
        lastCheck: { passed: false, exitCode: 1, durationMs: 1, at: SET_AT },
      }),
    });
    fireEvent.click(button("Show output"));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer available");
    expect(screen.queryByTestId("goal-check-output")).toBeNull();
  });
});

describe("GoalPanel form", () => {
  test("sets a goal through the same command text the composer uses", async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Ship it" } });
    fireEvent.change(screen.getByLabelText("Check command"), { target: { value: "bun test" } });
    fireEvent.change(screen.getByLabelText("Iteration limit"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Token budget (optional)"), {
      target: { value: "9000" },
    });
    fireEvent.click(button("Set goal"));
    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith(
        "Ship it --max-iterations 5 --budget 9000 --check bun test",
      ),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test("defaults the iteration limit and waits for an objective", () => {
    renderPanel();
    expect((screen.getByLabelText("Iteration limit") as HTMLInputElement).value).toBe("20");
    expect((button("Set goal") as HTMLButtonElement).disabled).toBe(true);
  });

  test("no budget field where the agent's usage cannot back one", () => {
    renderPanel({ platform: "unknown" as AgentPlatform, agentLabel: "Unknown" });
    expect(screen.queryByLabelText("Token budget (optional)")).toBeNull();
    expect(screen.getByLabelText("Iteration limit")).toBeTruthy();
  });

  test("with no check it says the goal ends as unverified, and a check replaces that", () => {
    renderPanel();
    const note = screen.getByTestId("goal-check-note");
    expect(note.textContent).toContain("ends as unverified");
    fireEvent.change(screen.getByLabelText("Check command"), { target: { value: "bun test" } });
    expect(note.textContent).not.toContain("unverified");
  });

  test("says checks may run more than once, with or without a command", () => {
    renderPanel();
    const note = screen.getByTestId("goal-check-note");
    expect(note.textContent).toContain("may run more than once");
    fireEvent.change(screen.getByLabelText("Check command"), { target: { value: "bun test" } });
    expect(note.textContent).toContain("safe to repeat");
  });

  test("an objective that reads as a flag is refused without asking the backend", async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "resume" } });
    fireEvent.click(button("Set goal"));
    expect((await screen.findByRole("alert")).textContent).toContain("Reword it");
    expect(onCommand).not.toHaveBeenCalled();
  });

  test("a refusal keeps what was typed", async () => {
    onCommand.mockImplementation(async () => {
      throw new Error("A goal is already running.");
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Ship it" } });
    fireEvent.click(button("Set goal"));
    expect((await screen.findByRole("alert")).textContent).toBe("A goal is already running.");
    expect((screen.getByLabelText("Objective") as HTMLTextAreaElement).value).toBe("Ship it");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("a stopped goal can be replaced, and the form can be left again", () => {
    renderPanel({ goal: goal("paused") });
    fireEvent.click(button("Set a new goal"));
    expect(screen.getByLabelText("Objective")).toBeTruthy();
    fireEvent.click(button("Cancel"));
    expect(button("Resume")).toBeTruthy();
  });
});

describe("GoalPanel approval warning", () => {
  test("shown with the session's own control, and never changes the mode itself", () => {
    renderPanel({
      approvalWarning: "The Ask approval mode stops for approvals. A goal never changes the mode.",
      approvalControl: <button type="button">Approvals: Ask</button>,
    });
    const warning = screen.getByTestId("goal-approval-warning");
    expect(warning.textContent).toContain("A goal never changes the mode.");
    expect(screen.getByRole("button", { name: "Approvals: Ask" })).toBeTruthy();
    expect(onCommand).not.toHaveBeenCalled();
  });

  test("absent when the session will not stop", () => {
    renderPanel();
    expect(screen.queryByTestId("goal-approval-warning")).toBeNull();
  });
});
