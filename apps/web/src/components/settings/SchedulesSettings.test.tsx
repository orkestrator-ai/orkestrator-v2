import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RegistryWriterLease,
  REGISTRY_WRITER_LEASE_FILE,
} from "../../../../backend/src/core/registry-writer-lease";
import { StorageService } from "../../../../backend/src/core/storage";
import { schedulerStatus } from "../../../../backend/src/core/commands-registry-scheduled-jobs";
import { afterAll, afterEach, describe, expect, mock, test, spyOn, setSystemTime } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import {
  schedulerPausedMessage,
  type ScheduledJob,
  type ScheduledJobSummary,
  type SchedulerStatus,
} from "@orkestrator/protocol/scheduled-jobs";
import * as realBackend from "@/lib/backend";
import { dispatchResourceChange, requestViewSafetyChecks } from "@/lib/resource-sync";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { projectStore } from "@/stores";
import type { Project } from "@/types";
import {
  GRAPH_REF,
  graphScheduleOptions,
  graphTemplateSummary,
} from "./graph-schedule.test-fixtures";
import { appCommandStore } from "@/test/app-command-store";

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
let scheduler: SchedulerStatus | undefined;
const listScheduledJobs = mock(async () => ({
  schedules: schedules.map(summary),
  ...(scheduler ? { scheduler } : {}),
}));
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
  scheduler = undefined;
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

  test("a timer carrying the user's account-switch permission is marked, and when it lapses", async () => {
    const grant = {
      kind: "switch-agent-account",
      platforms: ["claude"],
      userInstruction: "check in 2 hours and switch if they are limited",
      grantedIn: "user-turn",
      grantedAt: "2099-10-25T10:00:00.000Z",
    };
    const timer = job({
      id: "sch_timer",
      name: "Self-timer: check usage limits",
      action: {
        kind: "action",
        action: "send_message",
        input: { toEnvironmentId: "coordinator", body: "Check", grant },
      },
    });
    schedules = [timer, failed];
    render(<SchedulesSettings />);
    const [row] = await screen.findAllByTestId("schedule-row");
    const badge = within(row!).getByTestId("schedule-account-switch-permission");
    expect(badge.textContent).toBe("May switch Claude accounts when it fires");
    expect(badge.getAttribute("title")).toContain(
      "You asked: “check in 2 hours and switch if they are limited”",
    );
    expect(badge.getAttribute("title")).toContain("for 2 hours after this timer fires");
    // Only the timer that carries it is marked.
    expect(
      within(screen.getAllByTestId("schedule-row")[1]!).queryByTestId(
        "schedule-account-switch-permission",
      ) === null,
    ).toBe(true);
  });

  test("production badge expires while mounted and reschedules on a same-key reload", async () => {
    const { AccountSwitchPermissionBadge } = await import("./SchedulesSettings");
    const fired = Date.parse("2099-10-25T12:00:00Z");
    let callback: (() => void) | undefined;
    setSystemTime(fired);
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      callback = fn;
      return 123;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      const action = {
        kind: "action" as const,
        action: "send_message",
        input: {
          grant: {
            kind: "switch-agent-account",
            platforms: ["claude"],
            userInstruction: "switch",
            grantedIn: "user-turn",
            grantedAt: new Date(fired).toISOString(),
          },
        },
      };
      const lastFire = {
        fireId: "f",
        kind: "scheduled" as const,
        state: "succeeded" as const,
        scheduledFor: new Date(fired).toISOString(),
        finishedAt: new Date(fired).toISOString(),
        attempts: 1,
      };
      const view = (finishedAt: string) => (
        <AccountSwitchPermissionBadge
          key="same-job"
          job={{ action, lastFire: { ...lastFire, finishedAt }, timeZone: "UTC" }}
        />
      );
      const { rerender } = render(view(lastFire.finishedAt));
      expect(screen.getByTestId("schedule-account-switch-permission").textContent).toContain(
        "until",
      );
      expect(timer.mock.calls.at(-1)?.[1]).toBe(7_200_000);
      setSystemTime(fired + 3_600_000);
      rerender(view(new Date(fired + 3_600_000).toISOString()));
      expect(clear).toHaveBeenCalled();
      setSystemTime(fired + 10_800_001);
      act(() => callback!());
      expect(screen.getByTestId("schedule-account-switch-permission").textContent).toContain(
        "lapsed",
      );
      rerender(view(new Date(fired + 3_600_000).toISOString()));
      expect(screen.getByTestId("schedule-account-switch-permission").textContent).toContain(
        "lapsed",
      );
      cleanup();
    } finally {
      timer.mockRestore();
      clear.mockRestore();
      setSystemTime();
    }
  });

  test("the permission badge counts its window from the fire", async () => {
    const { AccountSwitchPermissionBadge } = await import("./SchedulesSettings");
    const action = {
      kind: "action" as const,
      action: "send_message",
      input: {
        toEnvironmentId: "coordinator",
        body: "Check",
        grant: {
          kind: "switch-agent-account",
          platforms: ["claude", "codex"],
          nodeIds: ["bk_leaf"],
          userInstruction: "switch if limited",
          grantedIn: "user-turn",
          grantedAt: "2099-10-25T10:00:00.000Z",
        },
      },
    };
    const lastFire = {
      fireId: "f",
      kind: "scheduled" as const,
      scheduledFor: "2099-10-25T12:00:00.000Z",
      finishedAt: "2099-10-25T12:00:00.000Z",
      state: "succeeded" as const,
      attempts: 1,
    };
    const fired = Date.parse("2099-10-25T12:00:00.000Z");
    const { rerender } = render(
      <AccountSwitchPermissionBadge
        job={{ action, lastFire, timeZone: "UTC" }}
        now={fired + 60_000}
      />,
    );
    const badge = screen.getByTestId("schedule-account-switch-permission");
    expect(badge.textContent).toBe(
      "May switch Claude and Codex accounts until 2099-10-25 14:00 UTC",
    );
    expect(badge.getAttribute("title")).toContain("on this machine and 1 other");
    rerender(
      <AccountSwitchPermissionBadge
        job={{ action, lastFire, timeZone: "UTC" }}
        now={fired + 3 * 3_600_000}
      />,
    );
    expect(screen.getByTestId("schedule-account-switch-permission").textContent).toBe(
      "Claude and Codex switch permission lapsed",
    );
  });

  test("says when this backend does not fire the schedules it lists", async () => {
    scheduler = { firing: false, reason: "writer-lease-lost" };
    render(<SchedulesSettings />);
    const notice = await screen.findByTestId("scheduler-paused");
    expect(notice.textContent).toBe(schedulerPausedMessage("writer-lease-lost"));
    expect(notice.getAttribute("role")).toBe("status");
  });

  test("a lease lost while the view is open shows on its next read, and only with schedules", async () => {
    scheduler = { firing: true };
    render(<SchedulesSettings />);
    await screen.findAllByTestId("schedule-row");
    expectDomAbsent(screen.queryByTestId("scheduler-paused"), "scheduler notice while firing");

    // The backend announces the loss; any reread picks the state up.
    scheduler = { firing: false, reason: "another-backend" };
    requestViewSafetyChecks("resource-gap");
    const notice = await screen.findByTestId("scheduler-paused");
    expect(notice.textContent).toBe(schedulerPausedMessage("another-backend"));

    // Nobody with no schedules needs to hear that none fire.
    schedules = [];
    requestViewSafetyChecks("resource-gap");
    await screen.findByText(/No schedules yet/);
    expectDomAbsent(screen.queryByTestId("scheduler-paused"), "scheduler notice with no schedules");
  });

  test("lease loss reaches the mounted view through the storage resource feed and survives remount", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schedule-view-lease-"));
    const storage = new StorageService(directory);
    await storage.init();
    const lease = await RegistryWriterLease.acquire(directory, {
      onLost: () => storage.announceSchedulerStatus(),
    });
    storage.setResourceChangeListener((change) => {
      scheduler = schedulerStatus(lease);
      dispatchResourceChange(change);
    });
    try {
      scheduler = schedulerStatus(lease);
      const view = render(<SchedulesSettings />);
      await screen.findAllByTestId("schedule-row");
      expectDomAbsent(screen.queryByTestId("scheduler-paused"), "held writer");
      await writeFile(
        join(directory, REGISTRY_WRITER_LEASE_FILE),
        JSON.stringify({
          token: "replacement",
          pid: 1,
          acquiredAt: new Date().toISOString(),
        }),
      );
      expect(lease.isHeld()).toBe(false);
      expect((await screen.findByTestId("scheduler-paused")).textContent).toBe(
        schedulerPausedMessage("writer-lease-lost"),
      );
      view.unmount();
      render(<SchedulesSettings />);
      expect((await screen.findByTestId("scheduler-paused")).textContent).toBe(
        schedulerPausedMessage("writer-lease-lost"),
      );
    } finally {
      await lease.release();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a backend that predates the field shows no notice", async () => {
    render(<SchedulesSettings />);
    await screen.findAllByTestId("schedule-row");
    expectDomAbsent(
      screen.queryByTestId("scheduler-paused"),
      "scheduler notice from an old backend",
    );
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

describe("graph schedules", () => {
  const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
  const optionQueries: Record<string, unknown>[] = [];

  function installGraphBackend() {
    optionQueries.length = 0;
    appCommandStore(projectStore).setState({ projects: [{ id: "p1", name: "Shop" } as Project] });
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "graph_templates_list") {
        return {
          templates: [
            graphTemplateSummary(),
            graphTemplateSummary({
              ref: { scope: "user", id: "draft" },
              id: "draft",
              name: "Draft graph",
              launchable: false,
              compile: { ...graphTemplateSummary().compile, errors: 2 },
            }),
          ],
          project: null,
        };
      }
      if (command === "graph_launch_options") {
        optionQueries.push(args);
        return graphScheduleOptions();
      }
      return undefined;
    });
  }

  afterEach(() => {
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  async function chooseGraphAction(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Action" }));
    fireEvent.click(await screen.findByRole("option", { name: "Run a graph" }));
    fireEvent.change(within(dialog).getByLabelText("Project"), { target: { value: "p1" } });
    const template = within(dialog).getByLabelText("Template") as HTMLSelectElement;
    await waitFor(() => expect(template.options.length).toBeGreaterThan(2));
    const draft = Array.from(template.options).find((option) => option.value === "user:draft");
    expect(draft?.disabled).toBe(true);
    expect(draft?.textContent).toContain("Does not compile (2 errors)");
    fireEvent.change(template, { target: { value: "user:nightly-review" } });
    await within(dialog).findByRole("radiogroup", { name: "Environment" });
  }

  test("creates a graph schedule that uses the saved launch defaults", async () => {
    installGraphBackend();
    render(<SchedulesSettings />);
    await screen.findAllByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "+30m" } });
    await chooseGraphAction(dialog);
    // Roles and parameters are left to the saved defaults: no pickers.
    expectDomAbsent(within(dialog).queryByRole("region", { name: "Graph roles" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createScheduledJob).toHaveBeenCalled());
    expect(createScheduledJob.mock.calls[0]![0]).toEqual({
      at: "+30m",
      catchUpMinutes: 15,
      action: {
        kind: "graph",
        request: {
          ref: GRAPH_REF,
          projectId: "p1",
          environment: { kind: "new", create: "worktree" },
        },
      },
    });
    expect(optionQueries[0]).toEqual({ ref: GRAPH_REF, projectId: "p1" });
    expect(optionQueries.at(-1)).toEqual({ ref: GRAPH_REF, projectId: "p1", create: "worktree" });
  });

  test("pins roles and parameters when saved defaults are turned off", async () => {
    installGraphBackend();
    render(<SchedulesSettings />);
    await screen.findAllByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "+30m" } });
    await chooseGraphAction(dialog);
    fireEvent.click(within(dialog).getByLabelText("Use the saved launch defaults"));
    const role = await within(dialog).findByRole("region", { name: "Role Reviewer" });
    expect((within(role).getByLabelText("Reviewer 2 provider") as HTMLSelectElement).value).toBe(
      "codex",
    );
    fireEvent.change(within(dialog).getByLabelText("Rounds"), { target: { value: "4" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /New container/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createScheduledJob).toHaveBeenCalled());
    expect(createScheduledJob.mock.calls[0]![0]).toMatchObject({
      action: {
        kind: "graph",
        request: {
          ref: GRAPH_REF,
          projectId: "p1",
          environment: { kind: "new", create: "container" },
          roles: { reviewer: [{ platform: "claude" }, { platform: "codex" }] },
          params: { rounds: 4 },
        },
      },
    });
  });

  test("edits a graph schedule: an untouched save keeps the action, a change sends it", async () => {
    installGraphBackend();
    const request = {
      ref: GRAPH_REF,
      projectId: "p1",
      environment: { kind: "existing" as const, environmentId: "env-1" },
      roles: { reviewer: [{ platform: "codex" as const }] },
      params: { rounds: 5 },
    };
    schedules = [
      job({
        owner: { kind: "operator" },
        ownerKey: "operator",
        ownerLabel: "You",
        action: { kind: "graph", request },
      }),
    ];
    render(<SchedulesSettings />);
    const [row] = await screen.findAllByTestId("schedule-row");
    expect(row!.textContent).toContain("Run graph nightly-review in p1");
    fireEvent.click(screen.getByRole("button", { name: "Edit Wake the coordinator" }));
    const dialog = await screen.findByRole("dialog");
    const role = await within(dialog).findByRole("region", { name: "Role Reviewer" });
    expect((within(role).getByLabelText("Reviewer 1 provider") as HTMLSelectElement).value).toBe(
      "codex",
    );
    expect(optionQueries[0]).toEqual({ ref: GRAPH_REF, projectId: "p1", environmentId: "env-1" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateScheduledJob).toHaveBeenCalledTimes(1));
    expect(updateScheduledJob.mock.calls[0]![1]).toEqual({
      name: "Renamed",
      catchUpMinutes: 15,
      expectedRevision: 1,
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Wake the coordinator" }));
    const again = await screen.findByRole("dialog");
    await within(again).findByRole("region", { name: "Role Reviewer" });
    fireEvent.change(within(again).getByLabelText("Rounds"), { target: { value: "2" } });
    fireEvent.click(within(again).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateScheduledJob).toHaveBeenCalledTimes(2));
    expect(updateScheduledJob.mock.calls[1]![1]).toMatchObject({
      action: { kind: "graph", request: { ...request, params: { rounds: 2 } } },
    });
  });
});
