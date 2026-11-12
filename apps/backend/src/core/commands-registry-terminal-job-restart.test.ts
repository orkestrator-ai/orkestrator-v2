import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { StorageService } from "./storage.js";

// `launch_terminal_job` without `data`: Reconnect on a launched tab whose shell
// went away with a backend restart asks for a new shell in the same tab. The
// renderer may not create a PTY for these tabs itself.
describe("launch_terminal_job without data", () => {
  let dataDir: string;
  let storage: StorageService;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-terminal-job-restart-"));
    storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Ready environment",
      branch: "main",
      containerId: null,
      status: "running",
      setupPhase: "ready",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function registryWithSessions(sessionIds: string[], { container = false } = {}) {
    const registry = createCommandRegistry();
    const launch = registry.get("launch_terminal_job");
    if (!launch) throw new Error("launch_terminal_job was not registered");
    let next = 0;
    const createSession = mock(async () => ({
      sessionId: sessionIds[next++] ?? "unexpected-session",
      created: true,
      bootstrapped: false,
    }));
    const startSession = mock(async () => undefined);
    const bootstrap = mock(async () => ({ bootstrapped: true, delivered: true, duplicate: false }));
    const unexpected = mock(async () => {
      throw new Error("the other environment type's terminal commands were used");
    });
    registry.set(
      container ? "create_terminal_session" : "create_local_terminal_session",
      createSession,
    );
    registry.set(
      container ? "start_terminal_session" : "start_local_terminal_session",
      startSession,
    );
    registry.set(
      container ? "create_local_terminal_session" : "create_terminal_session",
      unexpected,
    );
    registry.set(container ? "start_local_terminal_session" : "start_terminal_session", unexpected);
    registry.set("bootstrap_terminal_session", bootstrap);
    return { launch, createSession, startSession, bootstrap, unexpected };
  }

  async function launchRunCommands(
    launch: ReturnType<typeof registryWithSessions>["launch"],
    context: CommandContext,
    environmentId = "env-1",
  ) {
    return (await launch(
      {
        requestId: "run-commands-1",
        environmentId,
        tabType: "plain",
        title: "Run Commands",
        data: "bun test\n",
      },
      context,
    )) as { tabId: string };
  }

  test("starts a shell that runs nothing in the existing tab and publishes its id", async () => {
    const { launch, startSession, bootstrap } = registryWithSessions([
      "session-before-restart",
      "session-after-restart",
    ]);
    const context = { storage } as unknown as CommandContext;
    const first = (await launch(
      {
        requestId: "run-commands-1",
        environmentId: "env-1",
        tabType: "plain",
        title: "Run Commands",
        data: "bun test\n",
      },
      context,
    )) as { tabId: string };
    // What a backend restart does to the pane before any renderer hydrates it.
    await storage.clearBackendTerminalSessionIds("env-1");
    bootstrap.mockClear();

    const restarted = (await launch(
      {
        requestId: "restart-shell-1",
        environmentId: "env-1",
        tabId: first.tabId,
        tabType: "plain",
      },
      context,
    )) as Record<string, unknown>;

    expect(restarted).toMatchObject({
      tabId: first.tabId,
      sessionId: "session-after-restart",
      status: "started",
    });
    expect(startSession).toHaveBeenLastCalledWith({ sessionId: "session-after-restart" }, context);
    // No command is written into the new shell; Run Commands is not repeated.
    expect(bootstrap).not.toHaveBeenCalled();
    const layout = await storage.getPaneLayout("env-1");
    expect(layout?.root).toMatchObject({
      kind: "leaf",
      tabs: [
        {
          id: first.tabId,
          type: "plain",
          displayTitle: "Run Commands",
          backendManagedTerminal: true,
          backendTerminalSessionId: "session-after-restart",
        },
      ],
    });
  });

  test("reuses an exited shell's stable session id without running anything", async () => {
    // The shell exited while this backend kept running: the runtime keeps the
    // tab's stable session, so the restart reopens it under the same id.
    const { launch, createSession, bootstrap } = registryWithSessions([
      "stable-session",
      "stable-session",
    ]);
    const context = { storage } as unknown as CommandContext;
    const first = await launchRunCommands(launch, context);
    bootstrap.mockClear();

    const restarted = (await launch(
      {
        requestId: "restart-shell-1",
        environmentId: "env-1",
        tabId: first.tabId,
        tabType: "plain",
      },
      context,
    )) as Record<string, unknown>;

    expect(restarted).toMatchObject({ tabId: first.tabId, sessionId: "stable-session" });
    expect(createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminalKey: first.tabId }),
      context,
    );
    expect(bootstrap).not.toHaveBeenCalled();
    const layout = await storage.getPaneLayout("env-1");
    expect(layout?.root).toMatchObject({
      tabs: [{ id: first.tabId, backendTerminalSessionId: "stable-session" }],
    });
  });

  test("restarts a container environment's shell through the container commands", async () => {
    await storage.addEnvironment({
      id: "env-container",
      projectId: "project-1",
      name: "Container environment",
      branch: "main",
      containerId: "container-1",
      status: "running",
      setupPhase: "ready",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 1,
      environmentType: "containerized",
    });
    const { launch, createSession, startSession, bootstrap, unexpected } = registryWithSessions(
      ["container-before", "container-after"],
      { container: true },
    );
    const context = { storage } as unknown as CommandContext;
    const first = await launchRunCommands(launch, context, "env-container");
    await storage.clearBackendTerminalSessionIds("env-container");
    bootstrap.mockClear();

    const restarted = (await launch(
      {
        requestId: "restart-shell-1",
        environmentId: "env-container",
        tabId: first.tabId,
        tabType: "plain",
      },
      context,
    )) as Record<string, unknown>;

    expect(restarted).toMatchObject({ tabId: first.tabId, sessionId: "container-after" });
    expect(createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerId: "container-1", terminalKey: first.tabId }),
      context,
    );
    expect(startSession).toHaveBeenLastCalledWith({ sessionId: "container-after" }, context);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalled();
    const layout = await storage.getPaneLayout("env-container");
    expect(layout?.root).toMatchObject({
      tabs: [{ id: first.tabId, backendTerminalSessionId: "container-after" }],
    });
  });

  test("refuses to restart a tab the user has closed, without recreating it", async () => {
    const { launch, createSession } = registryWithSessions(["session-before-restart"]);
    const context = { storage } as unknown as CommandContext;
    const first = await launchRunCommands(launch, context);
    const opened = await storage.getPaneLayout("env-1");
    if (!opened) throw new Error("the launch did not publish a layout");
    // The user closes the tab while a restart request is still in flight.
    await storage.savePaneLayout(
      "env-1",
      {
        version: opened.version,
        containerId: opened.containerId,
        activePaneId: opened.activePaneId,
        root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
      },
      opened.revision,
    );
    createSession.mockClear();

    await expect(
      launch(
        {
          requestId: "restart-shell-1",
          environmentId: "env-1",
          tabId: first.tabId,
          tabType: "plain",
        },
        context,
      ),
    ).rejects.toThrow(`Terminal tab no longer exists: ${first.tabId}`);
    expect(createSession).not.toHaveBeenCalled();
    const layout = await storage.getPaneLayout("env-1");
    expect(layout?.root).toMatchObject({ tabs: [] });
  });

  test("still requires data for a job with no tab to restart", async () => {
    const { launch, createSession } = registryWithSessions(["session-1"]);
    const context = { storage } as unknown as CommandContext;

    await expect(
      launch({ requestId: "job-1", environmentId: "env-1", tabType: "plain" }, context),
    ).rejects.toThrow("data is required for a new terminal job");
    expect(createSession).not.toHaveBeenCalled();
    expect(await storage.getPaneLayout("env-1")).toBeNull();
  });
});
