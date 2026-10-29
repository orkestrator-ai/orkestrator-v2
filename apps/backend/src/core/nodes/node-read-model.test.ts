import { expect, test } from "bun:test";
import type { NodeProjectSummary } from "@orkestrator/protocol/node-summaries";
import type { BackendId } from "@orkestrator/protocol/federation";
import { recurringDiagnosticsRegistry } from "../recurring-diagnostics.js";
import { NodeReadModel } from "./node-read-model.js";

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
    emit: (event) => {
      events.push(event);
    },
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
