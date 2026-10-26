/**
 * A coordinator's skills against the **real** pinned `codex app-server`.
 *
 * A coordinator runs with a private `CODEX_HOME` and its checkout untrusted,
 * so before this it saw neither the user's own skills nor the project's. These
 * tests run the coordinator's real process configuration
 * (`codexAppServerConfigOverrides`) and read what the model would be offered
 * from a loopback Responses endpoint, so no model is called and no credits
 * are spent. They also run commands under the coordinator's permission
 * profile (`command/exec`) to show that a listed user skill can be opened and
 * that nothing else became readable or writable. Gated like the other live
 * contract tests:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-coordinator-skills.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COORDINATOR_CODEX_USER_SKILLS_DIR_ENV } from "@orkestrator/protocol/coordinator";
import {
  codexAppServerConfigOverrides,
  codexCoordinatorPolicy,
  codexCoordinatorSkillExtraRoots,
} from "../codex-config.js";
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
const PROFILE = "coordinator-skills-live";

const CANARY = {
  user: "USER-CODEX-SKILL-CANARY",
  repo: "PROJECT-AGENTS-SKILL-CANARY",
  claude: "PROJECT-CLAUDE-SKILL-CANARY",
} as const;

interface Fixture {
  root: string;
  codexHome: string;
  workspace: string;
  userSkills: string;
  env: NodeJS.ProcessEnv;
  frames: Record<string, unknown>[];
  baseUrl: string;
  stop: () => Promise<void>;
}

async function skill(dir: string, name: string, description: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nFollow the steps.\n`,
  );
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ork-coordinator-skills-")));
  const codexHome = join(root, "coordinator-codex-home");
  const workspace = join(root, "checkout");
  const userSkills = join(root, "account-codex-home", "skills");
  await mkdir(codexHome, { recursive: true });
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    { mode: 0o600 },
  );
  await skill(userSkills, "user-canary", CANARY.user);
  await skill(join(workspace, ".agents", "skills"), "repo-canary", CANARY.repo);
  await skill(join(workspace, ".claude", "skills"), "claude-canary", CANARY.claude);
  // Outside every grant: the control that the profile applies at all.
  await writeFile(join(root, "private.txt"), "PRIVATE\n");

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
          if (frame.type === "response.create" && frame.generate !== false) frames.push(frame);
        } catch {
          // Only the request frame matters.
        }
        socket.close(1011, "recorded");
      },
    },
  });
  return {
    root,
    codexHome,
    workspace,
    userSkills,
    env: {
      ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
      CODEX_BRIDGE_PERMISSION_PROFILE: PROFILE,
      CODEX_BRIDGE_READABLE_RUNTIME_ROOT: join(root, "runtime"),
      CWD: workspace,
      [COORDINATOR_CODEX_USER_SKILLS_DIR_ENV]: userSkills,
    },
    frames,
    baseUrl: `http://127.0.0.1:${responses.port}/v1`,
    stop: async () => {
      await responses.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

function engineFor(setup: Fixture, codexPath: string): AppServerEngine {
  return new AppServerEngine({
    codexPath,
    cwd: setup.workspace,
    codexHome: setup.codexHome,
    clientInfo: CLIENT_INFO,
    configOverrides: {
      ...codexAppServerConfigOverrides(setup.env),
      openai_base_url: JSON.stringify(setup.baseUrl),
    },
    skillExtraRoots: codexCoordinatorSkillExtraRoots(setup.env, setup.workspace),
    supervisorOverrides: { pidFileEnabled: false },
  });
}

function coordinatorConfig(setup: Fixture): EngineTurnConfig {
  // What `toEngineConfig` builds for a coordinator process.
  return {
    mode: "build",
    cwd: setup.workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    networkAccessEnabled: false,
    permissionProfile: PROFILE,
    policy: codexCoordinatorPolicy({}),
  };
}

async function exec(
  engine: AppServerEngine,
  command: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  const supervisor = (
    engine as unknown as {
      supervisor: { request: (method: string, params: unknown) => Promise<unknown> };
    }
  ).supervisor;
  return (await supervisor.request("command/exec", {
    command,
    cwd,
    timeoutMs: 20_000,
  })) as { exitCode: number; stdout: string };
}

describeLive("live coordinator skills", () => {
  let previousPolicy: string | undefined;

  // `codexLoadsProjectSkills` reads the process authority, as the bridge does.
  beforeEach(() => {
    previousPolicy = process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
    process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = "coordinator-read-only";
  });
  afterEach(() => {
    if (previousPolicy === undefined) delete process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
    else process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = previousPolicy;
  });

  test("the user's and the project's skills are listed, enabled and offered", async () => {
    const setup = await fixture();
    const engine = engineFor(setup, await resolveCodexBinary());
    try {
      await engine.start();
      const listed = (await engine.listSkills({ cwd: setup.workspace, forceReload: true }))
        .result as { data: { skills: { name: string; scope: string; enabled: boolean }[] }[] };
      const byName = new Map(listed.data.flatMap((entry) => entry.skills).map((s) => [s.name, s]));
      expect(byName.get("user-canary")).toMatchObject({ scope: "user", enabled: true });
      expect(byName.get("repo-canary")).toMatchObject({ scope: "repo", enabled: true });
      expect(byName.get("claude-canary")).toMatchObject({ scope: "user", enabled: true });

      const config = coordinatorConfig(setup);
      const thread = await engine.startThread({ config });
      await engine.startTurn({
        handle: thread.handle,
        input: [{ type: "text", text: "LIST-SKILLS" }],
        config,
      });
      const deadline = Date.now() + 60_000;
      let request: string | undefined;
      while (!request && Date.now() < deadline) {
        request = setup.frames
          .map((frame) => JSON.stringify(frame))
          .find((t) => t.includes("LIST-SKILLS"));
        if (!request) await Bun.sleep(100);
      }
      expect(request).toBeDefined();
      for (const canary of Object.values(CANARY)) expect(request).toContain(canary);
    } finally {
      await engine.stop();
      await setup.stop();
    }
  }, 180_000);

  test("commands can read a user skill and still cannot write or read anything else", async () => {
    const setup = await fixture();
    const engine = engineFor(setup, await resolveCodexBinary());
    try {
      await engine.start();
      const userSkill = join(setup.userSkills, "user-canary", "SKILL.md");
      const read = await exec(engine, ["/bin/cat", userSkill], setup.workspace);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain(CANARY.user);
      const repo = await exec(
        engine,
        ["/bin/cat", join(setup.workspace, ".claude", "skills", "claude-canary", "SKILL.md")],
        setup.workspace,
      );
      expect(repo.stdout).toContain(CANARY.claude);

      // The profile still applies: a file beside the grants is not readable,
      // and neither a skill nor the checkout is writable.
      expect(
        (await exec(engine, ["/bin/cat", join(setup.root, "private.txt")], setup.workspace))
          .exitCode,
      ).not.toBe(0);
      expect(
        (
          await exec(
            engine,
            ["/usr/bin/touch", join(setup.userSkills, "user-canary", "x")],
            setup.workspace,
          )
        ).exitCode,
      ).not.toBe(0);
      expect(
        (await exec(engine, ["/usr/bin/touch", join(setup.workspace, "x")], setup.workspace))
          .exitCode,
      ).not.toBe(0);
    } finally {
      await engine.stop();
      await setup.stop();
    }
  }, 180_000);
});
