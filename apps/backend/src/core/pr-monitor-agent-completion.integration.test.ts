import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
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
