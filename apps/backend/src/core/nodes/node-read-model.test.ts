import { eventSink } from "../backend-emit.js";
import { afterEach, expect, test } from "bun:test";
import type { NodeProjectSummary } from "@orkestrator/protocol/node-summaries";
import type { BackendId } from "@orkestrator/protocol/federation";
import { recurringDiagnosticsRegistry } from "../recurring-diagnostics.js";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout.js";
import { NodeReadModel, NODE_SUMMARY_EVENT_PREFIXES } from "./node-read-model.js";
import { TICKET_SYNC_OUTBOX_READY_EVENT } from "@orkestrator/protocol/ticket-sync";
import { eventMatchesSubscription } from "../../gateway-support-extra.js";
import { NODE_OUTBOX_READY_EVENT } from "./node-mail.js";

// Stop every node a test left running, so a network's summary jobs do not
// outlive it; see `stopTestNodeNetworks`.
afterEach(async () => {
  const { stopTestNodeNetworks } = await import("./node-network-test-support.js");
  await stopTestNodeNetworks();
});

function harness() {
  let now = 0;
  let failed = false;
  let name = "before";
  const events: string[] = [];
  const model = new NodeReadModel({
    now: () => now,
    nodes: {
      selfIdentity: async () => "bk_command" as BackendId,
      selfProfile: async () => ({ displayName: "Command" }),
      listNodes: async () => ({ nodes: [] }) as never,
      link: () => null,
      subscribe: () => () => undefined,
      recordProfile: async () => undefined,
    },
    emit: eventSink((event) => {
      events.push(event);
    }),
    local: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        if (command === "get_projects")
          return [
            { id: "p1", name: "One" },
            { id: "p2", name: "Two" },
          ] as T;
        if (failed && args?.projectId === "p2") throw new Error("snapshot temporarily unreadable");
        return [
          { id: `${args?.projectId}-env`, projectId: args?.projectId, name, status: "running" },
        ] as T;
      },
    },
  });
  return {
    model,
    events,
    advance: () => {
      now += 11 * 60_000;
      name = "after sleep";
    },
    fail: (value: boolean) => {
      failed = value;
    },
  };
}

test("the node stream carries every leaf announcement the command node acts on", () => {
  // The leaf's gateway filters its stream by these prefixes
  // (`eventMatchesSubscription`); the outbox collectors read the same stream
  // (`onNodeEvent`). The ticket-sync announcement was once filtered out, so a
  // leaf's change waited for the 60 s reconcile (to-do 3800 task 1).
  const subscribed = NODE_SUMMARY_EVENT_PREFIXES.join(",").split(",");
  for (const event of [NODE_OUTBOX_READY_EVENT, TICKET_SYNC_OUTBOX_READY_EVENT]) {
    expect({ event, delivered: eventMatchesSubscription(event, subscribed) }).toEqual({
      event,
      delivered: true,
    });
  }
});

test("self-summary invalidations survive ten minutes idle and reconcile after sleep", async () => {
  const h = harness();
  try {
    await h.model.summaries(undefined, { includeSelf: true });
    h.advance();
    h.model.noteLocalEvent("resource-changed", { resource: "environment" });
    await Bun.sleep(80);
    expect(h.events).toContain("node-summary-changed");
    const self = (await h.model.summaries(undefined, { includeSelf: true })).self!;
    expect(self.environments.map((row) => row.name)).toEqual(["after sleep", "after sleep"]);
  } finally {
    h.model.stop();
  }
});

test("partial self snapshot failure retains last known environments, marks truncation and retries", async () => {
  const h = harness();
  try {
    await h.model.summaries(undefined, { includeSelf: true });
    h.advance();
    h.fail(true);
    h.model.noteLocalEvent("resource-changed", { resource: "environment" });
    const partial = (await h.model.summaries(undefined, { includeSelf: true })).self!;
    expect(partial.environments.map((row) => row.name)).toEqual(["after sleep", "before"]);
    expect(partial.truncated).toBe(true);
    h.fail(false);
    const recovered = (await h.model.summaries(undefined, { includeSelf: true })).self!;
    expect(recovered.environments.map((row) => row.name)).toEqual(["after sleep", "after sleep"]);
    expect(recovered.truncated).toBe(false);
  } finally {
    h.model.stop();
  }
});

test("named summary due job reconciles missed events and stops with the model", async () => {
  const { TestNodeNetwork, settle } = await import("./node-network-test-support.js");
  const network = new TestNodeNetwork();
  const command = await network.add("command", { forceRegistration: true });
  const leaf = await network.add("leaf");
  let name = "before";
  leaf.commands.set("get_projects", () => [{ id: "p1", name }]);
  leaf.commands.set("get_environments", () => []);
  await command.service.addNode({
    routes: [{ id: "primary" as never, kind: "https", enabled: true, origin: leaf.origin }],
    token: leaf.token,
  });
  const model = new NodeReadModel({
    nodes: command.service,
    emit: () => undefined,
    fetchImpl: network.fetch,
    reconcileMs: 20,
  });
  const summarySchedulers = () =>
    recurringDiagnosticsRegistry
      .snapshot()
      .schedulers.filter((scheduler) => scheduler.byKind["node-summary-reconcile"]?.keys === 1)
      .length;
  const before = summarySchedulers();
  try {
    await model.start();
    expect(summarySchedulers()).toBe(before + 1);
    await settle(40);
    expect((await model.summaries()).nodes[0]!.projects[0]!.name).toBe("before");
    name = "missed-event";
    await settle(80);
    expect((await model.summaries()).nodes[0]!.projects[0]!.name).toBe("missed-event");
    model.stop();
    expect(summarySchedulers()).toBe(before);
    await settle(40);
    const reads = leaf.received.filter((call) => call.command === "get_projects").length;
    await settle(60);
    expect(leaf.received.filter((call) => call.command === "get_projects")).toHaveLength(reads);
  } finally {
    model.stop();
  }
});

function searchFieldModel(projects: (args: Record<string, unknown> | undefined) => unknown[]) {
  const projectArgs: Array<Record<string, unknown> | undefined> = [];
  const model = new NodeReadModel({
    nodes: {
      selfIdentity: async () => "bk_command" as BackendId,
      selfProfile: async () => ({ displayName: "Command" }),
      listNodes: async () => ({ nodes: [] }) as never,
      link: () => null,
      subscribe: () => () => undefined,
      recordProfile: async () => undefined,
    },
    emit: () => undefined,
    local: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        if (command === "get_projects") {
          projectArgs.push(args);
          return projects(args) as T;
        }
        return [
          {
            id: "e1",
            projectId: "p1",
            name: "run-desktop-app",
            branch: "run-desktop-app",
            status: "stopped",
            worktreePath: "/Users/someone/worktrees/telegram-scraper-run",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ] as T;
      },
    },
  });
  return { model, projectArgs };
}

test("summaries carry the search fields: path names, default branch and creation time", async () => {
  const { model, projectArgs } = searchFieldModel((args) => [
    {
      id: "p1",
      name: "telegram-scraper",
      gitUrl: "git@github.com:acme/telegram-scraper.git",
      localPath: "/Users/someone/code/telegram-scraper/",
      ...(args?.includeDefaultBranch === true ? { defaultBranch: "develop" } : {}),
    },
  ]);
  try {
    const self = (await model.summaries(undefined, { includeSelf: true })).self!;
    expect(projectArgs).toEqual([{ includeDefaultBranch: true, summaryIcons: true }]);
    expect(self.projects[0]).toMatchObject({
      name: "telegram-scraper",
      repositoryHint: "github.com/acme/telegram-scraper",
      pathName: "telegram-scraper",
      defaultBranch: "develop",
    });
    expect(self.environments[0]).toMatchObject({
      worktreeName: "telegram-scraper-run",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    // Only the last path segment leaves the node.
    expect(JSON.stringify(self)).not.toContain("/Users/someone");
  } finally {
    model.stop();
  }
});

test("a node that predates includeDefaultBranch still summarizes without it", async () => {
  // An older node ignores the argument and returns its plain projects.
  const { model } = searchFieldModel(() => [{ id: "p1", name: "telegram-scraper" }]);
  try {
    const self = (await model.summaries(undefined, { includeSelf: true })).self!;
    expect(self.projects[0]!.name).toBe("telegram-scraper");
    expect(self.projects[0]!.defaultBranch).toBeUndefined();
    expect(self.projects[0]!.pathName).toBeUndefined();
  } finally {
    model.stop();
  }
});

test("config-only changes invalidate the cached self default branch", async () => {
  let defaultBranch = "main";
  const { model, projectArgs } = searchFieldModel(() => [{ id: "p1", name: "One", defaultBranch }]);
  try {
    expect(
      (await model.summaries(undefined, { includeSelf: true })).self!.projects[0]!.defaultBranch,
    ).toBe("main");
    defaultBranch = "develop";
    model.noteLocalEvent("resource-changed", { resource: "config", id: "app" });
    expect(
      (await model.summaries(undefined, { includeSelf: true })).self!.projects[0]!.defaultBranch,
    ).toBe("develop");
    expect(projectArgs).toEqual([
      { includeDefaultBranch: true, summaryIcons: true },
      { includeDefaultBranch: true, summaryIcons: true },
    ]);
  } finally {
    model.stop();
  }
});

test("a node's project list read is announced when it is first read and when it changes", async () => {
  // Ticket sync pairs boards by this list, and syncs on the announcement
  // rather than waiting for its reconcile (to-do 3800 task 1).
  const { TestNodeNetwork, settle } = await import("./node-network-test-support.js");
  const network = new TestNodeNetwork();
  const command = await network.add("command", { forceRegistration: true });
  const leaf = await network.add("leaf");
  let projects = [{ id: "p1", name: "One", gitUrl: "https://github.com/acme/one.git" }];
  leaf.commands.set("get_projects", () => projects);
  leaf.commands.set("get_environments", () => []);
  await command.service.addNode({
    routes: [{ id: "primary" as never, kind: "https", enabled: true, origin: leaf.origin }],
    token: leaf.token,
  });
  const model = new NodeReadModel({
    nodes: command.service,
    emit: () => undefined,
    fetchImpl: network.fetch,
    reconcileMs: 60_000,
  });
  const announced: string[] = [];
  model.onProjectsChanged((nodeId) => announced.push(nodeId));
  try {
    await model.start();
    await settle(40);
    expect(announced).toHaveLength(1);
    const nodeId = announced[0]!;
    // A re-read that finds the same list says nothing.
    leaf.emit("resource-changed", { resource: "project", id: "p1", revision: 1 });
    await settle(40);
    expect(announced).toEqual([nodeId]);
    // A second copy appears there.
    projects = [...projects, { id: "p2", name: "Two", gitUrl: "https://github.com/acme/two.git" }];
    leaf.emit("resource-changed", { resource: "project", id: "p2", revision: 2 });
    await settle(40);
    expect(announced).toEqual([nodeId, nodeId]);
  } finally {
    model.stop();
  }
});

test("config-only leaf events rehydrate the remote project's default branch", async () => {
  const { TestNodeNetwork, settle } = await import("./node-network-test-support.js");
  const network = new TestNodeNetwork();
  const command = await network.add("command", { forceRegistration: true });
  const leaf = await network.add("leaf");
  let defaultBranch = "main";
  leaf.commands.set("get_projects", () => [{ id: "p1", name: "One", defaultBranch }]);
  leaf.commands.set("get_environments", () => []);
  await command.service.addNode({
    routes: [{ id: "primary" as never, kind: "https", enabled: true, origin: leaf.origin }],
    token: leaf.token,
  });
  const model = new NodeReadModel({
    nodes: command.service,
    emit: () => undefined,
    fetchImpl: network.fetch,
    reconcileMs: 60_000,
  });
  try {
    await model.start();
    await settle(40);
    expect((await model.summaries()).nodes[0]!.projects[0]!.defaultBranch).toBe("main");
    const before = leaf.received.filter((call) => call.command === "get_projects").length;
    defaultBranch = "develop";
    leaf.emit("resource-changed", { resource: "config", id: "app", revision: 1 });
    await settle(40);
    expect((await model.summaries()).nodes[0]!.projects[0]!.defaultBranch).toBe("develop");
    expect(leaf.received.filter((call) => call.command === "get_projects").length).toBeGreaterThan(
      before,
    );
  } finally {
    model.stop();
  }
});

test("summaries bound aggregate icon bytes even when an older node ignores the flag", async () => {
  const { MAX_SUMMARY_ICON_BYTES } = await import("./project-summary-icons.js");
  const icon = `data:image/png;base64,${"A".repeat(40 * 1024)}`;
  const { model } = searchFieldModel(() =>
    Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, icon })),
  );
  try {
    const self = (await model.summaries(undefined, { includeSelf: true })).self!;
    expect(self.projects).toHaveLength(20);
    const bytes = self.projects.reduce((sum, project) => sum + (project.icon?.length ?? 0), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_SUMMARY_ICON_BYTES);
    expect(bytes).toBeGreaterThan(MAX_SUMMARY_ICON_BYTES - icon.length);
    expect(self.projects[0]!.icon).toBe(icon);
    expect(self.projects.at(-1)!.icon).toBeUndefined();
  } finally {
    model.stop();
  }
});

for (const tooManyEnvironments of [false, true]) {
  test(`oversized persistence ${tooManyEnvironments ? "skips snapshots still over the limit" : "strips icons without changing live state"}`, async () => {
    const { mock } = await import("bun:test");
    const { toNodeProjectSummary } = await import("@orkestrator/protocol/node-summaries");
    const ids = Array.from({ length: 10 }, (_, i) => `bk_${i}` as BackendId);
    const icon = `data:image/png;base64,${"A".repeat(40 * 1024)}`;
    const projects = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
      icon,
    }));
    const save = mock(async (_snapshot: unknown) => {});
    let connected = false;
    const model = new NodeReadModel({
      nodes: {
        selfIdentity: async () => "bk_command" as BackendId,
        selfProfile: async () => ({ displayName: "Command" }),
        listNodes: async () =>
          ({
            nodes: ids.map((nodeId) => ({ nodeId, connection: { state: "connected" } })),
          }) as never,
        link: () => ({
          connected,
          view: { epoch: 1 },
          transport: () => null,
          invoke: async <T>(command: string, args?: Record<string, unknown>) =>
            (command === "get_projects"
              ? projects
              : tooManyEnvironments
                ? Array.from({ length: 80 }, (_, i) => ({
                    id: `e${i}`,
                    projectId: args?.projectId,
                    name: "N".repeat(256),
                    branch: "B".repeat(256),
                    status: "running",
                  }))
                : []) as T,
        }),
        subscribe: () => () => {},
        recordProfile: async () => {},
      },
      emit: () => {},
      persistence: { load: async () => null, save },
    });
    try {
      await model.start();
      connected = true;
      await Promise.all(ids.map((id) => model.requestHydrate(id)));
      const live = (await model.summaries()).nodes;
      expect(live.every((node) => node.projects.every((project) => project.icon === icon))).toBe(
        true,
      );
      model.stop(); // Flushes the scheduled persistence without waiting five seconds.
      await Promise.resolve();
      if (tooManyEnvironments) {
        expect(save).not.toHaveBeenCalled();
      } else {
        expect(save).toHaveBeenCalledTimes(1);
        const snapshot = save.mock.calls[0]![0] as {
          nodes: Array<{ projects: NodeProjectSummary[] }>;
        };
        expect(snapshot.nodes).toHaveLength(10);
        expect(
          snapshot.nodes.every((node) => node.projects.every((project) => !("icon" in project))),
        ).toBe(true);
        expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(snapshot.nodes[0]!.projects[0]).toEqual(
          (({ icon: _icon, ...rest }) => rest)(toNodeProjectSummary(ids[0]!, projects[0]!, 0)!),
        );
      }
      expect(
        (await model.summaries()).nodes.every((node) =>
          node.projects.every((project) => project.icon === icon),
        ),
      ).toBe(true);
    } finally {
      model.stop();
    }
  });
}

test("restored offline node summaries obey the icon budget", async () => {
  const { MAX_SUMMARY_ICON_BYTES } = await import("./project-summary-icons.js");
  const { toNodeProjectSummary } = await import("@orkestrator/protocol/node-summaries");
  const nodeId = "bk_offline" as BackendId;
  const icon = `data:image/png;base64,${"A".repeat(40 * 1024)}`;
  const projects = Array.from({ length: 20 }, (_, i) =>
    toNodeProjectSummary(nodeId, { id: `p${i}`, name: `Project ${i}`, icon }, i)!,
  );
  const model = new NodeReadModel({
    nodes: {
      selfIdentity: async () => "bk_command" as BackendId,
      selfProfile: async () => ({ displayName: "Command" }),
      listNodes: async () =>
        ({ nodes: [{ nodeId, connection: { state: "disconnected" } }] }) as never,
      link: () => null,
      subscribe: () => () => {},
      recordProfile: async () => {},
    },
    emit: () => {},
    persistence: {
      load: async () => ({
        version: 1,
        nodes: [{ nodeId, loadedAt: 1, projects, environments: [] }],
      }),
      save: async () => {},
    },
  });
  try {
    await model.start();
    const restored = (await model.summaries()).nodes[0]!.projects;
    expect(restored).toHaveLength(20);
    expect(
      restored.reduce((bytes, project) => bytes + (project.icon?.length ?? 0), 0),
    ).toBeLessThanOrEqual(MAX_SUMMARY_ICON_BYTES);
    expect(projects.every((project) => project.icon === icon)).toBe(true);
  } finally {
    model.stop();
  }
});

test("a leaf's PR monitor health hint re-reads that project's summaries with the health", async () => {
  const { TestNodeNetwork, settle } = await import("./node-network-test-support.js");
  const network = new TestNodeNetwork();
  const command = await network.add("command", { forceRegistration: true });
  const leaf = await network.add("leaf");
  let confirmed = false;
  const snapshotArgs: Array<Record<string, unknown>> = [];
  leaf.commands.set("get_projects", () => [{ id: "p1", name: "One" }]);
  leaf.commands.set("get_environment_snapshots", (args) => {
    snapshotArgs.push(args);
    return [
      {
        id: "e1",
        projectId: "p1",
        name: "feature",
        status: "running",
        prUrl: "https://github.com/o/r/pull/1",
        prState: "open",
        hasMergeConflicts: false,
        prMergeability: "clean",
        ...(args.includePrMonitorHealth === true && confirmed ? { prMonitorConfirmed: true } : {}),
      },
    ];
  });
  await command.service.addNode({
    routes: [{ id: "primary" as never, kind: "https", enabled: true, origin: leaf.origin }],
    token: leaf.token,
  });
  const model = new NodeReadModel({
    nodes: command.service,
    emit: () => undefined,
    fetchImpl: network.fetch,
    reconcileMs: 60_000,
    refreshDebounceMs: 0,
  });
  try {
    await model.start();
    await settle(40);
    const first = (await model.summaries()).nodes[0]!.environments[0]!;
    expect(first.prMonitorConfirmed).toBeUndefined();
    expect(snapshotArgs.at(-1)).toMatchObject({ projectId: "p1", includePrMonitorHealth: true });

    confirmed = true;
    const reads = snapshotArgs.length;
    leaf.emit("resource-changed", {
      resource: "environment-pr-health",
      id: "e1",
      projectId: "p1",
      revision: 1,
    });
    await settle(40);
    expect(snapshotArgs.length).toBeGreaterThan(reads);
    expect((await model.summaries()).nodes[0]!.environments[0]!.prMonitorConfirmed).toBe(true);
    // The URL stays on the leaf.
    expect(JSON.stringify((await model.summaries()).nodes[0])).not.toContain("github.com");
  } finally {
    model.stop();
  }
});

test("a leaf's agent-mail change re-reads every project for the rows' mail badges", async () => {
  const { TestNodeNetwork, settle } = await import("./node-network-test-support.js");
  const network = new TestNodeNetwork();
  const command = await network.add("command", { forceRegistration: true });
  const leaf = await network.add("leaf");
  let unread = 0;
  const reads: string[] = [];
  leaf.commands.set("get_projects", () => [
    { id: "p1", name: "One" },
    { id: "p2", name: "Two" },
  ]);
  leaf.commands.set("get_environment_snapshots", (args) => {
    reads.push(String(args.projectId));
    return [
      {
        id: `${args.projectId}-env`,
        projectId: args.projectId,
        name: "feature",
        status: "running",
        ...(unread > 0 && args.projectId === "p2" ? { agentMailUnread: unread } : {}),
      },
    ];
  });
  await command.service.addNode({
    routes: [{ id: "primary" as never, kind: "https", enabled: true, origin: leaf.origin }],
    token: leaf.token,
  });
  const model = new NodeReadModel({
    nodes: command.service,
    emit: () => undefined,
    fetchImpl: network.fetch,
    reconcileMs: 60_000,
    refreshDebounceMs: 0,
  });
  try {
    await model.start();
    await settle(40);
    const mailOf = async () =>
      (await model.summaries()).nodes[0]!.environments.find((row) => row.projectId === "p2")
        ?.agentMailUnread;
    expect(await mailOf()).toBeUndefined();

    unread = 3;
    reads.length = 0;
    leaf.emit("resource-changed", { resource: "agent-mail-summary", id: "all", revision: 1 });
    await settle(40);
    expect(reads.sort()).toEqual(["p1", "p2"]);
    expect(await mailOf()).toBe(3);
  } finally {
    model.stop();
  }
});

type ChangeModel = {
  noteChanged(nodeId: BackendId): void;
  stateFor(nodeId: BackendId): unknown;
  requestHydrate(nodeId: BackendId): Promise<void>;
  refreshProjects(nodeId: BackendId, projectIds: string[]): Promise<void>;
};

function changeHarness() {
  let now = 0;
  let name = "before";
  const events: string[] = [];
  const model = new NodeReadModel({
    now: () => now,
    nodes: {
      selfIdentity: async () => "bk_command" as BackendId,
      selfProfile: async () => ({ displayName: "Command" }),
      listNodes: async () => ({ nodes: [] }) as never,
      link: () =>
        ({
          connected: true,
          invoke: async (command: string) =>
            command === "get_projects"
              ? [{ id: "p1", name: "One" }]
              : [{ id: "e1", projectId: "p1", name, status: "running" }],
        }) as never,
      subscribe: () => () => undefined,
      recordProfile: async () => undefined,
    },
    emit: eventSink((event, payload) => {
      if (event === "node-summary-changed") events.push((payload as { nodeId: string }).nodeId);
    }),
    changeMinIntervalMs: 1_000,
  });
  return {
    model,
    changes: model as unknown as ChangeModel,
    events,
    at: (time: number) => {
      now = time;
    },
    rename: () => {
      name = "after";
    },
  };
}

test("summary changes for one node are announced at most once per interval, the last one included", () => {
  const h = changeHarness();
  const batch = installControlledTimeout(50);
  const throttle = installControlledTimeout(1_000);
  const nodeId = "bk_command" as BackendId;
  try {
    h.changes.stateFor(nodeId);
    h.changes.noteChanged(nodeId);
    h.at(50);
    batch.advance();
    for (let index = 0; index < 10; index++) h.changes.noteChanged(nodeId);
    expect(h.events).toEqual([nodeId]);
    expect(throttle.pendingCount()).toBe(1);
    h.at(1_050);
    throttle.advance();
    expect(h.events).toEqual([nodeId, nodeId]);
    batch.assertDrained();
    throttle.assertDrained();
  } finally {
    h.model.stop();
    throttle.restore();
    batch.restore();
  }
});

test("a quiet node moves a busy node's pending timer forward to its batch deadline", () => {
  const h = changeHarness();
  const batch = installControlledTimeout(50);
  const throttle = installControlledTimeout(1_000);
  const remaining = installControlledTimeout(900);
  const busy = "bk_busy" as BackendId;
  const quiet = "bk_quiet" as BackendId;
  try {
    // Hydrated nodes retain their throttle record after an announcement.
    // requestHydrate creates their state, but this test controls only announcements.
    const internals = h.model as unknown as { stateFor(id: BackendId): unknown };
    internals.stateFor(busy);
    internals.stateFor(quiet);
    h.changes.noteChanged(busy);
    h.at(50);
    batch.advance();
    h.changes.noteChanged(busy);
    h.at(100);
    h.changes.noteChanged(quiet);
    expect(throttle.pendingCount()).toBe(0);
    h.at(150);
    batch.advance();
    expect(h.events).toEqual([busy, quiet]);
    h.at(1_050);
    remaining.advance();
    expect(h.events).toEqual([busy, quiet, busy]);
  } finally {
    h.model.stop();
    remaining.restore();
    throttle.restore();
    batch.restore();
  }
});

test("environment refresh announces changed summaries and skips unchanged re-reads", async () => {
  const h = changeHarness();
  const batch = installControlledTimeout(50);
  const throttle = installControlledTimeout(1_000);
  const nodeId = "bk_leaf" as BackendId;
  try {
    h.changes.stateFor(nodeId);
    await h.changes.requestHydrate(nodeId);
    h.at(50);
    batch.advance();
    expect(h.events).toEqual([nodeId]);
    await h.changes.refreshProjects(nodeId, ["p1"]);
    expect(batch.pendingCount() + throttle.pendingCount()).toBe(0);
    expect(h.events).toEqual([nodeId]);
    h.rename();
    await h.changes.refreshProjects(nodeId, ["p1"]);
    expect(throttle.pendingCount()).toBe(1);
    h.at(1_050);
    throttle.advance();
    expect(h.events).toEqual([nodeId, nodeId]);
    await h.changes.refreshProjects(nodeId, ["p1"]);
    expect(batch.pendingCount() + throttle.pendingCount()).toBe(0);
  } finally {
    h.model.stop();
    throttle.restore();
    batch.restore();
  }
});
