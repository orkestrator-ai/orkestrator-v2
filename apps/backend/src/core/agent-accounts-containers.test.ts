import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  activeAgentAccountInputRoots,
  reconcileContainerAgentAccount,
  refreshStagedAgentAccountLogins,
  syncContainerAgentAccountsOnStart,
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
  await write(path.join(accountHome("codex", CODEX_ID), "auth.json"), '{"account":"codex-2"}');
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
  await write(path.join(root, "host-codex", "auth.json"), '{"account":"codex-host"}');
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
    loadEnvironments: async () => [environment],
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

    expect(await read("codex-home/auth.json")).toBe('{"account":"codex-2"}');
    expect(await read("codex-home/config.toml")).toBe('model = "host"');
    expect(await read("claude-config/.credentials.json")).toContain("claude-2");
    expect(await read("claude-config/CLAUDE.md")).toBe("host memory");
    expect(await read("files/claude.json/.claude.json")).toContain("second@example.com");
    const targets = result.mounts.map((mount) => mount.target);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).toContain("/codex-home");
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
  test("leaves containers alone until an account has been added", async () => {
    const revision = await stage();
    await write(staged(revision, "codex-home/auth.json"), "snapshot");
    await refreshStagedAgentAccountLogins(
      context,
      environment,
      "container-1",
      fakeRunners(revision).runners,
    );
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toBe("snapshot");
  });

  test("points a staged revision at the active account, and back at the host", async () => {
    const revision = await stage();
    await addAccounts({ codex: CODEX_ID, claude: CLAUDE_ID });
    const { runners } = fakeRunners(revision);

    await refreshStagedAgentAccountLogins(context, environment, "container-1", runners);
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toBe(
      '{"account":"codex-2"}',
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
      '{"account":"codex-host"}',
    );
    expect(
      await fs.readFile(staged(revision, "claude-config/.credentials.json"), "utf8"),
    ).toContain("claude-host");
  });
});

describe("syncContainerAgentAccountsOnStart", () => {
  test("pipes the active Claude account's login and resets the Codex marker", async () => {
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
    expect(fake.markers.has("/tmp/orkestrator-codex-account")).toBe(false);
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

  test("writes the new login in and replaces an idle bridge", async () => {
    const revision = await stage();
    await addAccounts({ codex: CODEX_ID });
    const fake = fakeRunners(revision);
    const { state, control } = bridge(true);

    await reconcileContainerAgentAccount(context, "container-1", "codex", control, fake.runners);

    const piped = fake.calls.find((call) => call.kind === "pipe");
    expect(piped?.command).toContain("/home/node/.codex/auth.json");
    expect(piped?.stdin).toBe('{"account":"codex-2"}');
    expect(fake.markers.get("/tmp/orkestrator-codex-account")).toBe(CODEX_ID);
    expect(state.stopped).toBe(1);
    // A restart keeps the account: the entrypoint imports the staged login.
    expect(await fs.readFile(staged(revision, "codex-home/auth.json"), "utf8")).toBe(
      '{"account":"codex-2"}',
    );

    await reconcileContainerAgentAccount(context, "container-1", "codex", control, fake.runners);
    expect(fake.calls.filter((call) => call.kind === "pipe")).toHaveLength(1);
    expect(state.stopped).toBe(1);
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
