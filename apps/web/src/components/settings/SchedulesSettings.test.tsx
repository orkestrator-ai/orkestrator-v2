import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ScheduledJob, ScheduledJobSummary } from "@orkestrator/protocol/scheduled-jobs";
import * as realBackend from "@/lib/backend";

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    version: 1,
    id: "sch_wake",
    name: "Wake the coordinator",
    owner: {
      kind: "coordinator",
      projectId: "p1",
      coordinatorId: "c1",
      conversationId: "m",
      role: "main",
    },
    ownerKey: "coordinator:c1",
    ownerLabel: "Coordinator",
    trigger: { kind: "once", at: "2099-10-26T03:12:00.000Z" },
    timeZone: "Europe/London",
    action: {
      kind: "action",
      action: "send_message",
      input: { toEnvironmentId: "coordinator", body: "Resume" },
    },
    catchUpMinutes: 15,
    state: "active",
    nextFireAt: "2099-10-26T03:12:00.000Z",
    fires: [],
    fireCount: 0,
    revision: 1,
    createdAt: "2099-10-25T10:00:00.000Z",
    updatedAt: "2099-10-25T10:00:00.000Z",
    ...overrides,
  };
}

function summary(value: ScheduledJob): ScheduledJobSummary {
  const { fires, createRequest: _createRequest, ...rest } = value;
  return { ...rest, lastFire: fires.at(-1) ?? null, activeFire: null };
}

const failed = job({
  id: "sch_nightly",
  name: "Nightly audit",
  owner: { kind: "operator" },
  ownerKey: "operator",
  ownerLabel: "You",
  trigger: { kind: "cron", expression: "0 3 * * *" },
  state: "paused",
  pausedReason: "target-deleted",
  pausedMessage: "Environment env-9 was deleted",
  fires: [
    {
      fireId: "sch_nightly@1",
      kind: "scheduled",
      scheduledFor: "2099-10-25T03:00:00.000Z",
      state: "failed",
      attempts: 1,
      error: { code: "not-found", message: "No such tab" },
    },
  ],
});

let schedules = [job(), failed];
const listScheduledJobs = mock(async () => ({ schedules: schedules.map(summary) }));
const getScheduledJob = mock(async (id: string) => schedules.find((item) => item.id === id)!);
const runScheduledJob = mock(async (id: string) => ({ job: getScheduledJob(id), fire: {} }));
const pauseScheduledJob = mock(async (id: string) => schedules.find((item) => item.id === id)!);
const resumeScheduledJob = mock(async (id: string) => schedules.find((item) => item.id === id)!);
const deleteScheduledJob = mock(async (scheduleId: string) => ({ scheduleId, deleted: true }));
const createScheduledJob = mock(async (_input: unknown) => ({ schedule: job(), replayed: false }));
const updateScheduledJob = mock(async (_id: string, _input: unknown) => job());
const listAgentMailboxes = mock(async () => ({
  mailboxes: [
    {
      mailboxId: "env-1\u0000startup-agent",
      environmentId: "env-1",
      tabId: "startup-agent",
      environmentName: "auth-fix",
      displayName: "Claude 1",
    },
  ],
  total: 1,
  offset: 0,
  limit: 200,
}));

mock.module("@/lib/backend", () => ({
  ...realBackend,
  listScheduledJobs,
  getScheduledJob,
  runScheduledJob,
  pauseScheduledJob,
  resumeScheduledJob,
  deleteScheduledJob,
  createScheduledJob,
  updateScheduledJob,
  listAgentMailboxes,
}));

const { SchedulesSettings } = await import("./SchedulesSettings");

afterEach(() => {
  cleanup();
  schedules = [job(), failed];
  for (const fn of [
    listScheduledJobs,
    runScheduledJob,
    pauseScheduledJob,
    resumeScheduledJob,
    createScheduledJob,
    updateScheduledJob,
  ]) {
    fn.mockClear();
  }
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

describe("SchedulesSettings", () => {
  test("lists each schedule's next fire, owner, state and last outcome", async () => {
    render(<SchedulesSettings />);
    const rows = await screen.findAllByTestId("schedule-row");
    expect(rows).toHaveLength(2);
    const [wake, nightly] = rows as [HTMLElement, HTMLElement];
    expect(within(wake).getByTestId("schedule-owner").textContent).toBe("Coordinator");
    expect(within(wake).getByTestId("schedule-next").textContent).toBe("2099-10-26 03:12 GMT");
    expect(within(wake).getByText("Never fired")).toBeTruthy();
    expect(within(nightly).getByText("paused: target-deleted")).toBeTruthy();
    expect(within(nightly).getByText("Environment env-9 was deleted")).toBeTruthy();
    expect(within(nightly).getByText("failed").getAttribute("title")).toBe(
      "not-found: No such tab",
    );
    expect(within(nightly).getByTestId("schedule-next").textContent).toBe("—");
  });

  test("run now, pause and resume go to the backend and reload the list", async () => {
    render(<SchedulesSettings />);
    await screen.findAllByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: "Run Wake the coordinator now" }));
    await waitFor(() => expect(runScheduledJob).toHaveBeenCalledWith("sch_wake"));
    fireEvent.click(screen.getByRole("button", { name: "Pause Wake the coordinator" }));
    await waitFor(() => expect(pauseScheduledJob).toHaveBeenCalledWith("sch_wake"));
    fireEvent.click(screen.getByRole("button", { name: "Resume Nightly audit" }));
    await waitFor(() => expect(resumeScheduledJob).toHaveBeenCalledWith("sch_nightly"));
    await waitFor(() => expect(listScheduledJobs.mock.calls.length).toBeGreaterThanOrEqual(4));
  });

  test("creates a one-shot mail schedule and previews its fire time", async () => {
    render(<SchedulesSettings />);
    await screen.findAllByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "+30m" } });
    fireEvent.change(within(dialog).getByLabelText("Time zone"), {
      target: { value: "Europe/London" },
    });
    expect(within(dialog).getByTestId("schedule-preview").textContent).toMatch(
      /^Next: \d{4}-\d{2}-\d{2} \d{2}:\d{2} (GMT|BST)$/,
    );
    fireEvent.change(within(dialog).getByLabelText("Message"), {
      target: { value: "Resume the workers" },
    });
    // No mailbox chosen yet: refused locally.
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Choose a mailbox");
    expect(createScheduledJob).not.toHaveBeenCalled();
  });

  test("an invalid cron expression is reported in the preview", async () => {
    render(<SchedulesSettings />);
    await screen.findAllByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox", { name: "When" }));
    fireEvent.click(await screen.findByRole("option", { name: "Cron" }));
    fireEvent.change(within(dialog).getByLabelText("Cron expression"), {
      target: { value: "61 * * * *" },
    });
    expect(within(dialog).getByTestId("schedule-preview").textContent).toContain("outside 0-59");
  });

  test("editing another owner's schedule keeps its action and only sends what changed", async () => {
    render(<SchedulesSettings />);
    await screen.findAllByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: "Edit Wake the coordinator" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/always runs as them/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Wake at 03:12" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateScheduledJob).toHaveBeenCalled());
    expect(updateScheduledJob.mock.calls[0]).toEqual([
      "sch_wake",
      { name: "Wake at 03:12", catchUpMinutes: 15, expectedRevision: 1 },
    ]);
  });

  test("history lists fires newest first with their errors", async () => {
    render(<SchedulesSettings />);
    const rows = await screen.findAllByTestId("schedule-row");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "History" }));
    const history = await screen.findByTestId("schedule-history");
    expect(history.textContent).toContain("No such tab");
    expect(history.textContent).toContain("2099-10-25 03:00 GMT");
  });
});

for (const action of [
  {
    kind: "launch",
    type: "container",
    projectId: "p1",
    agent: "codex",
    prompt: "audit",
    name: "Pinned worker",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    model: "model-1",
    reasoning: "high",
    mode: "plan",
  },
  { kind: "prompt", environmentId: "env-1", tabId: "startup-agent", prompt: "audit", mode: "plan" },
] as const) {
  for (const edit of ["name", "time", "prompt"] as const) {
    test(`operator ${action.kind} ${edit} edit preserves unrepresented action fields`, async () => {
      const original = job({ owner: { kind: "operator" }, ownerKey: "operator", action });
      schedules = [original];
      render(<SchedulesSettings />);
      await screen.findAllByTestId("schedule-row");
      fireEvent.click(screen.getByRole("button", { name: "Edit Wake the coordinator" }));
      const dialog = await screen.findByRole("dialog");
      const label =
        edit === "name"
          ? "Name"
          : edit === "time"
            ? "Time"
            : action.kind === "launch"
              ? "Initial prompt"
              : "Prompt";
      fireEvent.change(within(dialog).getByLabelText(label), {
        target: { value: edit === "time" ? "+40m" : "Edited" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(updateScheduledJob).toHaveBeenCalledTimes(1));
      const input = updateScheduledJob.mock.calls[0]![1] as { action?: unknown };
      if (edit === "prompt") expect(input.action).toEqual({ ...action, prompt: "Edited" });
      else expect(input).not.toHaveProperty("action");
      expect(original.action).toEqual(action);
    });
  }
}
