import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { AGENT_TEST_ANTHROPIC_ORIGIN_ENV } from "./agent-test-fixtures.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import * as commandFiles from "./commands-files.js";
import { stopLocalServerUnlocked } from "./commands-local-server-lifecycle.js";
import { startLocalServerUnlocked } from "./commands-servers.js";
import { CoordinatorService } from "./coordinator-service.js";
import { runCommand } from "./shell.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

/**
 * The bridge launch side of `ORKESTRATOR_AGENT_TEST_ANTHROPIC_ORIGIN`
 * (to-do 7542 (retired)): `startLocalServerAttempt` points every Claude
 * bridge of an isolated agent-test backend, workers and coordinators alike,
 * at the loopback model, after the account environment so nothing inherited
 * or account-derived sends the CLI elsewhere, and never touches another
 * platform's bridge or a production backend's. The gate itself is unit-tested
 * in `plan-usage/agent-test-origin.test.ts`; this file proves the wiring.
 */

const ORIGIN = "http://127.0.0.1:43124";
const INHERITED_BASE_URL = "https://inherited.example.invalid";

/** A fake bridge that records the launch environment it was given, then serves health. */
const CAPTURING_BRIDGE = `
await Bun.write(import.meta.dir + "/captured.json", JSON.stringify({
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  nonessential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
}));
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`;

const SAVED_ENV = [
  "ORKESTRATOR_AGENT_TEST_ISOLATED",
  AGENT_TEST_ANTHROPIC_ORIGIN_ENV,
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_BRIDGE_STATE_DIR",
] as const;

type Kind = "claude" | "codex";

describe("agent-test Anthropic origin at bridge launch", () => {
  let root: string;
  let checkout: string;
  let storage: StorageService;
  let saved: Array<readonly [string, string | undefined]> = [];
  let started: Array<{ runtimeId: string; context: CommandContext; kind: Kind }> = [];
  const runtimes: BackendRuntime[] = [];
  let hostCredentialRead: { mockRestore(): void } | undefined;
  let projects = 0;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-anthropic-origin-")));
    checkout = path.join(root, "checkout");
    await fs.mkdir(checkout);
    await runCommand("git", ["init", "-b", "main"], { cwd: checkout });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
    await runCommand("git", ["config", "user.name", "Origin Test"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "README.md"), "initial\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: checkout });
    // An agent-test backend runs only agents in its managed toolchain.
    await fs.mkdir(path.join(root, "managed-bin"));
    for (const name of ["claude", "codex"]) {
      await fs.writeFile(path.join(root, "managed-bin", name), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
    }
    for (const bridge of ["claude-bridge", "codex-bridge"]) {
      const dist = path.join(root, "bridges", bridge, "dist");
      await fs.mkdir(dist, { recursive: true });
      await fs.writeFile(path.join(dist, "index.js"), CAPTURING_BRIDGE);
    }
    // A non-default data directory, as an isolated agent-test profile has.
    storage = new StorageService(path.join(root, "data"));
    await storage.init();

    saved = SAVED_ENV.map((name) => [name, process.env[name]] as const);
    for (const name of SAVED_ENV) delete process.env[name];
    const claudeHome = path.join(root, "source-claude-home");
    await fs.mkdir(claudeHome);
    await fs.writeFile(
      path.join(claudeHome, ".credentials.json"),
      '{"claudeAiOauth":{"accessToken":"fixture-login"}}\n',
    );
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    const codexHome = path.join(root, "source-codex-home");
    await fs.mkdir(codexHome);
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_BRIDGE_STATE_DIR = path.join(root, "codex-state");
    // Something the launch must not keep pointing at.
    process.env.ANTHROPIC_BASE_URL = INHERITED_BASE_URL;
    // Keep host credential discovery away from the real Keychain.
    hostCredentialRead = spyOn(commandFiles, "readRuntimeHostClaudeCredentials").mockImplementation(
      () => fs.readFile(path.join(claudeHome, ".credentials.json"), "utf8").catch(() => undefined),
    );
  });

  afterEach(async () => {
    for (const { runtimeId, context, kind } of started.splice(0).reverse()) {
      await stopLocalServerUnlocked(runtimeId, context, kind).catch(() => undefined);
    }
    for (const runtime of runtimes.splice(0)) runtime.shutdown();
    hostCredentialRead?.mockRestore();
    hostCredentialRead = undefined;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  function isolate(origin: string = ORIGIN): void {
    process.env.ORKESTRATOR_AGENT_TEST_ISOLATED = "1";
    process.env[AGENT_TEST_ANTHROPIC_ORIGIN_ENV] = origin;
  }

  function commandContext(
    runtimeFlavor: CommandContext["runtimeFlavor"],
    coordinators?: CoordinatorService,
  ): CommandContext {
    const runtime = new BackendRuntime({ emit: () => undefined });
    runtimes.push(runtime);
    return {
      storage,
      ...(coordinators ? { coordinators } : {}),
      appRoot: root,
      resourceRoot: root,
      toolchainBinDir: path.join(root, "managed-bin"),
      emit: () => undefined,
      runtimeFlavor,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime,
      nativeAgents: {
        hasObservedLiveWork: async () => false,
        runtimeStopRequested: async () => undefined,
      },
    } as unknown as CommandContext;
  }

  async function worker(): Promise<string> {
    const project = await storage.addProject(createProject(`remote-${++projects}`, checkout));
    const environment = createEnvironment(project.id, {
      name: "origin worker",
      environmentType: "local",
    });
    environment.status = "running";
    environment.worktreePath = checkout;
    await storage.addEnvironment(environment);
    return environment.id;
  }

  async function launch(
    runtimeId: string,
    context: CommandContext,
    kind: Kind,
  ): Promise<{ baseUrl: string | null; nonessential: string | null }> {
    const captured = path.join(root, "bridges", `${kind}-bridge`, "dist", "captured.json");
    await fs.rm(captured, { force: true });
    await startLocalServerUnlocked(runtimeId, context, kind);
    started.push({ runtimeId, context, kind });
    return JSON.parse(await fs.readFile(captured, "utf8")) as {
      baseUrl: string | null;
      nonessential: string | null;
    };
  }

  test("a worker's Claude bridge is pointed at the loopback model, over an inherited base URL", async () => {
    isolate();
    const environmentId = await worker();
    expect(await launch(environmentId, commandContext("agent-test"), "claude")).toEqual({
      baseUrl: ORIGIN,
      nonessential: "1",
    });
  });

  test("a coordinator's Claude bridge, with its private home, is pointed there too", async () => {
    isolate();
    const project = await storage.addProject(createProject("remote", checkout));
    const coordinators = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinators.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinators.assignConversationAgent(project.id, conversation.id, "claude");
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    expect(await launch(runtimeId, commandContext("agent-test", coordinators), "claude")).toEqual({
      baseUrl: ORIGIN,
      nonessential: "1",
    });
  });

  test("a Codex bridge never receives the Anthropic origin", async () => {
    isolate();
    const environmentId = await worker();
    const captured = await launch(environmentId, commandContext("agent-test"), "codex");
    expect(captured.baseUrl).not.toBe(ORIGIN);
    expect(captured.nonessential).toBeNull();
  });

  test("a production or development backend launches Claude untouched, even with the variables set", async () => {
    isolate();
    for (const flavor of ["production", "development"] as const) {
      const environmentId = await worker();
      const captured = await launch(environmentId, commandContext(flavor), "claude");
      expect(captured.baseUrl).not.toBe(ORIGIN);
      expect(captured.nonessential).toBeNull();
    }
  });

  test("a non-loopback origin is refused at launch", async () => {
    isolate("https://api.example.invalid");
    const environmentId = await worker();
    const captured = await launch(environmentId, commandContext("agent-test"), "claude");
    expect(captured.baseUrl).not.toBe("https://api.example.invalid");
    expect(captured.nonessential).toBeNull();
  });
});
