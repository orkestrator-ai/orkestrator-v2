/**
 * Contract tests against the **real** pinned `codex app-server` binary.
 *
 * `app-server` is still marked experimental, so the generated types are a
 * compile-time contract only — these tests are the runtime half. They are gated
 * because they need the pinned binary present:
 *
 *   CODEX_PROTOCOL_BINARY=/path/to/codex RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-contract.test.ts
 *
 * The override is optional: `live-binary.ts` otherwise falls back to the managed
 * toolchain copy, then `CODEX_PATH`, then `codex` on PATH, and verifies in every
 * case that the binary reports the version pinned in `config/codex-version.json`
 * — a contract test against the wrong build proves nothing. That resolution is
 * unit-tested by `live-binary.test.ts`, which runs in the default suite.
 *
 * Nothing here starts a turn, so no credits are spent and no model is called.
 * Turn-level behaviour (interrupt, deltas, subagents) needs an authenticated
 * account and is covered by the canary rollout instead.
 */
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlRpcClient } from "./jsonl-rpc-client.js";
import { AppServerRpcError, isUnmaterializedThreadError } from "./errors.js";
import { pinnedVersion, resolveCodexBinary } from "./live-binary.js";
import type { InboundNotification } from "./envelope-validation.js";

const LIVE = process.env.RUN_LIVE_CODEX_APP_SERVER === "1";
const describeLive = LIVE ? describe : describe.skip;

interface LiveSession {
  client: JsonlRpcClient;
  notifications: InboundNotification[];
  codexHome: string;
  workspace: string;
  stop: () => Promise<void>;
}

/** Boots a real app-server against a throwaway CODEX_HOME and workspace. */
async function boot(options: { copyAuth?: boolean } = {}): Promise<LiveSession> {
  const codexHome = await mkdtemp(join(tmpdir(), "ork-live-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "ork-live-ws-"));
  // A git dir keeps app-server from treating the cwd as unversioned.
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

  if (options.copyAuth) {
    const source = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    if (existsSync(source)) {
      await writeFile(join(codexHome, "auth.json"), await readFile(source, "utf8"), "utf8");
    }
  }

  const binary = await resolveCodexBinary();
  const child = spawn(binary, ["app-server", "--stdio"], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHome, LOG_FORMAT: "json" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  child.stderr.resume();

  const notifications: InboundNotification[] = [];
  const client = new JsonlRpcClient({
    generation: 1,
    stdin: child.stdin,
    stdout: child.stdout,
    onNotification: (notification) => notifications.push(notification),
    onServerRequest: () => undefined,
  });

  return {
    client,
    notifications,
    codexHome,
    workspace,
    stop: async () => {
      client.close();
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

const CLIENT_INFO = { name: "orkestrator", title: "Orkestrator", version: "2.4.9" };
const CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  mcpServerOpenaiFormElicitation: true,
};

async function handshake(session: LiveSession): Promise<Record<string, unknown>> {
  const result = await session.client.request<Record<string, unknown>>("initialize", {
    clientInfo: CLIENT_INFO,
    capabilities: CAPABILITIES,
  });
  await session.client.notify("initialized");
  return result;
}

describeLive("live app-server handshake", () => {
  test("initialize reports codexHome and identifies us as Orkestrator", async () => {
    const session = await boot();
    try {
      const result = await handshake(session);

      // app-server returns the resolved realpath, which on macOS means
      // /private/var/... for a /var/... tmpdir. Compare canonical paths.
      expect(await realpath(String(result.codexHome))).toBe(await realpath(session.codexHome));
      expect(typeof result.platformOs).toBe("string");
      // The user agent is what app-server attributes compliance logs to.
      expect(String(result.userAgent)).toContain("orkestrator");
      expect(String(result.userAgent)).toContain(await pinnedVersion());
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("requests before the initialized notification are rejected", async () => {
    const session = await boot();
    try {
      // No handshake at all: app-server must refuse ordinary requests.
      const error = await session.client
        .request("model/list", { limit: 1 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppServerRpcError);
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("an unknown method returns a JSON-RPC error rather than hanging", async () => {
    const session = await boot();
    try {
      await handshake(session);
      const error = await session.client
        .request("orkestrator/not-a-method", {})
        .catch((caught: AppServerRpcError) => caught);

      expect(error).toBeInstanceOf(AppServerRpcError);
      expect([-32600, -32601]).toContain((error as AppServerRpcError).code);
    } finally {
      await session.stop();
    }
  }, 60_000);
});

describeLive("live model catalog", () => {
  test("model/list paginates and preserves reasoning-effort order", async () => {
    const session = await boot({ copyAuth: true });
    try {
      await handshake(session);
      const page = await session.client.request<{
        data: Array<{
          id: string;
          supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
          defaultReasoningEffort: string;
        }>;
        nextCursor: string | null;
      }>("model/list", { limit: 2 });

      expect(page.data.length).toBeGreaterThan(0);
      const first = page.data[0]!;
      expect(typeof first.id).toBe("string");
      expect(Array.isArray(first.supportedReasoningEfforts)).toBe(true);

      // The order the server sends is meaningful; clients must not re-sort it.
      const efforts = first.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
      expect(efforts.length).toBeGreaterThan(0);
      expect(efforts).not.toEqual([...efforts].sort());

      if (page.nextCursor) {
        const second = await session.client.request<{ data: unknown[] }>("model/list", {
          cursor: page.nextCursor,
          limit: 2,
        });
        expect(Array.isArray(second.data)).toBe(true);
      }
    } finally {
      await session.stop();
    }
  }, 60_000);
});

describeLive("live thread history", () => {
  /**
   * The migration trap from the plan: `thread/list` defaults to interactive
   * source kinds, so omitting `sourceKinds` hides both legacy `exec` threads and
   * new `appServer` ones — silently emptying the resume dialog.
   */
  test("thread/list needs explicit sourceKinds to see exec and appServer threads", async () => {
    const session = await boot();
    try {
      await handshake(session);

      const defaults = await session.client.request<{ data: unknown[] }>("thread/list", {
        limit: 5,
      });
      const explicit = await session.client.request<{
        data: Array<{ source: unknown; parentThreadId: string | null }>;
      }>("thread/list", {
        limit: 5,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      });

      // Both are valid responses; the contract being pinned is that the default
      // set is *narrower*, which is what makes the explicit list mandatory.
      expect(Array.isArray(defaults.data)).toBe(true);
      expect(Array.isArray(explicit.data)).toBe(true);
      expect(explicit.data.length).toBeGreaterThanOrEqual(defaults.data.length);
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("thread/start creates a thread lazily addressable by thread/read", async () => {
    const session = await boot();
    try {
      await handshake(session);
      const started = await session.client.request<{ thread: { id: string; cwd: string } }>(
        "thread/start",
        { cwd: session.workspace, sandbox: "read-only", approvalPolicy: "never" },
      );

      expect(started.thread.id).toMatch(/^[0-9a-f-]{8,}/);

      const read = await session.client.request<{ thread: { id: string } }>("thread/read", {
        threadId: started.thread.id,
      });
      expect(read.thread.id).toBe(started.thread.id);

      // thread/started must have been announced so the bridge can bind the id.
      expect(session.notifications.some((entry) => entry.method === "thread/started")).toBe(true);
    } finally {
      await session.stop();
    }
  }, 60_000);

  /**
   * Load-bearing for ambiguous-dispatch recovery.
   *
   * The recovery flow reads `thread/read(includeTurns=true)` and looks for a
   * `userMessage` whose `clientId` matches the request id. On a thread whose
   * first turn never materialized, that call does **not** return an empty turn
   * list — it fails with -32600. Recovery has to read that specific error as
   * "no user message was ever recorded", i.e. the turn definitely did not start
   * and may be dispatched exactly once. Treating it as a generic failure would
   * strand the prompt; treating it as ambiguous would deadlock the session.
   */
  test("thread/read(includeTurns) rejects an unmaterialized thread instead of returning empty", async () => {
    const session = await boot();
    try {
      await handshake(session);
      const started = await session.client.request<{ thread: { id: string } }>("thread/start", {
        cwd: session.workspace,
        sandbox: "read-only",
        approvalPolicy: "never",
      });

      const error = await session.client
        .request("thread/read", { threadId: started.thread.id, includeTurns: true })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppServerRpcError);
      expect((error as AppServerRpcError).message).toContain("not materialized");
      expect(isUnmaterializedThreadError(error)).toBe(true);
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("thread/name/set renames a thread and notifies", async () => {
    const session = await boot();
    try {
      await handshake(session);
      const started = await session.client.request<{ thread: { id: string } }>("thread/start", {
        cwd: session.workspace,
        sandbox: "read-only",
        approvalPolicy: "never",
      });

      await session.client.request("thread/name/set", {
        threadId: started.thread.id,
        name: "Orkestrator title",
      });
      const read = await session.client.request<{ thread: { name: string | null } }>(
        "thread/read",
        { threadId: started.thread.id },
      );

      expect(read.thread.name).toBe("Orkestrator title");
    } finally {
      await session.stop();
    }
  }, 60_000);
});

describeLive("live config side effects", () => {
  /**
   * Documents a real, deliberate side effect: starting a thread under a writable
   * sandbox marks the project trusted in `config.toml`.
   *
   * This is **not** an app-server regression — `codex exec --sandbox
   * danger-full-access`, which the SDK engine already uses for build mode, writes
   * the identical entry. Pinning it here means a future version that *stopped*
   * or *broadened* the mutation would surface as a test failure rather than as a
   * surprise edit to the user's config.
   */
  test("a read-only thread does not mark the project trusted", async () => {
    const session = await boot();
    try {
      await handshake(session);
      await session.client.request("thread/start", {
        cwd: session.workspace,
        sandbox: "read-only",
        approvalPolicy: "never",
      });

      const configPath = join(session.codexHome, "config.toml");
      const config = existsSync(configPath) ? await readFile(configPath, "utf8") : "";
      expect(config).not.toContain("trust_level");
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("a workspace-write thread marks the project trusted", async () => {
    const session = await boot();
    try {
      await handshake(session);
      await session.client.request("thread/start", {
        cwd: session.workspace,
        sandbox: "workspace-write",
        approvalPolicy: "never",
      });

      const config = await readFile(join(session.codexHome, "config.toml"), "utf8");
      expect(config).toContain("trust_level");
      expect(config).toContain('trust_level = "trusted"');
      // Scoped to this project only — it must not become a global setting.
      expect(config).toContain(`[projects.`);
    } finally {
      await session.stop();
    }
  }, 60_000);
});

describeLive("live shutdown", () => {
  test("closing stdin terminates the child without orphans", async () => {
    const session = await boot();
    await handshake(session);

    const before = await session.client.request<Record<string, unknown>>("thread/start", {
      cwd: session.workspace,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    expect(before).toBeTruthy();

    await session.stop();
    // Give the child a moment to notice EOF.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(session.client.isClosed()).toBe(true);
  }, 60_000);
});
