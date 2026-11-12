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

  function registryWithSessions(sessionIds: string[]) {
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
    registry.set("create_local_terminal_session", createSession);
    registry.set("start_local_terminal_session", startSession);
    registry.set("bootstrap_terminal_session", bootstrap);
    return { launch, createSession, startSession, bootstrap };
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
