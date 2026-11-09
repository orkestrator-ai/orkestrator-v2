import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ScheduledJob, ScheduledJobSummary } from "@orkestrator/protocol/scheduled-jobs";
import * as realBackend from "@/lib/backend";
import { GLOBAL_SETTINGS_REQUEST_EVENT } from "@/lib/settings-navigation";
import { configStore, projectStore } from "@/stores";
import { appCommandStore } from "@/test/app-command-store";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { Project } from "@/types";

/**
 * A project's Scheduling tab: the project's schedules read from the backend
 * with the project filter, and a new schedule created inside the project
 * (launching into it by default, its agent tabs only, no project switch).
 */

const launchJob: ScheduledJob = {
  version: 1,
  id: "sch_nightly",
  name: "Nightly triage",
  owner: { kind: "operator" },
  ownerKey: "operator",
  ownerLabel: "You",
  trigger: { kind: "cron", expression: "0 3 * * *" },
  timeZone: "Europe/London",
  action: { kind: "launch", projectId: "p1", agent: "claude", prompt: "Triage new issues" },
  catchUpMinutes: 15,
  state: "active",
  nextFireAt: "2099-10-26T02:00:00.000Z",
  fires: [],
  fireCount: 0,
  revision: 1,
  createdAt: "2099-10-25T10:00:00.000Z",
  updatedAt: "2099-10-25T10:00:00.000Z",
};

function summary(value: ScheduledJob): ScheduledJobSummary {
  const { fires, createRequest: _createRequest, ...rest } = value;
  return { ...rest, lastFire: fires.at(-1) ?? null, activeFire: null };
}

let schedules: ScheduledJob[] = [launchJob];
const listScheduledJobs = mock(async (_filter?: unknown) => ({
  schedules: schedules.map(summary),
}));
const getScheduledJob = mock(async (id: string) => schedules.find((item) => item.id === id)!);
const createScheduledJob = mock(async (_input: unknown) => ({
  schedule: launchJob,
  replayed: false,
}));
const listAgentMailboxes = mock(async (_options?: unknown) => ({
  mailboxes: [
    {
      mailboxId: "env-1\u0000startup-agent",
      projectId: "p1",
      environmentId: "env-1",
      tabId: "startup-agent",
      environmentName: "auth-fix",
      displayName: "Claude 1",
    },
    {
      mailboxId: "env-2\u0000startup-agent",
      projectId: "p2",
      environmentId: "env-2",
      tabId: "startup-agent",
      environmentName: "elsewhere",
      displayName: "Codex 1",
    },
  ],
  total: 2,
  offset: 0,
  limit: 200,
}));

mock.module("@/lib/backend", () => ({
  ...realBackend,
  listScheduledJobs,
  getScheduledJob,
  createScheduledJob,
  listAgentMailboxes,
}));

const { ProjectSchedulesView } = await import("./ProjectSchedulesView");

function setScheduling(enabled: boolean) {
  const store = appCommandStore(configStore);
  const { config } = store.getState();
  store.setState({
    hasLoaded: true,
    config: { ...config, global: { ...config.global, experimentalScheduling: enabled } },
  });
}

beforeEach(() => {
  appCommandStore(projectStore).setState({
    projects: [{ id: "p1", name: "Shop" } as Project, { id: "p2", name: "Blog" } as Project],
  });
  setScheduling(true);
});

afterEach(() => {
  cleanup();
  schedules = [launchJob];
  for (const fn of [listScheduledJobs, getScheduledJob, createScheduledJob, listAgentMailboxes]) {
    fn.mockClear();
  }
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

describe("ProjectSchedulesView", () => {
  test("lists the project's schedules, read with the project filter", async () => {
    renderInAppCommandScope(<ProjectSchedulesView projectId="p1" />);
    const panel = screen.getByRole("tabpanel", { name: "Scheduling" });
    expect(panel.id).toBe("project-panel-schedules");
    const [row] = await screen.findAllByTestId("schedule-row");
    expect(row!.textContent).toContain("Nightly triage");
    expect(row!.textContent).toContain("Launch claude in Shop");
    expect(listScheduledJobs.mock.calls[0]).toEqual([{ projectId: "p1" }]);
  });

  test("an empty project says how to start", async () => {
    schedules = [];
    renderInAppCommandScope(<ProjectSchedulesView projectId="p1" />);
    expect(await screen.findByText(/No schedules for this project yet/)).toBeTruthy();
  });

  test("a new schedule launches into the project, which cannot be changed", async () => {
    renderInAppCommandScope(<ProjectSchedulesView projectId="p1" />);
    await screen.findAllByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Runs as you, in Shop.")).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "Action" }).textContent).toBe(
      "Launch an environment",
    );
    expect(
      (within(dialog).getByRole("combobox", { name: "Project" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Nightly triage" },
    });
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "+30m" } });
    fireEvent.change(within(dialog).getByLabelText("Initial prompt"), {
      target: { value: "Triage new issues" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createScheduledJob).toHaveBeenCalled());
    expect(createScheduledJob.mock.calls[0]![0]).toEqual({
      at: "+30m",
      name: "Nightly triage",
      catchUpMinutes: 15,
      action: {
        kind: "launch",
        projectId: "p1",
        agent: "claude",
        prompt: "Triage new issues",
        type: "local",
        baseBranch: undefined,
      },
    });
  });

  test("offers only actions that target the project, and only its agent tabs", async () => {
    renderInAppCommandScope(<ProjectSchedulesView projectId="p1" />);
    await screen.findAllByTestId("schedule-row");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog");
    expect(listAgentMailboxes.mock.calls[0]).toEqual([{ limit: 200, projectId: "p1" }]);

    fireEvent.click(within(dialog).getByRole("combobox", { name: "Action" }));
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual([
      "Send agent mail",
      "Prompt an agent tab",
      "Launch an environment",
      "Run a graph",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "Prompt an agent tab" }));
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Agent tab" }));
    const tabs = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(tabs).toEqual(["auth-fix / Claude 1"]);
  });

  test("while scheduling is off it offers to turn it on instead of listing", async () => {
    setScheduling(false);
    const requested: unknown[] = [];
    const listener = (event: Event) => requested.push((event as CustomEvent).detail);
    window.addEventListener(GLOBAL_SETTINGS_REQUEST_EVENT, listener);
    try {
      renderInAppCommandScope(<ProjectSchedulesView projectId="p1" />);
      expect(screen.getByTestId("project-schedules-disabled")).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Turn it on in Settings → Experimental" }),
      );
      expect(requested).toEqual(["experimental"]);
      expect(listScheduledJobs).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(GLOBAL_SETTINGS_REQUEST_EVENT, listener);
    }
  });
});
