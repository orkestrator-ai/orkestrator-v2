import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import type { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
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
