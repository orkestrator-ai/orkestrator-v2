import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ScheduledJob, ScheduledJobSummary } from "@orkestrator/protocol/scheduled-jobs";
import * as realBackend from "@/lib/backend";
import { GLOBAL_SETTINGS_REQUEST_EVENT } from "@/lib/settings-navigation";
import { configStore, projectStore } from "@/stores";
import { appCommandStore } from "@/test/app-command-store";
import {
  cleanupNodeScopes,
  FakeNodeClient,
  renderInNodeScope,
  renderInAppCommandScope,
} from "@/test/render-in-node-scope";
import type { Project } from "@/types";
import type { BackendId } from "@orkestrator/protocol/federation";
import { bindSettingsParent } from "@/lib/portal/command-node-config";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import {
  GRAPH_REF,
  graphScheduleOptions,
  graphTemplateSummary,
} from "../settings/graph-schedule.test-fixtures";

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
  cleanupNodeScopes();
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

// A remote node deliberately reuses p1: node-local ids must never route calls
// or feature enablement to the command node.
function renderRemote(job: ScheduledJob = launchJob, enabled = true) {
  const windowScope = new WindowScope();
  const commandClient = new FakeNodeClient();
  const command = windowScope.open({ role: "command", client: commandClient });
  const client = new FakeNodeClient({
    nodeId: "bk_schedule-leaf" as BackendId,
    invoke: {
      list_scheduled_jobs: () => ({ schedules: [summary(job)] }),
      get_scheduled_job: () => job,
      update_scheduled_job: (args: Readonly<Record<string, unknown>>) => {
        const { scheduleId: _id, expectedRevision: _revision, ...patch } = args;
        Object.assign(job, patch);
        return job;
      },
      create_scheduled_job: { schedule: job, replayed: false },
      list_agent_mailboxes: { mailboxes: [], total: 0, offset: 0, limit: 200 },
      get_opencode_model_catalog_cache: { projectId: "p1", models: [] },
      get_agent_model_catalog_cache: {},
      graph_templates_list: { templates: [graphTemplateSummary()] },
      graph_launch_options: () => graphScheduleOptions(),
    },
  });
  const scope = windowScope.open({ role: "leaf", client });
  bindSettingsParent(scope, command);
  for (const node of [command, scope]) {
    const config = node.store(configStore).getState().config;
    node
      .store(configStore)
      .getState()
      .setConfig({
        ...config,
        global: { ...config.global, experimentalScheduling: enabled },
      });
    node.store(projectStore).setState({ projects: [{ id: "p1", name: "Remote Shop" } as Project] });
  }
  const rendered = renderInNodeScope(<ProjectSchedulesView projectId="p1" />, {
    windowScope,
    client,
    role: "leaf",
  });
  return { ...rendered, client, command, commandClient, job };
}

const graphJob = (): ScheduledJob => ({
  ...launchJob,
  action: {
    kind: "graph",
    request: {
      projectId: "p1",
      ref: GRAPH_REF,
      environment: { kind: "new", create: "container" },
      roles: { reviewer: { platform: "codex", model: "saved-model" } },
      params: { rounds: 5 },
      inputs: { brief: "Saved request" },
    },
  },
});

for (const kind of ["graph-pending", "graph-rejected", "mail", "prompt"] as const) {
  for (const edit of ["rename", "retime"] as const) {
    test(`remote project ${edit} preserves an untouched ${kind} action`, async () => {
      const job = graphJob();
      if (kind === "mail")
        job.action = {
          kind: "action",
          action: "mail.send",
          input: {
            toEnvironmentId: "env-1",
            toTabId: "startup-agent",
            body: "Saved mail",
          },
        };
      if (kind === "prompt")
        job.action = {
          kind: "prompt",
          environmentId: "env-1",
          tabId: "startup-agent",
          prompt: "Saved prompt",
        };
      const original = structuredClone(job.action);
      const { client } = renderRemote(job);
      let settle: (value: unknown) => void = () => {};
      if (kind === "graph-pending") {
        client.respond(
          "graph_launch_options",
          () =>
            new Promise((resolve) => {
              settle = resolve;
            }),
        );
      } else if (kind === "graph-rejected") {
        client.respond("graph_launch_options", () => {
          throw new Error("Template unavailable");
        });
      }
      await screen.findAllByTestId("schedule-row");
      fireEvent.click(screen.getByRole("button", { name: `Edit ${job.name}` }));
      const dialog = await screen.findByRole("dialog");
      if (kind === "graph-rejected") await within(dialog).findByText("Template unavailable");
      if (kind === "graph-pending")
        await within(dialog).findByText("Compiling the template for launch…");
      fireEvent.change(
        within(dialog).getByLabelText(edit === "rename" ? "Name" : "Cron expression"),
        {
          target: { value: edit === "rename" ? "Renamed" : "0 4 * * *" },
        },
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(client.calls("update_scheduled_job")).toHaveLength(1));
      const patch = client.calls("update_scheduled_job")[0]!.args;
      expect(patch).not.toHaveProperty("action");
      expect(patch).toMatchObject(edit === "rename" ? { name: "Renamed" } : { cron: "0 4 * * *" });
      expect(job.action).toEqual(original);
      await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
      settle(graphScheduleOptions());
    });
  }
}

test("remote project routes list/create and graph reads to its own node and isolates refreshes", async () => {
  const { client, command, commandClient, scope, unmount, windowScope } = renderRemote();
  await screen.findAllByTestId("schedule-row");
  expect(client.calls("list_scheduled_jobs")[0]!.args).toEqual({ projectId: "p1" });
  fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Remote launch" } });
  fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "+30m" } });
  fireEvent.change(within(dialog).getByLabelText("Initial prompt"), {
    target: { value: "Remote work" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => expect(client.calls("create_scheduled_job")).toHaveLength(1));
  expect(client.calls("create_scheduled_job")[0]!.args.action).toMatchObject({
    kind: "launch",
    projectId: "p1",
  });
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  const count = client.calls("list_scheduled_jobs").length;
  const timer = installControlledTimeout(50, { label: "resource change coalescing" });
  try {
    act(() =>
      dispatchResourceChange({ resource: "scheduled-job", id: "other", revision: 1 }, command),
    );
    await act(async () => {
      timer.advance();
    });
    expect(client.calls("list_scheduled_jobs")).toHaveLength(count);
    act(() =>
      dispatchResourceChange({ resource: "scheduled-job", id: launchJob.id, revision: 1 }, scope),
    );
    await act(async () => {
      timer.advance();
    });
    timer.assertDrained();
  } finally {
    timer.restore();
  }
  await waitFor(() => expect(client.calls("list_scheduled_jobs")).toHaveLength(count + 1));
  fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Action" }));
  fireEvent.click(screen.getByRole("option", { name: "Run a graph" }));
  await waitFor(() => expect(client.calls("graph_templates_list")).toHaveLength(1));
  fireEvent.change(screen.getByLabelText("Template"), { target: { value: "user:nightly-review" } });
  await waitFor(() => expect(client.calls("graph_launch_options")).toHaveLength(1));
  expect(client.calls("graph_launch_options")[0]!.args).toMatchObject({
    projectId: "p1",
    ref: GRAPH_REF,
  });
  expect(commandClient.invocations).toEqual([]);
  expect(listScheduledJobs).not.toHaveBeenCalled();
  expect(createScheduledJob).not.toHaveBeenCalled();
  unmount();
  client.respond("list_scheduled_jobs", { schedules: [] });
  renderInNodeScope(<ProjectSchedulesView projectId="p1" />, { windowScope, client, role: "leaf" });
  expect(await screen.findByText(/No schedules for this project yet/)).toBeTruthy();
});

test("remote scheduling enablement saves only its flag, handles failure, and rehydrates", async () => {
  const { client, command, scope, windowScope, unmount } = renderRemote(launchJob, false);
  const prior = scope.store(configStore).getState().layers!.node;
  let finish: (value: unknown) => void = () => {};
  client.respond(
    "patch_global_config",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Turn on scheduling on this node" }));
  expect(
    (screen.getByRole("button", { name: "Turning on scheduling…" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () =>
    finish({ ...prior, global: { ...prior.global, experimentalScheduling: true } }),
  );
  await screen.findAllByTestId("schedule-row");
  expect(client.calls("patch_global_config")[0]!.args).toEqual({
    patch: { experimentalScheduling: true },
  });
  expect(command.store(configStore).getState().config.global.experimentalScheduling).toBe(false);
  expect(scope.store(configStore).getState().config.global.experimentalScheduling).toBe(true);
  unmount();
  renderInNodeScope(<ProjectSchedulesView projectId="p1" />, { windowScope, client, role: "leaf" });
  await screen.findAllByTestId("schedule-row");
  act(() => scope.store(configStore).getState().setConfig(prior));
  client.respond("patch_global_config", () => {
    throw new Error("Node offline");
  });
  fireEvent.click(screen.getByRole("button", { name: "Turn on scheduling on this node" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Node offline");
  expect(scope.store(configStore).getState().config.global.experimentalScheduling).toBe(false);
  expect(
    (screen.getByRole("button", { name: "Turn on scheduling on this node" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
