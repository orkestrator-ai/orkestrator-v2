import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  memoryLifecycleContext,
  withDockerScript,
} from "../../tests/container-lifecycle-fixtures.js";
import { registerDockerCommands } from "./commands-registry-docker.js";
import type { CommandHandler } from "./commands-context.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { dockerOwnerNamespace } from "./docker-ownership.js";
import { resetImageManifestCache } from "./docker-image.js";
import { revokeProviderCredentials } from "./portable-input-status.js";
import { staleLoginEnvironmentIds } from "./agent-account-bridge-state.js";
import {
  activeAgentAccountInputRoots,
  markContainersForClaudeLoginRefresh,
  reconcileContainerAgentAccount,
  refreshStagedAgentAccountLogins,
  syncContainerAgentAccountsOnStart,
  startContainerWithAgentAccounts,
  syncContainerGrokLogin,
  type ContainerRunners,
} from "./agent-accounts-containers.js";
import { SYNC_CONTAINER_CLAUDE_CREDENTIAL_COMMAND } from "./commands-files.js";
import type { CommandContext } from "./commands-context.js";
import { AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV } from "./commands-runtime-state.js";
import type { Environment } from "./models.js";
import {
  defaultInputSourceRoots,
  portableInputRevisionDirectory,
  replaceStagedInputFile,
  stagePortableInputs,
} from "./portable-inputs.js";
import { createEnvironment, StorageService } from "./storage.js";

const ENV_KEYS = [
  "CODEX_HOME",
  "ORKESTRATOR_AGENT_TEST_HOST_HOME",
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const CODEX_ID = "66666666-7777-4888-9999-aaaaaaaaaaaa";

let root: string;
let storage: StorageService;
let environment: Environment;
let liveWork = false;
let context: CommandContext;

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

function accountHome(platform: "claude" | "codex", id: string): string {
  return path.join(root, "data", "agent-accounts", platform, id);
}

async function addAccounts(active: { claude?: string; codex?: string }): Promise<void> {
  await write(
    path.join(accountHome("codex", CODEX_ID), "auth.json"),
    '{"OPENAI_API_KEY":"codex-2"}',
  );
  await write(
    path.join(accountHome("claude", CLAUDE_ID), ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"claude-2"}}',
  );
  await write(
    path.join(accountHome("claude", CLAUDE_ID), ".claude.json"),
    '{"oauthAccount":{"emailAddress":"second@example.com"}}',
  );
  await storage.mutateAgentAccounts((store) => ({
    store: {
      ...store,
      accounts: [
        { id: CLAUDE_ID, platform: "claude", label: "Claude 2", createdAt: "2026-09-28T00:00:00Z" },
        { id: CODEX_ID, platform: "codex", label: "Codex 2", createdAt: "2026-09-28T00:00:00Z" },
      ],
      active,
    },
    result: undefined,
  }));
}

function fakeRunners(revision: string | null) {
  const markers = new Map<string, string>();
  const calls: Array<{ kind: "exec" | "pipe"; command: string; stdin?: string }> = [];
  const runners: ContainerRunners = {
    exec: async (_id, command) => {
      calls.push({ kind: "exec", command });
      const read = command.match(/^cat (\S+) /);
      if (read) return markers.get(read[1]!) ?? "";
      const written = command.match(/printf '%s' '([^']*)' > (\S+)$/);
      if (written) markers.set(written[2]!, written[1]!);
      const removed = command.match(/^rm -f (\/tmp\/\S+)$/);
      if (removed) markers.delete(removed[1]!);
      return "";
    },
    pipe: async (_id, command, stdin) => {
      calls.push({ kind: "pipe", command, stdin });
    },
    label: async () => revision,
  };
  return { runners, markers, calls };
}

async function stage(): Promise<string> {
  const staged = await stagePortableInputs(
    path.join(root, "data"),
    environment.id,
    new Set(["claude", "codex"]),
    {
      ...defaultInputSourceRoots("agent-test", AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV),
      ...(await activeAgentAccountInputRoots(context)),
    },
  );
  return staged.revision;
}

async function start(fake: ReturnType<typeof fakeRunners>): Promise<void> {
  await withDockerScript(
    `#!/bin/sh
if [ "$1" = "inspect" ]; then printf 'false\\n'; fi
exit 0
`,
    async () => startContainerWithAgentAccounts(context, environment, "container-1", fake.runners),
  );
}

function staged(revision: string, relative: string): string {
  return path.join(
    portableInputRevisionDirectory(path.join(root, "data"), environment.id, revision),
    relative,
  );
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-account-containers-")));
  process.env.CODEX_HOME = path.join(root, "host-codex");
  process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = path.join(root, "host-home");
  process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV] = path.join(root, "host-claude");
  await write(path.join(root, "host-codex", "auth.json"), '{"OPENAI_API_KEY":"codex-host"}');
  await write(path.join(root, "host-codex", "config.toml"), 'model = "host"');
  await write(path.join(root, "host-claude", "CLAUDE.md"), "host memory");
  await write(
    path.join(root, "host-claude", ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"claude-host"}}',
  );
  await write(
    path.join(root, "host-home", ".claude.json"),
    '{"oauthAccount":{"emailAddress":"host@example.com"}}',
  );

  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  environment = { ...createEnvironment("project-1"), containerId: "container-1" };
  liveWork = false;
  const overrides = {
    loadConfig: async () => ({ global: { enabledAgentPlatforms: ["claude", "codex"] } }),
    loadEnvironments: async () => [structuredClone(environment)],
    getEnvironment: async () => structuredClone(environment),
    updateEnvironment: async (_id: string, update: Partial<Environment>) => {
      environment = { ...environment, ...update };
      return structuredClone(environment);
    },
  };
  context = {
    storage: Object.assign(Object.create(storage), overrides),
    runtimeFlavor: "agent-test",
    credentialSources: new Set(["claude", "codex"]),
    nativeAgents: { hasObservedLiveWork: async () => liveWork },
  } as unknown as CommandContext;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("staging with an active account", () => {
  test("takes only the login from the account and still one mount per target", async () => {
    await addAccounts({ claude: CLAUDE_ID, codex: CODEX_ID });
    const result = await stagePortableInputs(
      path.join(root, "data"),
      environment.id,
      new Set(["claude", "codex"]),
      {
        ...defaultInputSourceRoots("agent-test", AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV),
        ...(await activeAgentAccountInputRoots(context)),
      },
    );
    const read = (relative: string) => fs.readFile(staged(result.revision, relative), "utf8");

    expect(await read("codex-home/auth.json")).toBe('{"OPENAI_API_KEY":"codex-2"}');
    expect(await read("codex-home/config.toml")).toBe('model = "host"');
    expect(await read("claude-config/.credentials.json")).toContain("claude-2");
    expect(await read("claude-config/CLAUDE.md")).toBe("host memory");
    expect(await read("files/claude.json/.claude.json")).toContain("second@example.com");
    const targets = result.mounts.map((mount) => mount.target);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).toContain("/codex-home");
  });

  test("credential opt-out never copies an added Claude login into a revision", async () => {
    await addAccounts({ claude: CLAUDE_ID });
    const result = await stagePortableInputs(
      path.join(root, "data"),
      environment.id,
      new Set(["claude"]),
      {
        ...defaultInputSourceRoots("agent-test", AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV),
        ...(await activeAgentAccountInputRoots(context)),
        includeClaudeCredentials: false,
      },
    );
    await expect(
      fs.stat(staged(result.revision, "claude-config/.credentials.json")),
    ).rejects.toThrow();
    expect(await fs.readFile(staged(result.revision, "claude-config/CLAUDE.md"), "utf8")).toBe(
      "host memory",
    );
  });
});

describe("replaceStagedInputFile", () => {
  test("swaps a file in a staged directory and rewrites a file mount in place", async () => {
    const revision = await stage();
    const dataDir = path.join(root, "data");
    const mount = staged(revision, "files/claude.json/.claude.json");
    const inode = (await fs.stat(mount)).ino;

    expect(
      await replaceStagedInputFile(
        dataDir,
        environment.id,
        revision,
        "codex-home/auth.json",
        "new",
      ),
    ).toBe(true);
    expect(
      await replaceStagedInputFile(
        dataDir,
        environment.id,
        revision,
        "files/claude.json/.claude.json",
        "{}",
        {
          inPlace: true,
        },
      ),
    ).toBe(true);

    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toBe("new");
    expect(await fs.readFile(mount, "utf8")).toBe("{}");
    expect((await fs.stat(mount)).ino).toBe(inode);
    expect(
      await replaceStagedInputFile(dataDir, environment.id, revision, "pi-config/auth.json", "x"),
    ).toBe(false);
    await expect(
      replaceStagedInputFile(dataDir, environment.id, revision, "codex-home/../../x", "x"),
    ).rejects.toThrow("not valid");
  });
});

describe("refreshStagedAgentAccountLogins", () => {
  test("leaves Claude alone until an account has been added, but re-reads Codex every start", async () => {
    const revision = await stage();
    await write(staged(revision, "claude-config/.credentials.json"), "snapshot");
    await write(staged(revision, "codex-home/auth.json"), "snapshot");
    await refreshStagedAgentAccountLogins(
      context,
      environment,
      "container-1",
      fakeRunners(revision).runners,
    );
    expect(await fs.readFile(staged(revision, "claude-config/.credentials.json"), "utf8")).toBe(
      "snapshot",
    );
    // The snapshot a container was created with cannot refresh, so only the
    // host's current login keeps it signed in.
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toBe(
      '{"OPENAI_API_KEY":"codex-host"}',
    );
  });

  test("restages Codex and Grok logins access-only, and drops an expired one", async () => {
    const accessToken = `h.${Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")}.s`;
    await write(
      path.join(root, "host-codex", "auth.json"),
      JSON.stringify({
        tokens: { access_token: accessToken, refresh_token: "SENTINEL-CODEX-REFRESH" },
      }),
    );
    const grokAuth = path.join(root, "host-home", ".grok", "auth.json");
    await write(path.join(root, "host-home", ".grok", "config.toml"), "model = 'x'");
    await write(grokAuth, "{}");
    const enableGrok = () => {
      const original = context.storage.loadConfig.bind(context.storage);
      context.storage.loadConfig = async () =>
        ({
          ...(await original()),
          global: { enabledAgentPlatforms: ["claude", "codex", "grok"] },
        }) as never;
      (context.credentialSources as Set<string>).add("grok");
    };
    enableGrok();
    const revision = (
      await stagePortableInputs(
        path.join(root, "data"),
        environment.id,
        new Set(["codex", "grok"]),
        defaultInputSourceRoots("agent-test", AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV),
      )
    ).revision;
    await write(staged(revision, "grok-home/auth.json"), "stale");
    await write(
      grokAuth,
      JSON.stringify({
        live: {
          key: "grok-access",
          refresh_token: "SENTINEL-GROK-REFRESH",
          expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
        },
      }),
    );
    const { runners } = fakeRunners(revision);
    await refreshStagedAgentAccountLogins(context, environment, "container-1", runners);
    const codex = JSON.parse(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8"));
    expect(codex.tokens.refresh_token).toBe("");
    const grok = await fs.readFile(staged(revision, "grok-home/auth.json"), "utf8");
    expect(JSON.parse(grok).live).toMatchObject({ key: "grok-access", refresh_token: "" });
    expect(grok).not.toContain("SENTINEL");

    await write(
      grokAuth,
      JSON.stringify({ old: { key: "k", refresh_token: "r", expires_at: "2026-01-01T00:00:00Z" } }),
    );
    await refreshStagedAgentAccountLogins(context, environment, "container-1", runners);
    await expect(fs.stat(staged(revision, "grok-home/auth.json"))).rejects.toThrow();
  });

  test("points a staged revision at the active account, and back at the host", async () => {
    const revision = await stage();
    await addAccounts({ codex: CODEX_ID, claude: CLAUDE_ID });
    const { runners } = fakeRunners(revision);

    await refreshStagedAgentAccountLogins(context, environment, "container-1", runners);
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toBe(
      '{"OPENAI_API_KEY":"codex-2"}',
    );
    expect(await fs.readFile(staged(revision, "files/claude.json/.claude.json"), "utf8")).toContain(
      "second@example.com",
    );

    await storage.mutateAgentAccounts((store) => ({
      store: { ...store, active: {} },
      result: undefined,
    }));
    await refreshStagedAgentAccountLogins(context, environment, "container-1", runners);
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toBe(
      '{"OPENAI_API_KEY":"codex-host"}',
    );
    expect(
      await fs.readFile(staged(revision, "claude-config/.credentials.json"), "utf8"),
    ).toContain("claude-host");
  });

  test("revokes a previously staged login when Claude container credentials are disabled", async () => {
    await addAccounts({ claude: CLAUDE_ID });
    const revision = await stage();
    const original = context.storage.loadConfig.bind(context.storage);
    context.storage.loadConfig = async () =>
      ({
        ...(await original()),
        global: {
          ...(await original()).global,
          enabledAgentPlatforms: ["claude"],
          useHostClaudeCredentials: false,
        },
      }) as never;
    await refreshStagedAgentAccountLogins(
      context,
      environment,
      "container-1",
      fakeRunners(revision).runners,
    );
    await expect(fs.stat(staged(revision, "claude-config/.credentials.json"))).rejects.toThrow();
  });

  test("removes the staged Claude login when the selected account signs out", async () => {
    await addAccounts({ claude: CLAUDE_ID });
    const revision = await stage();
    expect(
      await fs.readFile(staged(revision, "claude-config/.credentials.json"), "utf8"),
    ).toContain("claude-2");
    await fs.rm(path.join(accountHome("claude", CLAUDE_ID), ".credentials.json"));
    await refreshStagedAgentAccountLogins(
      context,
      environment,
      "container-1",
      fakeRunners(revision).runners,
    );
    await expect(fs.stat(staged(revision, "claude-config/.credentials.json"))).rejects.toThrow();
  });
});

describe("syncContainerAgentAccountsOnStart", () => {
  test("pipes the active Claude account's login and preserves the installed Codex marker", async () => {
    await addAccounts({ claude: CLAUDE_ID });
    const fake = fakeRunners(null);
    fake.markers.set("/tmp/orkestrator-codex-account", CODEX_ID);

    await syncContainerAgentAccountsOnStart(
      context,
      environment,
      "container-1",
      { enabledAgentPlatforms: ["claude", "codex"] } as never,
      fake.runners,
    );

    const piped = fake.calls.find((call) => call.kind === "pipe");
    expect(piped?.command).toBe(SYNC_CONTAINER_CLAUDE_CREDENTIAL_COMMAND);
    expect(piped?.stdin).toContain("claude-2");
    expect(fake.markers.get("/tmp/orkestrator-claude-account")).toBe(CLAUDE_ID);
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe(CODEX_ID);
  });

  test("a renewal during start copying cannot mark the old credential as renewed", async () => {
    const fake = fakeRunners(null);
    const pipe = fake.runners.pipe;
    fake.runners.pipe = async (...args) => {
      await pipe(...args);
      await markContainersForClaudeLoginRefresh(context);
    };
    await syncContainerAgentAccountsOnStart(
      context,
      environment,
      "container-1",
      { enabledAgentPlatforms: ["claude", "codex"] } as never,
      fake.runners,
    );
    const generation = (await context.storage.loadAgentAccounts()).loginGeneration?.claude;
    expect(generation).toBeDefined();
    expect(fake.markers.get("/tmp/orkestrator-claude-account")).toBe("default");
    fake.runners.pipe = pipe;
    let stopped = 0;
    const control = {
      isRunning: async () => true,
      stop: async () => {
        stopped++;
      },
    };
    staleLoginEnvironmentIds.clear();
    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);
    expect(stopped).toBe(1);
  });

  test("never pipes a Claude token when host credentials are turned off", async () => {
    await addAccounts({ claude: CLAUDE_ID });
    const fake = fakeRunners(null);
    await syncContainerAgentAccountsOnStart(
      context,
      environment,
      "container-1",
      { enabledAgentPlatforms: ["claude", "codex"], useHostClaudeCredentials: false } as never,
      fake.runners,
    );
    expect(fake.calls.some((call) => call.kind === "pipe")).toBe(false);
    expect(
      fake.calls.some((call) => call.command === "rm -f /home/node/.claude/.credentials.json"),
    ).toBe(true);
  });

  test("removes the previous credential before marking a signed-out account current", async () => {
    await addAccounts({ claude: CLAUDE_ID });
    await fs.rm(path.join(accountHome("claude", CLAUDE_ID), ".credentials.json"));
    const fake = fakeRunners(null);
    await syncContainerAgentAccountsOnStart(
      context,
      environment,
      "container-1",
      { enabledAgentPlatforms: ["claude"] } as never,
      fake.runners,
    );
    expect(
      fake.calls.some((call) => call.command === "rm -f /home/node/.claude/.credentials.json"),
    ).toBe(true);
    expect(fake.markers.get("/tmp/orkestrator-claude-account")).toBe(CLAUDE_ID);
  });
});

describe("reconcileContainerAgentAccount", () => {
  function bridge(running: boolean) {
    const state = { stopped: 0 };
    return {
      state,
      control: {
        isRunning: async () => running,
        stop: async () => {
          state.stopped += 1;
        },
      },
    };
  }

  test("an account's ChatGPT login reaches the container without its refresh token", async () => {
    const revision = await stage();
    await addAccounts({ codex: CODEX_ID });
    const accessToken = `h.${Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")}.s`;
    await write(
      path.join(accountHome("codex", CODEX_ID), "auth.json"),
      JSON.stringify({ tokens: { access_token: accessToken, refresh_token: "SENTINEL-RT" } }),
    );
    const fake = fakeRunners(revision);
    await reconcileContainerAgentAccount(
      context,
      "container-1",
      "codex",
      bridge(false).control,
      fake.runners,
    );
    const piped = fake.calls.find((call) => call.kind === "pipe");
    expect(JSON.parse(piped!.stdin!).tokens).toEqual({
      access_token: accessToken,
      refresh_token: "",
    });
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).not.toContain(
      "SENTINEL",
    );
  });

  test("writes the new login in and replaces an idle bridge", async () => {
    const revision = await stage();
    await addAccounts({ codex: CODEX_ID });
    const fake = fakeRunners(revision);
    const { state, control } = bridge(true);

    await reconcileContainerAgentAccount(context, "container-1", "codex", control, fake.runners);

    const piped = fake.calls.find((call) => call.kind === "pipe");
    expect(piped?.command).toContain("/home/node/.codex/auth.json");
    expect(piped?.stdin).toBe('{"OPENAI_API_KEY":"codex-2"}');
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe(CODEX_ID);
    expect(state.stopped).toBe(1);
    // A restart keeps the account: the entrypoint imports the staged login.
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toBe(
      '{"OPENAI_API_KEY":"codex-2"}',
    );

    await reconcileContainerAgentAccount(context, "container-1", "codex", control, fake.runners);
    expect(fake.calls.filter((call) => call.kind === "pipe")).toHaveLength(1);
    expect(state.stopped).toBe(1);
  });

  test("a restart that restaged another account still switches back to the host", async () => {
    const revision = await stage();
    await addAccounts({ codex: CODEX_ID });
    const fake = fakeRunners(revision);
    const global = { enabledAgentPlatforms: ["claude", "codex"] } as never;
    // Restart while the added account is active: the entrypoint imports its login.
    await start(fake);
    await syncContainerAgentAccountsOnStart(
      context,
      environment,
      "container-1",
      global,
      fake.runners,
    );
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe("unstaged");

    await storage.mutateAgentAccounts((store) => ({
      store: { ...store, active: {} },
      result: undefined,
    }));
    const { state, control } = bridge(true);
    await reconcileContainerAgentAccount(context, "container-1", "codex", control, fake.runners);

    const piped = fake.calls.filter((call) => call.command.includes(".codex/auth.json")).at(-1);
    expect(piped?.stdin).toBe('{"OPENAI_API_KEY":"codex-host"}');
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe("default");
    expect(state.stopped).toBe(1);
  });

  test("a restart that staged no login leaves the next bridge start to correct the container", async () => {
    const revision = await stage();
    await addAccounts({});
    const expired = `h.${Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 }),
    ).toString("base64url")}.s`;
    await write(
      path.join(root, "host-codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: expired, refresh_token: "r" } }),
    );
    const fake = fakeRunners(revision);
    const global = { enabledAgentPlatforms: ["claude", "codex"] } as never;
    await start(fake);
    await syncContainerAgentAccountsOnStart(
      context,
      environment,
      "container-1",
      global,
      fake.runners,
    );
    // The container kept whatever copy it had, which may be another account's.
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe("unstaged");

    await reconcileContainerAgentAccount(
      context,
      "container-1",
      "codex",
      bridge(false).control,
      fake.runners,
    );
    expect(fake.calls.some((call) => call.command === "rm -f /home/node/.codex/auth.json")).toBe(
      true,
    );
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe("default");
  });

  test("A to host during restaging and back to A still delivers A's login", async () => {
    const revision = await stage();
    await addAccounts({ codex: CODEX_ID });
    context.storage.loadConfig = async () =>
      ({ global: { enabledAgentPlatforms: ["codex"] } }) as never;
    const fake = fakeRunners(revision);
    const loadAgentAccounts = context.storage.loadAgentAccounts.bind(context.storage);
    let reads = 0;
    context.storage.loadAgentAccounts = async () => {
      const snapshot = await loadAgentAccounts();
      reads++;
      await storage.mutateAgentAccounts((current) => ({
        store: { ...current, active: {} },
        result: undefined,
      }));
      return snapshot;
    };
    await start(fake);
    context.storage.loadAgentAccounts = loadAgentAccounts;
    // The credential home came from one snapshot. No second marker read can
    // misattribute a host login to A, nor does startup acknowledge an import.
    expect(reads).toBe(1);
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toBe(
      '{"OPENAI_API_KEY":"codex-2"}',
    );
    await storage.mutateAgentAccounts((store) => ({
      store: { ...store, active: { codex: CODEX_ID } },
      result: undefined,
    }));
    await syncContainerAgentAccountsOnStart(
      context,
      environment,
      "container-1",
      { enabledAgentPlatforms: ["codex"] } as never,
      fake.runners,
    );
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe("unstaged");
    await reconcileContainerAgentAccount(
      context,
      "container-1",
      "codex",
      bridge(true).control,
      fake.runners,
    );
    expect(fake.calls.filter((call) => call.kind === "pipe").at(-1)?.stdin).toBe(
      '{"OPENAI_API_KEY":"codex-2"}',
    );
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe(CODEX_ID);
  });

  test("startup without any restage hint never makes an added login look like the host", async () => {
    const revision = await stage();
    await addAccounts({ codex: CODEX_ID });
    const fake = fakeRunners(revision);
    await start(fake);
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toContain(
      "codex-2",
    );
    // Startup can run repeatedly or in a recreated backend; there is no
    // in-process hand-off to consume, lose, or misidentify by a short id.
    for (let i = 0; i < 2; i++) {
      await syncContainerAgentAccountsOnStart(
        context,
        environment,
        "container-1",
        { enabledAgentPlatforms: ["codex"] } as never,
        fake.runners,
      );
    }
    await addAccounts({});
    await reconcileContainerAgentAccount(
      context,
      "container-1",
      "codex",
      bridge(true).control,
      fake.runners,
    );
    expect(fake.calls.filter((call) => call.kind === "pipe").at(-1)?.stdin).toBe(
      '{"OPENAI_API_KEY":"codex-host"}',
    );
  });

  test("reconciliation copies the identity, home and generation from one registry snapshot", async () => {
    const before = "11111111-2222-4333-8444-555555555555";
    const after = "99999999-8888-4777-8666-555555555555";
    await addAccounts({ codex: CODEX_ID });
    await storage.mutateAgentAccounts((store) => ({
      store: { ...store, loginGeneration: { codex: before } },
      result: undefined,
    }));
    const fake = fakeRunners(null);
    const exec = fake.runners.exec;
    fake.runners.exec = async (id, command) => {
      const result = await exec(id, command);
      if (command.startsWith("cat /tmp/orkestrator-codex-account")) {
        await storage.mutateAgentAccounts((store) => ({
          store: { ...store, active: {}, loginGeneration: { codex: after } },
          result: undefined,
        }));
      }
      return result;
    };
    await reconcileContainerAgentAccount(
      context,
      "container-1",
      "codex",
      bridge(false).control,
      fake.runners,
    );
    expect(fake.calls.filter((call) => call.kind === "pipe").at(-1)?.stdin).toBe(
      '{"OPENAI_API_KEY":"codex-2"}',
    );
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe(`${CODEX_ID}:${before}`);
    fake.runners.exec = exec;
    await reconcileContainerAgentAccount(
      context,
      "container-1",
      "codex",
      bridge(false).control,
      fake.runners,
    );
    expect(fake.calls.filter((call) => call.kind === "pipe").at(-1)?.stdin).toBe(
      '{"OPENAI_API_KEY":"codex-host"}',
    );
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe(`default:${after}`);
  });

  test("leaves a busy bridge on its account", async () => {
    await addAccounts({ codex: CODEX_ID });
    liveWork = true;
    const fake = fakeRunners(null);
    const { state, control } = bridge(true);

    await reconcileContainerAgentAccount(context, "container-1", "codex", control, fake.runners);

    expect(fake.calls.some((call) => call.kind === "pipe")).toBe(false);
    expect(state.stopped).toBe(0);
  });

  test("does not replace login when health is negative but work is observed", async () => {
    const revision = await stage();
    await addAccounts({ claude: CLAUDE_ID });
    liveWork = true;
    const fake = fakeRunners(revision);
    const { state, control } = bridge(false);
    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);
    expect(fake.calls).toEqual([
      { kind: "exec", command: "cat /tmp/orkestrator-claude-account 2>/dev/null || true" },
    ]);
    expect(state.stopped).toBe(0);
  });

  test("without an added account the container is never contacted", async () => {
    const fake = fakeRunners(null);
    const { control } = bridge(true);
    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);
    await syncContainerAgentAccountsOnStart(
      context,
      environment,
      "container-1",
      { enabledAgentPlatforms: ["claude", "codex"] } as never,
      fake.runners,
    );
    // Only the Claude credential sync that has always run on start.
    expect(fake.calls.map((call) => call.kind)).toEqual(["pipe"]);
  });

  test("a container already on the active account is left alone", async () => {
    await addAccounts({ codex: CODEX_ID });
    const fake = fakeRunners(null);
    fake.markers.set("/tmp/orkestrator-codex-account", CODEX_ID);
    const { state, control } = bridge(true);
    await reconcileContainerAgentAccount(context, "container-1", "codex", control, fake.runners);
    expect(fake.calls.map((call) => call.kind)).toEqual(["exec"]);
    expect(state.stopped).toBe(0);
  });

  test("a renewed host login reaches a container that never saw an account switch", async () => {
    staleLoginEnvironmentIds.clear();
    await markContainersForClaudeLoginRefresh(context);
    const fake = fakeRunners(null);
    const { state, control } = bridge(true);

    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);

    expect(fake.calls.find((call) => call.kind === "pipe")?.stdin).toBe(
      '{"claudeAiOauth":{"accessToken":"claude-host"}}',
    );
    expect(state.stopped).toBe(1);
    expect(staleLoginEnvironmentIds.has(environment.id)).toBe(false);
    // Once delivered, the container is left alone again.
    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);
    expect(fake.calls.filter((call) => call.kind === "pipe")).toHaveLength(1);
  });

  test("a busy bridge keeps the old login until it is idle", async () => {
    staleLoginEnvironmentIds.clear();
    await markContainersForClaudeLoginRefresh(context);
    liveWork = true;
    const fake = fakeRunners(null);
    const { state, control } = bridge(true);

    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);

    expect(fake.calls.some((call) => call.kind === "pipe")).toBe(false);
    expect(state.stopped).toBe(0);
    expect(staleLoginEnvironmentIds.has(environment.id)).toBe(true);
    staleLoginEnvironmentIds.clear();
  });

  test("failed bridge stop retains refresh intent and retries before acknowledging", async () => {
    staleLoginEnvironmentIds.clear();
    await markContainersForClaudeLoginRefresh(context);
    const fake = fakeRunners(null);
    fake.markers.set("/tmp/orkestrator-claude-account", "default");
    let attempts = 0;
    const control = {
      isRunning: async () => true,
      stop: async () => {
        attempts++;
        if (attempts === 1) throw new Error("stop unavailable");
      },
    };
    await expect(
      reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners),
    ).rejects.toThrow("stop unavailable");
    expect(staleLoginEnvironmentIds.has(environment.id)).toBe(true);
    expect(fake.markers.get("/tmp/orkestrator-claude-account")).toBe("default");
    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);
    expect(attempts).toBe(2);
    expect(staleLoginEnvironmentIds.has(environment.id)).toBe(false);
    expect(fake.markers.get("/tmp/orkestrator-claude-account")).toBe(
      `default:${(await storage.loadAgentAccounts()).loginGeneration?.claude}`,
    );
  });

  test("deferred refresh survives recreated backend state and a matching account marker", async () => {
    staleLoginEnvironmentIds.clear();
    await markContainersForClaudeLoginRefresh(context);
    liveWork = true;
    const fake = fakeRunners(null);
    fake.markers.set("/tmp/orkestrator-claude-account", "default");
    const { state, control } = bridge(true);
    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);
    expect(state.stopped).toBe(0);
    staleLoginEnvironmentIds.clear();
    await storage.addEnvironment(environment);
    await storage.updateGlobalConfig({
      ...(await storage.loadConfig()).global,
      enabledAgentPlatforms: ["claude", "codex"],
    });
    const restarted = new StorageService(storage.getDataDir());
    await restarted.init();
    context.storage = restarted;
    liveWork = false;
    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);
    expect(fake.calls.filter((call) => call.kind === "pipe")).toHaveLength(1);
    expect(state.stopped).toBe(1);
    const generation = (await restarted.loadAgentAccounts()).loginGeneration?.claude;
    expect(generation).toBeDefined();
    expect(fake.markers.get("/tmp/orkestrator-claude-account")).toBe(`default:${generation}`);
    await reconcileContainerAgentAccount(context, "container-1", "claude", control, fake.runners);
    expect(state.stopped).toBe(1);
  });

  test("an isolated container login is never replaced by the host's", async () => {
    staleLoginEnvironmentIds.clear();
    context.storage.loadConfig = async () =>
      ({ global: { enabledAgentPlatforms: ["claude"], useHostClaudeCredentials: false } }) as never;
    await markContainersForClaudeLoginRefresh(context);
    expect(staleLoginEnvironmentIds.size).toBe(0);
  });

  test("a revoked provider is never handed a login", async () => {
    await addAccounts({ codex: CODEX_ID });
    environment = { ...environment, revokedInputProviders: ["codex"] };
    const fake = fakeRunners(null);
    await reconcileContainerAgentAccount(
      context,
      "container-1",
      "codex",
      bridge(false).control,
      fake.runners,
    );
    expect(fake.calls).toEqual([]);
  });
});

describe("container start credential hand-off", () => {
  async function withStartFixture(
    options: {
      running?: boolean;
      entrypointInvalidates?: boolean;
      failure?: "start" | "ambiguous-start" | "project-access" | "boot" | "marker-write";
    },
    run: (fixture: {
      start: (shortId?: boolean) => Promise<unknown>;
      auth: () => Promise<string>;
      marker: () => Promise<string>;
      stagedAuth: () => Promise<string>;
    }) => Promise<void>,
  ): Promise<void> {
    const fullId = "a".repeat(64);
    environment.containerId = fullId;
    if (options.failure === "boot") {
      resetImageManifestCache();
      environment.containerLifecycle = {
        schemaVersion: 1,
        revision: 0,
        lastRuntimeGeneration: 1,
        runtime: {
          containerId: fullId,
          runtimeGeneration: 1,
          owner: dockerOwnerNamespace(storage.getDataDir()),
          imageId: `sha256:${"b".repeat(64)}`,
        },
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        outcomes: [],
      };
    }
    context.storage.loadConfig = async () =>
      ({ global: { enabledAgentPlatforms: ["codex"] } }) as never;
    const lifecycle = memoryLifecycleContext([environment], storage.getDataDir()).context;
    context.runtime = lifecycle.runtime;
    context.environmentLifecycleTasks = lifecycle.environmentLifecycleTasks;
    context.emit = lifecycle.emit;
    const revision = await stage();
    const authFile = path.join(root, "installed-auth.json");
    const markerFile = path.join(root, "installed-marker");
    const runningFile = path.join(root, "running");
    const failedMarkerWrite = path.join(root, "failed-marker-write");
    await write(authFile, '{"OPENAI_API_KEY":"codex-host"}');
    await write(markerFile, "default");
    await write(runningFile, String(options.running ?? false));
    const commands = new Map<string, CommandHandler>();
    registerDockerCommands(
      (name, handler) => commands.set(name, handler),
      {} as RegistryDependencies,
    );
    // Exercise the real registry, lifecycle queue, restaging and Docker command
    // boundary. Only the daemon is replaced; its installed login is independent
    // of staged inputs and changes on a genuine boot or an actual credential pipe.
    const script = `#!/usr/bin/env bun
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
const [command, ...args] = process.argv.slice(2);
const auth = ${JSON.stringify(authFile)};
const marker = ${JSON.stringify(markerFile)};
const running = ${JSON.stringify(runningFile)};
const failure = ${JSON.stringify(options.failure ?? null)};
const failedMarkerWrite = ${JSON.stringify(failedMarkerWrite)};
if (command === "inspect") {
  const format = args[1];
  if (format.includes(".State.Running")) console.log(readFileSync(running, "utf8"));
  else if (format.includes("orkestrator-owner")) console.log(${JSON.stringify(dockerOwnerNamespace(storage.getDataDir()))} + "\\trunning\\torkestrator-v2\\t" + ${JSON.stringify(fullId)});
  else if (format.includes("orkestrator-inputs-revision")) console.log(${JSON.stringify(revision)});
  else process.exit(1);
} else if (command === "start") {
  if (failure === "start") process.exit(17);
  if (readFileSync(running, "utf8") !== "true") {
    if (${JSON.stringify(options.entrypointInvalidates ?? false)}) writeFileSync(marker, "unstaged");
    copyFileSync(${JSON.stringify(staged(revision, "codex-home/auth.json"))}, auth);
    writeFileSync(running, "true");
  }
  if (failure === "ambiguous-start") process.exit(17);
} else if (command === "exec") {
  if (readFileSync(running, "utf8") !== "true") process.exit(18);
  if (args[0] === "--user") {
    if (failure === "project-access") process.exit(19);
  } else {
    const text = args.at(-1);
    if (text.includes("/run/orkestrator/boot-status.json")) {
      console.log(JSON.stringify({ version: 1, bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", pid1Start: "5000", phase: "failed", failureCode: "entrypoint-failed" }));
      console.log("5000");
    } else if (text.startsWith("cat /tmp/orkestrator-codex-account")) console.log(readFileSync(marker, "utf8"));
    else if (text.includes("/tmp/orkestrator-codex-account")) {
      if (failure === "marker-write" && !existsSync(failedMarkerWrite)) {
        writeFileSync(failedMarkerWrite, "failed");
        process.exit(23);
      }
      const value = text.match(/printf '%s' '([^']*)'/)?.[1];
      if (value === undefined) process.exit(20);
      writeFileSync(marker, value);
    } else if (text.includes("/home/node/.codex/auth.json")) writeFileSync(auth, await Bun.stdin.text());
    else process.exit(21);
  }
} else if (command === "create") console.log("manifest-probe");
else if (command === "cp") {
  const body = Buffer.from(JSON.stringify({ schemaVersion: 1, appVersion: "1.0.0", sourceRevision: null, architecture: "arm64", runtimes: {}, agents: {}, bridges: [], capabilities: { "boot-status": 1 }, stateFormats: {} }));
  const header = Buffer.alloc(512);
  header.write("image-manifest.json");
  header.write(body.length.toString(8).padStart(11, "0"), 124);
  header[156] = 48;
  process.stdout.write(Buffer.concat([header, body]));
} else if (command !== "rm") process.exit(22);
`;
    try {
      await withDockerScript(script, async () =>
        run({
          // A short id must still use the assigned environment's lifecycle path.
          start: async (shortId = true) =>
            commands.get("docker_start_container")!(
              { containerId: shortId ? fullId.slice(0, 12) : fullId },
              context,
            ),
          auth: () => fs.readFile(authFile, "utf8"),
          marker: () => fs.readFile(markerFile, "utf8"),
          stagedAuth: () => fs.readFile(staged(revision, "codex-home/auth.json"), "utf8"),
        }),
      );
    } finally {
      lifecycle.runtime.shutdown();
      resetImageManifestCache();
    }
  }

  test("overlapping short and full id starts cannot consume or replace an installed marker", async () => {
    await withStartFixture({}, async (fixture) => {
      await addAccounts({ codex: CODEX_ID });
      await Promise.all([fixture.start(), fixture.start(false)]);
      expect(await fixture.auth()).toBe('{"OPENAI_API_KEY":"codex-2"}');
      expect(await fixture.marker()).toBe("unstaged");
      await addAccounts({});
      await reconcileContainerAgentAccount(context, environment.containerId!, "codex", {
        isRunning: async () => false,
        stop: async () => {},
      });
      expect(await fixture.auth()).toBe('{"OPENAI_API_KEY":"codex-host"}');
      expect(await fixture.marker()).toBe("default");
    });
  });

  test("entrypoint invalidation survives a failed backend marker write", async () => {
    await withStartFixture(
      { entrypointInvalidates: true, failure: "marker-write" },
      async (fixture) => {
        await addAccounts({ codex: CODEX_ID });
        await fixture.start();
        expect(await fixture.auth()).toBe('{"OPENAI_API_KEY":"codex-2"}');
        expect(await fixture.marker()).toBe("unstaged");
        await addAccounts({});
        await reconcileContainerAgentAccount(context, environment.containerId!, "codex", {
          isRunning: async () => false,
          stop: async () => {},
        });
        expect(await fixture.auth()).toBe('{"OPENAI_API_KEY":"codex-host"}');
        expect(await fixture.marker()).toBe("default");
      },
    );
  });

  for (const busy of [false, true]) {
    test(`a no-op start preserves the installed host login until the bridge is idle (busy=${busy})`, async () => {
      await withStartFixture({ running: true }, async (fixture) => {
        await addAccounts({ codex: CODEX_ID });
        liveWork = busy;
        await fixture.start();
        expect(await fixture.marker()).toBe("default");
        expect(await fixture.auth()).toContain("codex-host");
        expect(await fixture.stagedAuth()).toBe('{"OPENAI_API_KEY":"codex-host"}');
        let stopped = 0;
        const bridge = {
          isRunning: async () => true,
          stop: async () => {
            stopped++;
          },
        };
        await reconcileContainerAgentAccount(context, environment.containerId!, "codex", bridge);
        if (busy) {
          expect(stopped).toBe(0);
          expect(await fixture.auth()).toContain("codex-host");
          liveWork = false;
          await reconcileContainerAgentAccount(context, environment.containerId!, "codex", bridge);
        }
        expect(await fixture.auth()).toBe('{"OPENAI_API_KEY":"codex-2"}');
        expect(await fixture.marker()).toBe(CODEX_ID);
        expect(stopped).toBe(1);
      });
    });
  }

  for (const failure of [
    undefined,
    "project-access",
    "boot",
    "ambiguous-start",
    "start",
  ] as const) {
    test(`a real start leaves a recoverable marker through ${failure ?? "successful startup"}`, async () => {
      await withStartFixture({ failure }, async (fixture) => {
        await addAccounts({ codex: CODEX_ID });
        if (failure)
          await expect(fixture.start()).rejects.toThrow(
            failure === "boot" ? "entrypoint-failed" : undefined,
          );
        else await fixture.start();
        if (failure === "start") {
          // No entrypoint ran: a rejected exec cannot certify a staged account.
          expect(await fixture.auth()).toContain("codex-host");
          expect(await fixture.marker()).toBe("default");
          return;
        }
        expect(await fixture.auth()).toContain("codex-2");
        expect(await fixture.marker()).toBe("unstaged");
        await addAccounts({});
        await reconcileContainerAgentAccount(context, environment.containerId!, "codex", {
          isRunning: async () => false,
          stop: async () => {},
        });
        expect(await fixture.auth()).toBe('{"OPENAI_API_KEY":"codex-host"}');
        expect(await fixture.marker()).toBe("default");
      });
    });
  }
});

describe("syncContainerGrokLogin", () => {
  const grokAuth = () => path.join(root, "host-home", ".grok", "auth.json");

  function enableGrok(): void {
    context.storage.loadConfig = async () =>
      ({ global: { enabledAgentPlatforms: ["claude", "codex", "grok"] } }) as never;
    (context.credentialSources as Set<string>).add("grok");
  }

  test("pipes the host's current Grok login in, access-only", async () => {
    enableGrok();
    await write(
      grokAuth(),
      JSON.stringify({
        live: {
          key: "grok-access",
          refresh_token: "SENTINEL-GROK-REFRESH",
          expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
        },
      }),
    );
    const fake = fakeRunners(null);
    await syncContainerGrokLogin(context, "container-1", fake.runners);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toContain("/home/node/.grok/auth.json");
    expect(JSON.parse(fake.calls[0]!.stdin!).live).toMatchObject({
      key: "grok-access",
      refresh_token: "",
    });
    expect(fake.calls[0]!.stdin).not.toContain("SENTINEL");
  });

  for (const pauseAt of ["authorization", "delivery"] as const) {
    test(`revocation fences an in-flight Grok sync paused at ${pauseAt}`, async () => {
      enableGrok();
      await write(
        grokAuth(),
        JSON.stringify({
          live: { key: "access", expires_at: new Date(Date.now() + 3600_000).toISOString() },
        }),
      );
      const paused = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const revoked = Promise.withResolvers<void>();
      const update = context.storage.updateEnvironment.bind(context.storage);
      context.storage.updateEnvironment = async (...args) => {
        const result = await update(...args);
        revoked.resolve();
        return result;
      };
      const fake = fakeRunners(null);
      let credentialPresent = false;
      if (pauseAt === "authorization") {
        context.storage.getEnvironment = async () => {
          paused.resolve();
          await resume.promise;
          return structuredClone(environment);
        };
      } else {
        fake.runners.pipe = async () => {
          paused.resolve();
          await resume.promise;
          credentialPresent = true;
        };
      }
      await withDockerScript(
        `#!/bin/sh
case "$*" in *"rm -f"*) printf 'removed: %s\\n' "$*" >> "$FAKE_DOCKER_LOG" ;; esac
exit 0
`,
        async (log) => {
          // A shortened Docker ID must serialize with revocation's persisted ID.
          const sync = syncContainerGrokLogin(context, "container-", fake.runners);
          await paused.promise;
          // Revocation's own lookup must remain available while sync is paused.
          context.storage.getEnvironment = async () => structuredClone(environment);
          let cleanupComplete = false;
          const revoke = revokeProviderCredentials(environment.id, "grok", context).then(
            (result) => {
              cleanupComplete = true;
              credentialPresent = false;
              return result;
            },
          );
          try {
            await revoked.promise;
            expect(cleanupComplete).toBe(false);
            expect(await log.read()).toBe("");
          } finally {
            resume.resolve();
          }
          await sync;
          expect((await revoke).removed).toBe(true);
          expect(await log.read()).toContain("removed");
          expect(await log.read()).toContain("/home/node/.grok/xai-api-key");
          expect(credentialPresent).toBe(false);
          if (pauseAt === "authorization") expect(fake.calls).toEqual([]);
          // A later sync cannot restore the revoked credential either.
          await syncContainerGrokLogin(context, "container-1", fake.runners);
          expect(credentialPresent).toBe(false);
        },
      );
    });
  }

  test("an expired or absent host login leaves the container's copy alone", async () => {
    enableGrok();
    const fake = fakeRunners(null);
    await syncContainerGrokLogin(context, "container-1", fake.runners);
    await write(
      grokAuth(),
      JSON.stringify({ old: { key: "k", refresh_token: "r", expires_at: "2026-01-01T00:00:00Z" } }),
    );
    await syncContainerGrokLogin(context, "container-1", fake.runners);
    expect(fake.calls).toEqual([]);
  });

  test("an unauthorized, revoked or unknown container is never handed a login", async () => {
    await write(
      grokAuth(),
      JSON.stringify({
        live: { key: "k", expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
    );
    const fake = fakeRunners(null);
    // Grok is not authorized for this agent-test profile.
    await syncContainerGrokLogin(context, "container-1", fake.runners);
    enableGrok();
    environment.revokedInputProviders = ["grok"];
    await syncContainerGrokLogin(context, "container-1", fake.runners);
    environment.revokedInputProviders = [];
    await syncContainerGrokLogin(context, "other-container", fake.runners);
    expect(fake.calls).toEqual([]);
  });
});
