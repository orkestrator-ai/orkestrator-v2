/**
 * Project resources against the **real** pinned `codex app-server` binary.
 *
 * A session whose policy turns project resources off must not load the
 * checkout's own Codex configuration, even when the user trusts the project
 * in Codex. These tests point Codex at a loopback Responses endpoint and read
 * what the model would have been given from the request, and point the
 * project's MCP server at a loopback that counts connections, so they prove
 * what reaches the model without calling one or spending credits. Gated like
 * the other live contract tests because they need the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-project-trust.test.ts
 *
 * The first test is the control: with project resources on, every canary
 * arrives, so a probe that saw nothing cannot pass the others by accident.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineTurnConfig } from "../engine/types.js";
import { resolveCodexBinary } from "./live-binary.js";

// See `live-contract.test.ts`: the test preload replaces `Response`, and
// `Bun.serve` only accepts its own.
const NATIVE_WEB_PLATFORM_KEY = Symbol.for("orkestrator.tests.native-web-platform");
const NativeResponse =
  (globalThis as typeof globalThis & { [key: symbol]: { Response?: typeof Response } | undefined })[
    NATIVE_WEB_PLATFORM_KEY
  ]?.Response ?? Response;

const LIVE = process.env.RUN_LIVE_CODEX_APP_SERVER === "1";
const describeLive = LIVE ? describe : describe.skip;

const CLIENT_INFO = { name: "orkestrator", title: "Orkestrator", version: "2.4.9" };

/** One marker per project resource, each placed where only that resource can carry it. */
const CANARY = {
  configLayer: "PROJECT-CONFIG-LAYER-CANARY",
  agentsMd: "PROJECT-AGENTS-MD-CANARY",
  codexSkill: "PROJECT-CODEX-SKILL-CANARY",
  agentsSkill: "PROJECT-AGENTS-SKILL-CANARY",
} as const;

function policy(projectResources: boolean): NativeAgentExecutionPolicy {
  return {
    id: "interactive-host",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources,
    networkAccess: "full",
  };
}

interface Fixture {
  codexHome: string;
  /** The checkout the thread runs in. */
  workspace: string;
  /** Connections the project's MCP server received. */
  mcpConnections: () => number;
  frames: Record<string, unknown>[];
  baseUrl: string;
  stop: () => Promise<void>;
}

/**
 * A throwaway CODEX_HOME with a placeholder key, and a git checkout carrying a
 * project config layer, an AGENTS.md and two project skills. `trusted` names
 * the checkout the user's Codex config trusts: the workspace itself, or, for a
 * linked worktree, its main checkout.
 */
async function fixture(options: { worktree?: boolean } = {}): Promise<Fixture> {
  const codexHome = await mkdtemp(join(tmpdir(), "ork-trust-home-"));
  const root = await realpath(await mkdtemp(join(tmpdir(), "ork-trust-repo-")));
  const main = join(root, "main");
  await mkdir(main);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git(main, "init", "-q", "-b", "main");

  let connections = 0;
  const mcp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      connections += 1;
      return new NativeResponse("not served", { status: 500 });
    },
  });
  await mkdir(join(main, ".codex", "skills", "codex-canary"), { recursive: true });
  await mkdir(join(main, ".agents", "skills", "agents-canary"), { recursive: true });
  await writeFile(
    join(main, ".codex", "config.toml"),
    `developer_instructions = "${CANARY.configLayer}"\n\n` +
      `[mcp_servers.project-canary]\nurl = "http://127.0.0.1:${mcp.port}/mcp"\n`,
  );
  await writeFile(join(main, "AGENTS.md"), `${CANARY.agentsMd}\n`);
  await writeFile(
    join(main, ".codex", "skills", "codex-canary", "SKILL.md"),
    `---\nname: codex-canary\ndescription: ${CANARY.codexSkill}\n---\nUnused.\n`,
  );
  await writeFile(
    join(main, ".agents", "skills", "agents-canary", "SKILL.md"),
    `---\nname: agents-canary\ndescription: ${CANARY.agentsSkill}\n---\nUnused.\n`,
  );
  git(main, "add", ".");
  git(main, "-c", "user.email=probe@example.com", "-c", "user.name=probe", "commit", "-qm", "init");
  let workspace = main;
  if (options.worktree) {
    workspace = join(root, "worktree");
    git(main, "worktree", "add", "-q", workspace);
  }
  // The user trusts the main checkout, which a linked worktree inherits.
  await writeFile(
    join(codexHome, "config.toml"),
    `[projects.${JSON.stringify(main)}]\ntrust_level = "trusted"\n`,
  );
  // Never a real key: the only server it can reach is the loopback fake.
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    { mode: 0o600 },
  );

  // Codex opens the Responses API as a WebSocket and sends each request as one
  // `response.create` frame; closing the socket fails the turn.
  const frames: Record<string, unknown>[] = [];
  const responses = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request)) {
        return undefined;
      }
      return new NativeResponse("not served", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        try {
          const frame = JSON.parse(String(message)) as Record<string, unknown>;
          if (frame.type === "response.create") frames.push(frame);
        } catch {
          // Only the request frame matters.
        }
        socket.close(1011, "recorded");
      },
    },
  });
  return {
    codexHome,
    workspace,
    mcpConnections: () => connections,
    frames,
    baseUrl: `http://127.0.0.1:${responses.port}/v1`,
    stop: async () => {
      await responses.stop(true);
      await mcp.stop(true);
    },
  };
}

/**
 * Runs one turn and returns the model request that carries its prompt. Codex
 * may send a prewarm request without the conversation first, so the frame is
 * found by the prompt's own marker rather than by position.
 */
async function turnRequest(
  engine: AppServerEngine,
  setup: Fixture,
  handle: string,
  config: EngineTurnConfig,
  marker: string,
): Promise<string> {
  const turn = await engine.startTurn({ handle, input: [{ type: "text", text: marker }], config });
  const deadline = Date.now() + 60_000;
  let found: string | undefined;
  while (!found && Date.now() < deadline) {
    found = setup.frames
      .map((frame) => JSON.stringify(frame))
      .find((text) => text.includes(marker));
    if (!found) await Bun.sleep(100);
  }
  // Stop Codex retrying the closed socket before the thread is reloaded.
  await engine.interruptTurn(handle, turn.turnId).catch(() => undefined);
  await engine.waitForTurnTerminal(handle, turn.turnId, { timeoutMs: 30_000 });
  if (!found) throw new Error(`Timed out waiting for the model request carrying ${marker}`);
  return found;
}

function canariesIn(request: string): string[] {
  return Object.values(CANARY).filter((canary) => request.includes(canary));
}

function engineFor(setup: Fixture, codexPath: string): AppServerEngine {
  return new AppServerEngine({
    codexPath,
    cwd: setup.workspace,
    codexHome: setup.codexHome,
    clientInfo: CLIENT_INFO,
    configOverrides: { openai_base_url: JSON.stringify(setup.baseUrl) },
    supervisorOverrides: { pidFileEnabled: false },
  });
}

describeLive("live project resources", () => {
  test("a trusted project's resources all reach a session that allows them (control)", async () => {
    const setup = await fixture();
    const engine = engineFor(setup, await resolveCodexBinary());
    const config: EngineTurnConfig = {
      mode: "build",
      cwd: setup.workspace,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      policy: policy(true),
    };
    try {
      await engine.start();
      const thread = await engine.startThread({ config });
      const request = await turnRequest(engine, setup, thread.handle, config, "TURN-CONTROL");
      expect(canariesIn(request).sort()).toEqual(Object.values(CANARY).sort());
      expect(setup.mcpConnections()).toBeGreaterThan(0);
    } finally {
      await engine.stop();
      await setup.stop();
    }
  }, 180_000);

  test("project resources off keeps a trusted project's resources out, after a reload too", async () => {
    const setup = await fixture();
    const engine = engineFor(setup, await resolveCodexBinary());
    const config: EngineTurnConfig = {
      mode: "build",
      cwd: setup.workspace,
      // A writable thread is what would otherwise mark the project trusted.
      sandbox: "workspace-write",
      approvalPolicy: "never",
      policy: policy(false),
    };
    const userConfig = await readFile(join(setup.codexHome, "config.toml"), "utf8");
    try {
      await engine.start();
      const thread = await engine.startThread({ config });
      const first = await turnRequest(engine, setup, thread.handle, config, "TURN-FIRST");
      expect(canariesIn(first)).toEqual([]);

      // A reload rebuilds the thread from its rollout with the same settings.
      const reloaded = await engine.reloadThread(thread.handle, { config });
      const second = await turnRequest(engine, setup, reloaded.handle, config, "TURN-RELOADED");
      expect(canariesIn(second)).toEqual([]);

      // The project's MCP server was never started, and the user's own trust
      // settings were left as they were.
      expect(setup.mcpConnections()).toBe(0);
      expect(await readFile(join(setup.codexHome, "config.toml"), "utf8")).toBe(userConfig);
    } finally {
      await engine.stop();
      await setup.stop();
    }
  }, 180_000);

  test("new repository skills are excluded after a skills change and reload", async () => {
    const setup = await fixture();
    const engine = engineFor(setup, await resolveCodexBinary());
    const config: EngineTurnConfig = {
      mode: "build",
      cwd: setup.workspace,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      policy: policy(false),
    };
    const canary = "NEW-REPOSITORY-SKILL-CANARY";
    let changed = false;
    const unsubscribe = engine.subscribe((event) => {
      if (event.kind === "skills.changed") changed = true;
    });
    try {
      await engine.start();
      const thread = await engine.startThread({ config });
      await turnRequest(engine, setup, thread.handle, config, "TURN-BEFORE-NEW-SKILL");
      const dir = join(setup.workspace, ".agents", "skills", "new-canary");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: new-canary\ndescription: ${canary}\n---\nUnused.\n`,
      );
      const deadline = Date.now() + 10_000;
      while (!changed && Date.now() < deadline) await Bun.sleep(100);
      expect(changed).toBe(true);
      const reloaded = await engine.reloadThread(thread.handle, { config });
      const request = await turnRequest(
        engine,
        setup,
        reloaded.handle,
        config,
        "TURN-AFTER-NEW-SKILL",
      );
      expect(request).not.toContain(canary);
      expect(canariesIn(request)).toEqual([]);
    } finally {
      unsubscribe();
      await engine.stop();
      await setup.stop();
    }
  }, 180_000);

  test("pinning a linked worktree wins over its trusted main checkout", async () => {
    const setup = await fixture({ worktree: true });
    const engine = engineFor(setup, await resolveCodexBinary());
    const config: EngineTurnConfig = {
      mode: "build",
      cwd: setup.workspace,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      policy: policy(false),
    };
    try {
      await engine.start();
      const thread = await engine.startThread({ config });
      const request = await turnRequest(engine, setup, thread.handle, config, "TURN-WORKTREE");
      expect(canariesIn(request)).toEqual([]);
      expect(setup.mcpConnections()).toBe(0);
    } finally {
      await engine.stop();
      await setup.stop();
    }
  }, 180_000);
});
