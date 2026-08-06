import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import { PR_MONITOR_CHANGED_EVENT } from "@orkestrator/protocol/pr-monitor";
import type {
  BuildPipelineProvider,
  ProviderStatus,
} from "./build-pipeline-provider.js";
import {
  createCommandRegistry,
  shutdownPrMonitorTracking,
  type CommandContext,
} from "./commands.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import {
  NativeAgentService,
  nativeAgentSessionStorageKey,
} from "./native-agent-service.js";
import { StorageService } from "./storage.js";

const PR_URL = "https://github.com/acme/repo/pull/7";

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("agent completion immediately rechecks and clears a resolved conflict", async () => {
  const testRoot = await fs.mkdtemp(
    path.join(tmpdir(), "orkestrator-pr-completion-integration-"),
  );
  const dataDir = path.join(testRoot, "data");
  const worktreePath = path.join(testRoot, "worktree");
  const fakeBinDir = path.join(testRoot, "bin");
  const ghLogPath = path.join(testRoot, "gh.log");
  await Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(worktreePath, { recursive: true }),
    fs.mkdir(fakeBinDir, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(fakeBinDir, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' '{"url":"${PR_URL}","state":"OPEN","mergeable":"MERGEABLE"}'
`,
    { mode: 0o755 },
  );

  const originalPath = process.env.PATH;
  const originalFakeGhLog = process.env.FAKE_GH_LOG;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_GH_LOG = ghLogPath;

  const storage = new StorageService(dataDir);
  let nativeAgents: NativeAgentService | undefined;
  try {
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Environment",
      branch: "feature/conflicts",
      containerId: null,
      status: "running",
      prUrl: PR_URL,
      prState: "open",
      hasMergeConflicts: true,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath,
      setupScriptsComplete: true,
    });

    const commands = createCommandRegistry();
    const context = {
      storage,
      emit: () => undefined,
      appRoot: "",
      resourceRoot: "",
      toolchainBinDir: "",
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    } as CommandContext;
    const invoke = async <T>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<T> => {
      const handler = commands.get(command);
      if (!handler) throw new Error(`Command not registered: ${command}`);
      return await handler(args, context) as T;
    };

    let activity: AgentActivityState = "working";
    const provider = {
      agent: "codex",
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send: async () => undefined,
      status: async () => "idle" as ProviderStatus,
      activity: async () => activity,
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
      dispose: async () => undefined,
    } as unknown as BuildPipelineProvider;
    nativeAgents = new NativeAgentService(storage, invoke, {
      provider: async () => provider,
    });
    context.nativeAgents = nativeAgents;

    const logicalSessionKey = "env-env-1:resolve";
    await storage.adoptNativeAgentSession({
      key: nativeAgentSessionStorageKey("env-1", "codex", logicalSessionKey),
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey,
      providerSessionId: "provider-session",
    });

    await invoke("arm_pr_refresh_after_agent_completion", {
      environmentId: "env-1",
    });
    expect((await storage.getEnvironment("env-1"))
      ?.prRecheckAfterAgentCompletionArmedAt).toEqual(expect.any(String));

    await nativeAgents.reconcileAgentActivity();
    expect(await fs.readFile(ghLogPath, "utf8").catch(() => "")).toBe("");

    activity = "idle";
    await nativeAgents.reconcileAgentActivity();

    await waitForCondition(async () => {
      const environment = await storage.getEnvironment("env-1");
      return environment?.hasMergeConflicts === false
        && environment.prRecheckAfterAgentCompletionArmedAt === undefined;
    }, "the immediate PR recheck to persist mergeability");

    expect(await fs.readFile(ghLogPath, "utf8")).toContain(
      `pr view ${PR_URL} --json url,state,mergeable`,
    );
    expect(await storage.getEnvironment("env-1")).toMatchObject({
      prUrl: PR_URL,
      prState: "open",
      hasMergeConflicts: false,
    });
  } finally {
    await nativeAgents?.shutdown().catch(() => undefined);
    shutdownPrMonitorTracking();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalFakeGhLog === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = originalFakeGhLog;
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

/**
 * The other half of the agent-idle edge: an environment the monitor is *not*
 * polling, because it has neither a stored PR nor a pending mode. Nothing would
 * ever discover a PR the agent opened for itself without this probe, and the
 * alternative — a standing timer per environment — costs a `gh` call per
 * environment per interval forever.
 */
test("an ended agent turn discovers a pull request the agent created itself", async () => {
  await withProbeHarness(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' '[{"url":"${PR_URL}","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-08-06T10:00:00Z"}]'
`,
    async ({ storage, invoke, events, ghLog }) => {
      const before = await storage.getEnvironment("env-1");
      expect(before?.prUrl).toBeNull();

      await invoke("pr_monitor_probe_environment", { environmentId: "env-1" });

      await waitForCondition(
        async () => (await storage.getEnvironment("env-1"))?.prUrl === PR_URL,
        "the probe to persist the PR the agent created",
      );
      expect(await ghLog()).toContain(
        "pr list --head feature/agent-created --state all",
      );
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        prUrl: PR_URL,
        prState: "open",
        hasMergeConflicts: false,
      });
      // A found PR is announced, so a client that was never mounted for this
      // environment still learns about it.
      expect(events.filter((event) => event.event === PR_MONITOR_CHANGED_EVENT))
        .not.toHaveLength(0);
    },
  );
});

test("a probe that finds no pull request leaves no monitor entry and says nothing", async () => {
  await withProbeHarness(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' '[]'
`,
    async ({ storage, invoke, events, ghLog }) => {
      await invoke("pr_monitor_probe_environment", { environmentId: "env-1" });

      await waitForCondition(
        async () => (await ghLog()).includes("pr list --head feature/agent-created"),
        "the probe to run its single discovery call",
      );
      // Let the discovery result be applied and the provisional entry retired.
      await Bun.sleep(100);
      // One call, not a standing poller: an idle agent with no PR must not
      // leave a `gh` timer behind.
      expect((await ghLog()).trim().split("\n")).toHaveLength(1);
      // The entry was never announced, so its silent retirement must not
      // announce anything either: one flashed monitor entry per idle agent is
      // exactly what the probe exists to avoid.
      expect(events.filter((event) => event.event === PR_MONITOR_CHANGED_EVENT))
        .toEqual([]);
      expect(await storage.getEnvironment("env-1")).toMatchObject({ prUrl: null });
    },
  );
});

/**
 * Registry, storage, and a fake `gh` on PATH for the probe tests. Kept separate
 * from the armed-completion test above, which needs a native agent service to
 * produce its edge; the probe is driven straight from the command registry
 * because `index.test.ts` owns the proof that the activity edge reaches it.
 */
async function withProbeHarness(
  ghScript: string,
  run: (harness: {
    storage: StorageService;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    events: Array<{ event: string; payload: unknown }>;
    ghLog: () => Promise<string>;
  }) => Promise<void>,
): Promise<void> {
  const testRoot = await fs.mkdtemp(
    path.join(tmpdir(), "orkestrator-pr-probe-integration-"),
  );
  const dataDir = path.join(testRoot, "data");
  const worktreePath = path.join(testRoot, "worktree");
  const fakeBinDir = path.join(testRoot, "bin");
  const ghLogPath = path.join(testRoot, "gh.log");
  await Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(worktreePath, { recursive: true }),
    fs.mkdir(fakeBinDir, { recursive: true }),
  ]);
  await fs.writeFile(path.join(fakeBinDir, "gh"), ghScript, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalFakeGhLog = process.env.FAKE_GH_LOG;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_GH_LOG = ghLogPath;

  const storage = new StorageService(dataDir);
  try {
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Environment",
      branch: "feature/agent-created",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath,
      setupScriptsComplete: true,
    });

    const events: Array<{ event: string; payload: unknown }> = [];
    const commands = createCommandRegistry();
    const context = {
      storage,
      emit: (event: string, payload: unknown) => events.push({ event, payload }),
      appRoot: "",
      resourceRoot: "",
      toolchainBinDir: "",
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    } as CommandContext;
    const invoke = async <T>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<T> => {
      const handler = commands.get(command);
      if (!handler) throw new Error(`Command not registered: ${command}`);
      return await handler(args, context) as T;
    };

    await run({
      storage,
      invoke,
      events,
      ghLog: () => fs.readFile(ghLogPath, "utf8").catch(() => ""),
    });
  } finally {
    shutdownPrMonitorTracking();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalFakeGhLog === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = originalFakeGhLog;
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}
