import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type {
  MultiReviewWorkflow,
  MultiReviewModelSelection,
} from "@orkestrator/protocol/multi-review";
import { readProviderStatus, type BuildPipelineProvider } from "./build-pipeline-provider.js";
import type { GraphAgentWiring } from "./graph-agent-wiring.js";
import type { GraphAgentProviders } from "./graph-agent-providers.js";
import type { EnsureNativeAgentSessionInput } from "./native-agent-service-shared.js";
import type { Environment } from "./models.js";
import type { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { claudeStateSignalInstaller } from "./claude-state-signal.js";
import { deferred, flushMicrotasks } from "./recurring-test-support.js";

test("the production backend wires tmux account configuration, signal installation and live login refreshers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ork-backend-wiring-"));
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  let backend: OrkestratorBackend | undefined;
  const support = spyOn(claudeStateSignalInstaller, "support").mockResolvedValue("supported");
  const install = spyOn(claudeStateSignalInstaller, "install").mockResolvedValue(undefined);
  const issueStateSignal = mock(() => ({
    url: "http://example.invalid/signal",
    token: "test-token",
    revoke() {},
  }));
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "host-claude");
    process.env.NODE_ENV = "production";
    backend = new OrkestratorBackend({
      dataDir: path.join(root, "data"),
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      transcriptArtifactRuntime: false,
      agentTools: {
        connection: () => ({ url: "http://example.invalid/tools", token: "test-token" }),
        revokeEnvironment() {},
        async start() {},
        async stop() {},
        issueStateSignal,
      },
    });
    process.env.NODE_ENV = saved.NODE_ENV;
    // Inspect the actual constructor's runtime, rather than supplying replacement runtime options.
    const owner = backend as unknown as {
      runtime: BackendRuntime;
      context: CommandContext;
      claudeLoginKeeper: {
        refreshLocalLoginIfDue(): Promise<void>;
        refreshHostIfDue(): Promise<void>;
        stop(): void;
      } | null;
      codexLoginRefresher: ((home: string) => Promise<void>) | null;
    };
    await owner.context.storage.init();
    const loadAccounts = spyOn(
      owner.context.storage.agentAccounts,
      "loadAgentAccounts",
    ).mockResolvedValue({ version: 1, accounts: [], active: { claude: "account-a" } });
    try {
      expect(await owner.runtime.tmux.localClaudeConfigDirectory(owner.context)).toBe(
        path.join(
          owner.context.storage.agentAccounts.agentAccountsDirectory(),
          "claude",
          "account-a",
        ),
      );
      loadAccounts.mockResolvedValue({ version: 1, accounts: [], active: {} });
      expect(await owner.runtime.tmux.localClaudeConfigDirectory(owner.context)).toBeUndefined();
    } finally {
      loadAccounts.mockRestore();
    }
    const stateRead = deferred<string>();
    const readState = spyOn(
      owner.runtime.tmux.claudeStatePolls as unknown as { readState(id: string): Promise<string> },
      "readState",
    ).mockImplementation(() => stateRead.promise);
    try {
      owner.runtime.tmux.claudeStatePolls.start("container-a", owner.context);
      await flushMicrotasks();
      expect(support).toHaveBeenCalledWith("container-a", owner.context);
      expect(issueStateSignal).toHaveBeenCalledTimes(1);
      expect(install).toHaveBeenCalledWith(
        "container-a",
        issueStateSignal.mock.results[0]!.value,
        owner.context,
        expect.any(Function),
      );
    } finally {
      owner.runtime.tmux.claudeStatePolls.shutdown("container-a");
      stateRead.resolve("");
      await flushMicrotasks();
      readState.mockRestore();
    }

    expect(await owner.runtime.accounts.refreshLocalClaudeLogin()).toBe(false);
    expect(await owner.runtime.accounts.refreshHostClaudeLogin()).toBe(false);
    expect(await owner.runtime.accounts.refreshLocalCodexLogin("home-a")).toBe(false);
    const local = mock(async () => undefined);
    const host = mock(async () => undefined);
    const codex = mock(async (_home: string) => undefined);
    owner.claudeLoginKeeper = { refreshLocalLoginIfDue: local, refreshHostIfDue: host, stop() {} };
    owner.codexLoginRefresher = codex;
    expect(await owner.runtime.accounts.refreshLocalClaudeLogin()).toBe(true);
    expect(await owner.runtime.accounts.refreshHostClaudeLogin()).toBe(true);
    expect(await owner.runtime.accounts.refreshLocalCodexLogin("home-a")).toBe(true);
    expect(local).toHaveBeenCalledTimes(1);
    expect(host).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledWith("home-a");
    await backend.shutdown();
    expect(await owner.runtime.accounts.refreshLocalClaudeLogin()).toBe(false);
    expect(await owner.runtime.accounts.refreshHostClaudeLogin()).toBe(false);
    expect(await owner.runtime.accounts.refreshLocalCodexLogin("home-b")).toBe(false);
    expect(codex).toHaveBeenCalledTimes(1);
  } finally {
    support.mockRestore();
    install.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await backend?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("production services report provider session windows into their owning backend's plan-usage cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ork-plan-usage-wiring-"));
  const backend = new OrkestratorBackend({
    dataDir: root,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    transcriptArtifactRuntime: false,
  });
  // Exercise the real factories without starting bridges or workflow supervisors.
  // Only their external command, storage and HTTP boundaries are faked.
  const owner = backend as unknown as {
    runtime: BackendRuntime;
    context: CommandContext;
    commands: Map<string, CommandHandler>;
    nativeAgents: {
      provider(input: EnsureNativeAgentSessionInput): Promise<BuildPipelineProvider>;
    };
    buildPipelines: { provider(pipeline: BuildPipeline): Promise<BuildPipelineProvider> };
    multiReviews: {
      provider(
        workflow: MultiReviewWorkflow,
        selection: MultiReviewModelSelection,
      ): Promise<BuildPipelineProvider>;
    };
    featurePlanning: { provider(environmentId: string): Promise<BuildPipelineProvider> };
    graphAgents: GraphAgentWiring;
    graphDescribeProviders: GraphAgentProviders;
  };
  const environment = {
    id: "usage-env",
    projectId: "usage-project",
    environmentType: "local",
    status: "running",
    worktreePath: root,
  } as Environment;
  let usedPercent = 0;
  const fetchSnapshot = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        Response.json({
          status: "idle",
          contextUsage: { usedTokens: 1, account: [{ window: "primary", usedPercent }] },
        }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const getEnvironment = spyOn(owner.context.storage, "getEnvironment").mockResolvedValue(
    environment,
  );
  // These fake bridges have no recorded login; admit their "unknown" account
  // so this test isolates dependency wiring from account-selection policy.
  owner.runtime.accounts.planUsage.setActiveAccount("codex", "unknown");
  try {
    await owner.context.storage.init();
    owner.commands.set("start_local_codex_server_cmd", (async () => ({
      port: 12345,
      authToken: "test-token",
    })) as CommandHandler);
    const factories = [
      () =>
        owner.nativeAgents.provider({
          environmentId: environment.id,
          agent: "codex",
          logicalSessionKey: "test",
        }),
      () =>
        owner.buildPipelines.provider({
          id: "build",
          projectId: environment.projectId,
          environmentId: environment.id,
          agentType: "codex",
          sessions: [],
        } as unknown as BuildPipeline),
      () =>
        owner.multiReviews.provider(
          { id: "review", environmentId: environment.id } as MultiReviewWorkflow,
          { agent: "codex", model: "default" } as MultiReviewModelSelection,
        ),
      () => owner.featurePlanning.provider(environment.id),
      () => owner.graphAgents.providers.get(environment, "codex", "activation"),
      () => owner.graphDescribeProviders.get(environment, "codex", "describe"),
    ];
    for (const create of factories) {
      owner.runtime.accounts.planUsage.cache.invalidate("codex");
      usedPercent += 10;
      const provider = await create();
      await readProviderStatus(provider, "session-1");
      expect(owner.runtime.accounts.planUsage.cache.peek("codex")?.windows).toEqual([
        { window: "primary", usedPercent },
      ]);
    }
    expect(fetchSnapshot).toHaveBeenCalledTimes(factories.length);
  } finally {
    getEnvironment.mockRestore();
    fetchSnapshot.mockRestore();
    await backend.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
