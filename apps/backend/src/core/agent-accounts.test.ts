import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import {
  AGENT_ACCOUNTS_CHANGED_EVENT,
  MAX_AGENT_ACCOUNTS_PER_PLATFORM,
} from "@orkestrator/protocol/agent-accounts";

import {
  agentAccountLoginProgress,
  cancelAgentAccountLogin,
  listAgentAccounts,
  readAgentAccountUsage,
  removeAgentAccount,
  renameAgentAccount,
  resetAgentAccountLoginForTests,
  setActiveAgentAccount,
  startAgentAccountLogin,
} from "./agent-accounts.js";
import { applyActiveAgentAccountEnvironment } from "./agent-accounts-active.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { SpawnLike } from "./agent-accounts-login.js";
import type { CommandContext } from "./commands-context.js";
import type { PlanUsageReader } from "./plan-usage.js";
import {
  rememberAgentAccountUsage,
  resetAgentAccountLastUsageForTests,
} from "./agent-accounts-last-usage.js";
import { contextUsageWithPlanUsage, sharedPlanUsageCache } from "./plan-usage-cache.js";
import { StorageService } from "./storage.js";

let root: string;
let context: CommandContext;
const savedEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  ORKESTRATOR_AGENT_TEST_HOST_HOME: process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME,
};

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function codexAuth(email: string, accountId: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      // Already expired, so a usage read answers without a network request.
      access_token: jwt({ exp: 1 }),
      refresh_token: "refresh",
      account_id: accountId,
      id_token: jwt({
        email,
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: accountId },
      }),
    },
  });
}

/** A `codex login --device-auth` that writes `auth.json` into CODEX_HOME and exits. */
function fakeCodexLogin(auth: string): SpawnLike {
  return (_command, _args, options) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, {
      stdout,
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    setTimeout(() => {
      stdout.write("https://auth.openai.com/codex/device\nABCD-EFGH1\n");
      setTimeout(async () => {
        await fs.writeFile(path.join(options.env.CODEX_HOME!, "auth.json"), auth);
        Object.assign(child, { exitCode: 0 });
        child.emit("exit", 0, null);
      }, 5);
    }, 1);
    return child;
  };
}

function fakeClaudeLogin(identity?: string): SpawnLike {
  return (_command, _args, options) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, {
      stdout,
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    setTimeout(() => {
      stdout.write("visit: https://claude.com/cai/oauth/authorize?state=test\n");
      setTimeout(async () => {
        await fs.writeFile(
          path.join(options.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
          JSON.stringify({ claudeAiOauth: { refreshToken: "refresh" } }),
        );
        if (identity)
          await fs.writeFile(
            path.join(options.env.CLAUDE_CONFIG_DIR!, ".claude.json"),
            JSON.stringify({
              oauthAccount: { accountUuid: identity, emailAddress: "claude@example.com" },
            }),
          );
        Object.assign(child, { exitCode: 0 });
        child.emit("exit", 0, null);
      }, 5);
    }, 1);
    return child;
  };
}

async function settledLogin() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const progress = agentAccountLoginProgress();
    if (progress.state !== "pending") return progress;
    await Bun.sleep(5);
  }
  throw new Error("login did not settle");
}

async function addCodexAccount(email: string, accountId: string) {
  await startAgentAccountLogin(context, "codex", {
    spawnImpl: fakeCodexLogin(codexAuth(email, accountId)),
    executable: "codex",
  });
  return settledLogin();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function usageReading(platform: "claude" | "codex", usedPercent = 42): PlanUsageSnapshot {
  return {
    platform,
    status: "ok",
    plan: "pro",
    windows: [{ window: "primary", usedPercent }],
    fetchedAt: new Date().toISOString(),
  };
}

/** Every event the backend announced during a test. */
let emitted: Array<{ event: string; payload: unknown }> = [];

beforeEach(async () => {
  emitted = [];
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-agent-accounts-")));
  process.env.CODEX_HOME = path.join(root, "host-codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "host-claude");
  process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = path.join(root, "host-home");
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  // An agent-test profile with no granted host credentials: nothing reads the
  // real Keychain or the real `~/.codex`.
  context = {
    storage,
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
    runtime: new BackendRuntime({ emit: () => undefined }),
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
  } as unknown as CommandContext;
  resetAgentAccountLoginForTests();
});

afterEach(async () => {
  sharedPlanUsageCache.clear();
  cancelAgentAccountLogin();
  resetAgentAccountLoginForTests();
  context.runtime.shutdown();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("agent accounts", () => {
  test("reserves the login slot before a delayed registry read", async () => {
    const original = context.storage.agentAccounts.loadAgentAccounts.bind(
      context.storage.agentAccounts,
    );
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.storage.agentAccounts.loadAgentAccounts = async () => {
      await delayed;
      return original();
    };
    let spawns = 0;
    const spawnImpl: SpawnLike = (...args) => {
      spawns += 1;
      return fakeCodexLogin(codexAuth("first@example.com", "first"))(...args);
    };
    const first = startAgentAccountLogin(context, "codex", { spawnImpl, executable: "codex" });
    const second = await startAgentAccountLogin(context, "codex", {
      spawnImpl,
      executable: "codex",
    });
    expect(second.state).toBe("pending");
    release();
    await first;
    expect(spawns).toBe(1);
    expect((await settledLogin()).state).toBe("succeeded");
  });

  test("Claude sign-in requires identity before storing credentials", async () => {
    await startAgentAccountLogin(context, "claude", {
      spawnImpl: fakeClaudeLogin(),
      executable: "claude",
    });
    const progress = await settledLogin();
    expect(progress.state).toBe("failed");
    expect(progress.error).toContain("account identity");
    expect(
      (await listAgentAccounts(context)).accounts.filter((a) => a.platform === "claude"),
    ).toHaveLength(1);
  });

  test("Claude sign-in stores its identity and refuses a duplicate", async () => {
    await startAgentAccountLogin(context, "claude", {
      spawnImpl: fakeClaudeLogin("claude-one"),
      executable: "claude",
    });
    const first = await settledLogin();
    expect(first.state).toBe("succeeded");
    await startAgentAccountLogin(context, "claude", {
      spawnImpl: fakeClaudeLogin("claude-one"),
      executable: "claude",
    });
    const duplicate = await settledLogin();
    expect(duplicate.state).toBe("failed");
    expect(duplicate.error).toContain("already added");
  });

  test("Claude sign-in refuses the already listed host identity", async () => {
    context.credentialSources = new Set(["claude"]);
    await fs.mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { refreshToken: "host-refresh" } }),
    );
    await fs.writeFile(
      path.join(process.env.CLAUDE_CONFIG_DIR!, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "host-identity" } }),
    );
    await startAgentAccountLogin(context, "claude", {
      spawnImpl: fakeClaudeLogin("host-identity"),
      executable: "claude",
    });
    const progress = await settledLogin();
    expect(progress.state).toBe("failed");
    expect(progress.error).toContain("host login");
  });

  test("cancellation during login startup still reaches the spawned process", async () => {
    let child: ChildProcess | undefined;
    let kills = 0;
    const spawnImpl: SpawnLike = () => {
      child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: () => {
          kills += 1;
          return true;
        },
      });
      return child;
    };
    const starting = startAgentAccountLogin(context, "claude", { spawnImpl, executable: "claude" });
    for (let n = 0; n < 100 && !child; n += 1) await Bun.sleep(1);
    expect(child).toBeDefined();
    cancelAgentAccountLogin();
    child!.stdout!.emit(
      "data",
      Buffer.from("visit: https://claude.com/cai/oauth/authorize?state=test\n"),
    );
    await expect(starting).rejects.toThrow("cancelled");
    expect(kills).toBe(1);
  });

  test("cleanup failure after duplicate login reports failure without an unhandled rejection", async () => {
    await addCodexAccount("existing@example.com", "existing");
    const original = fs.rm.bind(fs);
    const spy = spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (String(file).includes("agent-accounts/codex") && options?.recursive) {
        throw new Error("cleanup unavailable");
      }
      return original(file, options);
    });
    try {
      await startAgentAccountLogin(context, "codex", {
        spawnImpl: fakeCodexLogin(codexAuth("existing@example.com", "existing")),
        executable: "codex",
      });
      const progress = await settledLogin();
      expect(progress.state).toBe("failed");
      expect(progress.error).toContain("cleanup failed");
      await Bun.sleep(5);
    } finally {
      spy.mockRestore();
    }
  });

  test("enforces the per-platform account limit before spawning a CLI", async () => {
    await context.storage.agentAccounts.mutateAgentAccounts((store) => ({
      store: {
        ...store,
        accounts: Array.from({ length: MAX_AGENT_ACCOUNTS_PER_PLATFORM }, (_, index) => ({
          id: `11111111-2222-4333-8444-${String(index).padStart(12, "0")}`,
          platform: "codex" as const,
          label: `Account ${index}`,
          createdAt: "2026-09-28T00:00:00Z",
        })),
      },
      result: undefined,
    }));
    let spawns = 0;
    await expect(
      startAgentAccountLogin(context, "codex", {
        executable: "codex",
        spawnImpl: (...args) => {
          spawns += 1;
          return fakeCodexLogin("{}")(...args);
        },
      }),
    ).rejects.toThrow("No more accounts");
    expect(spawns).toBe(0);
  });
  describe("signing the active account in again", () => {
    function failingClaudeLogin(): SpawnLike {
      return () => {
        const child = new EventEmitter() as ChildProcess;
        const stdout = new PassThrough();
        Object.assign(child, {
          stdout,
          stderr: new PassThrough(),
          stdin: new PassThrough(),
          exitCode: null,
          signalCode: null,
          kill: () => true,
        });
        setTimeout(() => {
          stdout.write("visit: https://claude.com/cai/oauth/authorize?state=test\n");
          setTimeout(() => {
            Object.assign(child, { exitCode: 1 });
            child.emit("exit", 1, null);
          }, 5);
        }, 1);
        return child;
      };
    }

    async function addActiveClaudeAccount(identity: string): Promise<string> {
      await startAgentAccountLogin(context, "claude", {
        spawnImpl: fakeClaudeLogin(identity),
        executable: "claude",
      });
      const progress = await settledLogin();
      expect(progress.state).toBe("succeeded");
      await setActiveAgentAccount(context, "claude", progress.accountId!);
      cancelAgentAccountLogin();
      return progress.accountId!;
    }

    test("renews the active account in place and flags running bridges", async () => {
      const accountId = await addActiveClaudeAccount("claude-one");
      context.runtime.localServers.adoptProcess("claude:env-1", {} as never);
      let command: string[] = [];
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: (cmd, args, options) => {
          command = [cmd, ...args];
          expect(options.env.CLAUDE_CONFIG_DIR).toContain(".reauth/");
          expect(options.env.CLAUDE_CONFIG_DIR).not.toContain(accountId);
          return fakeClaudeLogin("claude-one")(cmd, args, options);
        },
      });
      expect(agentAccountLoginProgress().mode).toBe("reauthenticate");
      const progress = await settledLogin();

      expect(command).toEqual(["claude", "auth", "login"]);
      expect(progress).toMatchObject({ state: "succeeded", accountId, mode: "reauthenticate" });
      const claude = (await listAgentAccounts(context)).accounts.filter(
        (a) => a.platform === "claude",
      );
      expect(claude).toHaveLength(2);
      expect(claude.some((a) => a.id === accountId && a.isActive)).toBe(true);
      expect(context.runtime.localServers.hasStaleLogin("claude:env-1")).toBe(true);
    });

    test.each(["original", "replacement"])(
      "renewal as %s keeps fallback only for the same identity after reload",
      async (identity) => {
        const id = await addActiveClaudeAccount("original");
        const reading = usageReading("claude");
        await rememberAgentAccountUsage(
          context.storage.agentAccounts.agentAccountsDirectory(),
          "claude",
          id,
          reading,
        );
        await startAgentAccountLogin(context, "claude", {
          reauthenticate: true,
          executable: "claude",
          spawnImpl: fakeClaudeLogin(identity),
        });
        expect((await settledLogin()).state).toBe("succeeded");
        resetAgentAccountLoginForTests();
        const failure: PlanUsageSnapshot = {
          platform: "claude",
          status: "error",
          windows: [],
          message: "usage failed",
          fetchedAt: new Date().toISOString(),
        };
        const reader = (async () => failure) as unknown as PlanUsageReader;
        const result = await readAgentAccountUsage(context, "claude", id, { reader });
        if (identity === "original")
          expect(result).toMatchObject({ stale: true, windows: reading.windows, plan: "pro" });
        else expect(result).toBe(failure);
      },
    );

    test("renewal rejects a late usage reading from the replaced identity", async () => {
      const id = await addActiveClaudeAccount("original");
      const started = deferred<void>();
      const response = deferred<PlanUsageSnapshot>();
      const reader = (async () => {
        started.resolve();
        return response.promise;
      }) as unknown as PlanUsageReader;
      const pending = readAgentAccountUsage(context, "claude", id, { reader });
      const rejected = pending.catch((error: unknown) => error);
      await started.promise;
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: fakeClaudeLogin("replacement"),
      });
      expect((await settledLogin()).state).toBe("succeeded");
      response.resolve(usageReading("claude"));
      expect(await rejected).toEqual(
        expect.objectContaining({ message: expect.stringContaining("account changed") }),
      );
      await expect(
        fs.stat(
          path.join(context.storage.agentAccounts.agentAccountsDirectory(), "last-usage.json"),
        ),
      ).rejects.toThrow();
    });

    test("keeps successful reauthentication non-fatal when post-login catalogue lookup fails", async () => {
      const accountId = await addActiveClaudeAccount("claude-cache-failure");
      let cacheReads = 0;
      context.storage.getAgentModelCatalogCache = async () => {
        cacheReads += 1;
        throw new Error("catalogue storage unavailable");
      };
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await startAgentAccountLogin(context, "claude", {
          reauthenticate: true,
          executable: "claude",
          spawnImpl: fakeClaudeLogin("claude-cache-failure"),
        });

        await expect(settledLogin()).resolves.toMatchObject({
          state: "succeeded",
          accountId,
          mode: "reauthenticate",
        });
        await Promise.resolve();
        expect(cacheReads).toBe(1);
      } finally {
        warn.mockRestore();
      }
    });

    test("a failed sign-in keeps the account it was renewing", async () => {
      const accountId = await addActiveClaudeAccount("claude-one");
      const home = path.join(root, "data", "agent-accounts", "claude", accountId);
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: failingClaudeLogin(),
      });
      const progress = await settledLogin();

      expect(progress.state).toBe("failed");
      await expect(fs.stat(home)).resolves.toBeDefined();
      expect((await listAgentAccounts(context)).accounts.some((a) => a.id === accountId)).toBe(
        true,
      );
    });

    async function savedLogin(home: string) {
      return Promise.all(
        [".credentials.json", ".claude.json"].map((name) =>
          fs.readFile(path.join(home, name), "utf8"),
        ),
      );
    }

    test("rejects sibling identity without changing the active credential, identity or registry", async () => {
      await addActiveClaudeAccount("sibling");
      const id = await addActiveClaudeAccount("original");
      context.runtime.localServers.adoptProcess("claude:env-1", {} as never);
      const home = path.join(context.storage.agentAccounts.agentAccountsDirectory(), "claude", id);
      const before = await savedLogin(home);
      const registry = await context.storage.agentAccounts.loadAgentAccounts();
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: fakeClaudeLogin("sibling"),
      });
      expect(await settledLogin()).toMatchObject({
        state: "failed",
        error: expect.stringContaining("already added"),
      });
      expect(await savedLogin(home)).toEqual(before);
      expect(await context.storage.agentAccounts.loadAgentAccounts()).toEqual(registry);
      expect(context.runtime.localServers.hasStaleLogin("claude:env-1")).toBe(false);
    });

    test("rejects renewing an added account as the host identity", async () => {
      const id = await addActiveClaudeAccount("original");
      context.credentialSources = new Set(["claude"]);
      const host = process.env.CLAUDE_CONFIG_DIR!;
      await fs.mkdir(host, { recursive: true });
      await fs.writeFile(
        path.join(host, ".credentials.json"),
        '{"claudeAiOauth":{"refreshToken":"host"}}',
      );
      await fs.writeFile(
        path.join(host, ".claude.json"),
        '{"oauthAccount":{"accountUuid":"host"}}',
      );
      const home = path.join(context.storage.agentAccounts.agentAccountsDirectory(), "claude", id);
      const before = await savedLogin(home);
      const registry = await context.storage.agentAccounts.loadAgentAccounts();
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: fakeClaudeLogin("host"),
      });
      expect(await settledLogin()).toMatchObject({
        state: "failed",
        error: expect.stringContaining("host login"),
      });
      expect(await savedLogin(home)).toEqual(before);
      expect(await context.storage.agentAccounts.loadAgentAccounts()).toEqual(registry);
    });

    test("host renewal rejects an added identity and preserves its previous files", async () => {
      await addActiveClaudeAccount("sibling");
      await setActiveAgentAccount(context, "claude", "default");
      context.runtimeFlavor = "production" as CommandContext["runtimeFlavor"];
      const host = process.env.CLAUDE_CONFIG_DIR!;
      await fs.mkdir(host, { recursive: true });
      await fs.writeFile(
        path.join(host, ".credentials.json"),
        '{"claudeAiOauth":{"refreshToken":"old-host"}}',
      );
      await fs.writeFile(
        path.join(host, ".claude.json"),
        '{"oauthAccount":{"accountUuid":"old-host"}}',
      );
      const before = await savedLogin(host);
      const registry = await context.storage.agentAccounts.loadAgentAccounts();
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: fakeClaudeLogin("sibling"),
      });
      expect(await settledLogin()).toMatchObject({
        state: "failed",
        error: expect.stringContaining("already added"),
      });
      expect(await savedLogin(host)).toEqual(before);
      expect(await context.storage.agentAccounts.loadAgentAccounts()).toEqual(registry);
    });

    test("host renewal preserves configuration and persists a refresh generation", async () => {
      context.runtimeFlavor = "production" as CommandContext["runtimeFlavor"];
      const host = process.env.CLAUDE_CONFIG_DIR!;
      await fs.mkdir(host, { recursive: true });
      await fs.writeFile(
        path.join(host, ".claude.json"),
        '{"projects":{"keep":{}},"oauthAccount":{"accountUuid":"old"}}',
      );
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: fakeClaudeLogin("new-host"),
      });
      const progress = await settledLogin();
      expect(progress).toMatchObject({ state: "succeeded", accountId: "default" });
      expect(JSON.parse(await fs.readFile(path.join(host, ".claude.json"), "utf8"))).toMatchObject({
        projects: { keep: {} },
        oauthAccount: { accountUuid: "new-host" },
      });
      expect(
        (await context.storage.agentAccounts.loadAgentAccounts()).loginGeneration?.claude,
      ).toBe(progress.operationId);
    });

    test("registry failure rolls back promoted files", async () => {
      const id = await addActiveClaudeAccount("original");
      const home = path.join(context.storage.agentAccounts.agentAccountsDirectory(), "claude", id);
      const before = await savedLogin(home);
      const registry = await context.storage.agentAccounts.loadAgentAccounts();
      const spy = spyOn(context.storage.agentAccounts, "mutateAgentAccounts").mockImplementation(
        async (mutate) => {
          await mutate(await context.storage.agentAccounts.loadAgentAccounts());
          throw new Error("store unavailable");
        },
      );
      try {
        await startAgentAccountLogin(context, "claude", {
          reauthenticate: true,
          executable: "claude",
          spawnImpl: fakeClaudeLogin("new"),
        });
        expect(await settledLogin()).toMatchObject({
          state: "failed",
          error: expect.stringContaining("store unavailable"),
        });
        expect(await savedLogin(home)).toEqual(before);
        expect(await context.storage.agentAccounts.loadAgentAccounts()).toEqual(registry);
      } finally {
        spy.mockRestore();
      }
    });

    test("successful renewal refreshes identity and email-derived label", async () => {
      const id = await addActiveClaudeAccount("original");
      await context.storage.agentAccounts.mutateAgentAccounts((store) => ({
        store: {
          ...store,
          accounts: store.accounts.map((a) => ({
            ...a,
            label: "old@example.com",
            identity: { email: "old@example.com" },
          })),
        },
        result: undefined,
      }));
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: fakeClaudeLogin("new"),
      });
      expect((await settledLogin()).state).toBe("succeeded");
      expect(
        (await context.storage.agentAccounts.loadAgentAccounts()).accounts.find((a) => a.id === id),
      ).toMatchObject({
        identityKey: "claude:new:",
        label: "claude@example.com",
        identity: { email: "claude@example.com" },
      });
    });

    test("cancellation after the CLI writes cannot alter the active login", async () => {
      const id = await addActiveClaudeAccount("original");
      const home = path.join(context.storage.agentAccounts.agentAccountsDirectory(), "claude", id);
      const before = await savedLogin(home);
      const registry = await context.storage.agentAccounts.loadAgentAccounts();
      let child!: ChildProcess;
      let temporary = "";
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: (_cmd, _args, options) => {
          temporary = options.env.CLAUDE_CONFIG_DIR!;
          child = new EventEmitter() as ChildProcess;
          const stdout = new PassThrough();
          Object.assign(child, {
            stdout,
            stderr: new PassThrough(),
            stdin: new PassThrough(),
            exitCode: null,
            signalCode: null,
            kill: () => true,
          });
          setTimeout(() => stdout.write("https://claude.com/cai/oauth/authorize?state=test\n"), 1);
          return child;
        },
      });
      await fs.writeFile(
        path.join(temporary, ".credentials.json"),
        '{"claudeAiOauth":{"refreshToken":"cancelled"}}',
      );
      await fs.writeFile(
        path.join(temporary, ".claude.json"),
        '{"oauthAccount":{"accountUuid":"cancelled"}}',
      );
      const operationId = agentAccountLoginProgress().operationId;
      expect(cancelAgentAccountLogin(operationId).state).toBe("idle");
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, null);
      for (
        let n = 0;
        n < 100 &&
        (await fs.stat(temporary).then(
          () => true,
          () => false,
        ));
        n++
      )
        await Bun.sleep(5);
      expect(await savedLogin(home)).toEqual(before);
      expect(await context.storage.agentAccounts.loadAgentAccounts()).toEqual(registry);
      await expect(fs.stat(temporary)).rejects.toThrow();
    });

    test("an old result cannot cancel a newer operation", async () => {
      await addActiveClaudeAccount("original");
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: fakeClaudeLogin("original"),
      });
      const old = await settledLogin();
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: fakeClaudeLogin("original"),
      });
      const pending = agentAccountLoginProgress();
      expect(cancelAgentAccountLogin(old.operationId)).toEqual(pending);
      expect((await settledLogin()).state).toBe("succeeded");
    });

    test("refuses to write the host login from an agent-test profile", async () => {
      let spawns = 0;
      await expect(
        startAgentAccountLogin(context, "claude", {
          reauthenticate: true,
          executable: "claude",
          spawnImpl: (...args) => {
            spawns += 1;
            return fakeClaudeLogin("host")(...args);
          },
        }),
      ).rejects.toThrow("host login");
      expect(spawns).toBe(0);
    });

    test("is not offered for Codex", async () => {
      await expect(
        startAgentAccountLogin(context, "codex", { reauthenticate: true }),
      ).rejects.toThrow("only available for Claude");
    });

    test("cannot start while an add-account sign-in is pending", async () => {
      await startAgentAccountLogin(context, "claude", {
        spawnImpl: fakeClaudeLogin("claude-one"),
        executable: "claude",
      });
      await expect(
        startAgentAccountLogin(context, "claude", { reauthenticate: true, executable: "claude" }),
      ).rejects.toThrow("Finish or cancel");
      // Let the fake CLI finish writing before the directory is removed.
      await settledLogin();
    });
  });

  test("lists the host login for each platform before anything is added", async () => {
    const snapshot = await listAgentAccounts(context);
    expect(snapshot.active).toEqual({ claude: "default", codex: "default" });
    expect(snapshot.accounts.map((a) => [a.platform, a.id, a.isDefault, a.isActive])).toEqual([
      ["claude", "default", true, true],
      ["codex", "default", true, true],
    ]);
  });

  test("a device-code sign-in adds an account named after its login", async () => {
    const progress = await addCodexAccount("second@example.com", "acct-2");
    expect(progress.state).toBe("succeeded");

    const snapshot = await listAgentAccounts(context);
    const added = snapshot.accounts.find((a) => a.platform === "codex" && !a.isDefault)!;
    expect(added).toMatchObject({
      id: progress.accountId,
      label: "second@example.com",
      signedIn: true,
      isActive: false,
      identity: { email: "second@example.com", plan: "plus" },
    });
    const home = path.join(root, "data", "agent-accounts", "codex", added.id);
    expect(await fs.readlink(path.join(home, "sessions"))).toBe(
      path.join(process.env.CODEX_HOME!, "sessions"),
    );
    expect(added.privateEntries).toBeUndefined();

    // The CLI replaced the shared link while saving: the account says so.
    await fs.rm(path.join(home, "sessions"));
    await fs.mkdir(path.join(home, "sessions"));
    const replaced = (await listAgentAccounts(context)).accounts.find((a) => a.id === added.id);
    expect(replaced?.privateEntries).toEqual(["sessions"]);
    expect(
      (await listAgentAccounts(context)).accounts.find((a) => a.isDefault)?.privateEntries,
    ).toBeUndefined();
  });

  test("the same login cannot be added twice", async () => {
    const first = await addCodexAccount("second@example.com", "acct-2");
    const second = await addCodexAccount("second@example.com", "acct-2");

    expect(second.state).toBe("failed");
    expect(second.error).toContain("already added");
    const codexAccounts = await fs.readdir(path.join(root, "data", "agent-accounts", "codex"));
    expect(codexAccounts).toEqual([first.accountId!]);
  });

  test("switching changes the launch environment and removal requires switching away", async () => {
    const { accountId } = await addCodexAccount("second@example.com", "acct-2");
    const env: NodeJS.ProcessEnv = {};
    expect(await applyActiveAgentAccountEnvironment(context, "codex", env)).toBe("default");
    expect(env.CODEX_HOME).toBeUndefined();

    const switched = await setActiveAgentAccount(context, "codex", accountId!);
    expect(switched.active.codex).toBe(accountId!);
    expect(await applyActiveAgentAccountEnvironment(context, "codex", env)).toBe(accountId!);
    expect(env.CODEX_HOME).toBe(path.join(root, "data", "agent-accounts", "codex", accountId!));

    await expect(removeAgentAccount(context, "codex", accountId!)).rejects.toThrow(
      "Switch to another account",
    );
    await setActiveAgentAccount(context, "codex", "default");
    const removed = await removeAgentAccount(context, "codex", accountId!);
    expect(removed.accounts.filter((a) => a.platform === "codex")).toHaveLength(1);
    await expect(fs.stat(env.CODEX_HOME!)).rejects.toThrow();
    // The link's target is the host's, and removing the account never touches it.
    expect((await fs.stat(path.join(process.env.CODEX_HOME!, "sessions"))).isDirectory()).toBe(
      true,
    );
  });

  test("a running terminal retains its account home until it exits", async () => {
    const { accountId } = await addCodexAccount("terminal@example.com", "terminal");
    const home = path.join(root, "data", "agent-accounts", "codex", accountId!);
    context.runtime.terminals.recordAccountHome("terminal-1", home);
    await expect(removeAgentAccount(context, "codex", accountId!)).rejects.toThrow("terminal");
    expect((await fs.stat(home)).isDirectory()).toBe(true);
    context.runtime.terminals.forgetAccountHome("terminal-1");
    await removeAgentAccount(context, "codex", accountId!);
  });

  test("failed directory cleanup leaves the account listed for retry", async () => {
    const { accountId } = await addCodexAccount("retry@example.com", "retry");
    const home = path.join(root, "data", "agent-accounts", "codex", accountId!);
    const original = fs.rm.bind(fs);
    const spy = spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (file === home) throw new Error("disk failure");
      return original(file, options);
    });
    try {
      await expect(removeAgentAccount(context, "codex", accountId!)).rejects.toThrow(
        "disk failure",
      );
      expect((await listAgentAccounts(context)).accounts.some((a) => a.id === accountId)).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
    await removeAgentAccount(context, "codex", accountId!);
  });

  test("announces every change to the accounts, and nothing for a switch to the same one", async () => {
    const changes = () =>
      emitted.filter((entry) => entry.event === AGENT_ACCOUNTS_CHANGED_EVENT).map((e) => e.payload);
    const { accountId } = await addCodexAccount("second@example.com", "acct-2");
    expect(changes()).toEqual([{ platform: "codex" }]);
    await setActiveAgentAccount(context, "codex", accountId!);
    await setActiveAgentAccount(context, "codex", accountId!);
    expect(changes()).toHaveLength(2);
    await renameAgentAccount(context, "codex", accountId!, "Work");
    await setActiveAgentAccount(context, "codex", "default");
    await removeAgentAccount(context, "codex", accountId!);
    expect(changes()).toEqual(Array.from({ length: 5 }, () => ({ platform: "codex" })));
    // The announcement only says that something changed.
    expect(emitted.every((entry) => !JSON.stringify(entry.payload).includes("@"))).toBe(true);
  });

  test("rejects unknown accounts and renames added ones", async () => {
    await expect(setActiveAgentAccount(context, "codex", "not-an-id")).rejects.toThrow(
      "Unknown agent account",
    );
    const { accountId } = await addCodexAccount("second@example.com", "acct-2");
    const renamed = await renameAgentAccount(context, "codex", accountId!, "  Work  ");
    expect(renamed.accounts.find((a) => a.id === accountId)?.label).toBe("Work");
    await expect(renameAgentAccount(context, "codex", "default", "Host")).rejects.toThrow();
  });

  test("usage for the active account comes from the shared reader, others from their own login", async () => {
    const { accountId } = await addCodexAccount("second@example.com", "acct-2");
    const shared: PlanUsageSnapshot = {
      platform: "codex",
      status: "ok",
      windows: [],
      fetchedAt: new Date(0).toISOString(),
    };
    const calls: unknown[] = [];
    const reader = (async (_context, platform, options) => {
      calls.push([platform, options]);
      return shared;
    }) as PlanUsageReader;

    expect(await readAgentAccountUsage(context, "codex", "default", { reader })).toBe(shared);
    expect(calls).toEqual([["codex", { force: false }]]);

    const inactive = await readAgentAccountUsage(context, "codex", accountId!, { reader });
    expect(inactive.status).toBe("unavailable");
    expect(inactive.message).toContain("expired");
    expect(calls).toHaveLength(1);
  });

  test("an account left behind shows its last known usage until removed", async () => {
    const { accountId } = await addCodexAccount("second@example.com", "acct-2");
    const reading = (usedPercent: number): PlanUsageSnapshot => ({
      platform: "codex",
      status: "ok",
      windows: [{ window: "primary", usedPercent }],
      fetchedAt: new Date().toISOString(),
    });
    const reader = (async () => {
      throw new Error("the active account is not read here");
    }) as unknown as PlanUsageReader;

    sharedPlanUsageCache.store("codex", reading(12), 60_000);
    await setActiveAgentAccount(context, "codex", accountId!);
    const host = await readAgentAccountUsage(context, "codex", "default", { reader });
    expect(host).toMatchObject({ status: "ok", stale: true, windows: [{ usedPercent: 12 }] });
    expect(host.message).toContain("Sign in to Codex");

    sharedPlanUsageCache.store("codex", reading(34), 60_000);
    await setActiveAgentAccount(context, "codex", "default");
    const added = await readAgentAccountUsage(context, "codex", accountId!, { reader });
    expect(added).toMatchObject({ stale: true, windows: [{ usedPercent: 34 }] });

    await removeAgentAccount(context, "codex", accountId!);
    const saved = JSON.parse(
      await fs.readFile(path.join(root, "data", "agent-accounts", "last-usage.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual(["codex:default"]);
  });
  test("switches stay serialized while the outgoing usage write is paused", async () => {
    const b = (await addCodexAccount("b@example.com", "b")).accountId!;
    const c = (await addCodexAccount("c@example.com", "c")).accountId!;
    sharedPlanUsageCache.store("codex", usageReading("codex", 91), 60_000);
    const writing = deferred<void>();
    const release = deferred<void>();
    const original = fs.writeFile.bind(fs);
    const write = spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (String(file).includes("last-usage.json.")) {
        writing.resolve();
        await release.promise;
      }
      return original(file, data, options);
    });
    const reader = (async () =>
      sharedPlanUsageCache.peek("codex") ?? {
        platform: "codex",
        status: "unavailable",
        windows: [],
        fetchedAt: new Date().toISOString(),
      }) as unknown as PlanUsageReader;
    try {
      const first = setActiveAgentAccount(context, "codex", b);
      await writing.promise;
      expect(sharedPlanUsageCache.lastOk("codex")).toBeUndefined();
      contextUsageWithPlanUsage(
        "codex",
        { usedTokens: 1, account: [{ window: "primary", usedPercent: 92 }] },
        "default",
      );
      expect(sharedPlanUsageCache.peek("codex")).toBeUndefined();
      const read = readAgentAccountUsage(context, "codex", b, { reader }).catch(
        (error: unknown) => {
          expect(error).toMatchObject({ message: expect.stringContaining("account changed") });
          return undefined;
        },
      );
      const second = setActiveAgentAccount(context, "codex", c);
      release.resolve();
      await Promise.all([first, second]);
      expect((await read)?.windows ?? []).toEqual([]);
      expect((await context.storage.agentAccounts.loadAgentAccounts()).active.codex).toBe(c);
      expect((await readAgentAccountUsage(context, "codex", c, { reader })).windows).toEqual([]);
      contextUsageWithPlanUsage(
        "codex",
        { usedTokens: 1, account: [{ window: "primary", usedPercent: 93 }] },
        b,
      );
      expect(sharedPlanUsageCache.peek("codex")).toBeUndefined();
      contextUsageWithPlanUsage(
        "codex",
        { usedTokens: 1, account: [{ window: "primary", usedPercent: 3 }] },
        c,
      );
      expect(sharedPlanUsageCache.peek("codex")?.windows[0]?.usedPercent).toBe(3);
      const saved = JSON.parse(
        await fs.readFile(
          path.join(context.storage.agentAccounts.agentAccountsDirectory(), "last-usage.json"),
          "utf8",
        ),
      );
      expect(Object.keys(saved)).toEqual(["codex:default"]);
      expect(saved["codex:default"].windows[0].usedPercent).toBe(91);
    } finally {
      release.resolve();
      write.mockRestore();
    }
  });

  test("an active usage result cannot be attributed after a switch", async () => {
    const id = (await addCodexAccount("new@example.com", "new")).accountId!;
    const started = deferred<void>();
    const response = deferred<PlanUsageSnapshot>();
    const reader = (async () => {
      started.resolve();
      return response.promise;
    }) as unknown as PlanUsageReader;
    const pending = readAgentAccountUsage(context, "codex", "default", { reader });
    const rejected = pending.catch((error: unknown) => error);
    await started.promise;
    await setActiveAgentAccount(context, "codex", id);
    response.resolve(usageReading("codex", 99));
    expect(await rejected).toEqual(
      expect.objectContaining({ message: expect.stringContaining("account changed") }),
    );
    await expect(
      fs.stat(path.join(context.storage.agentAccounts.agentAccountsDirectory(), "last-usage.json")),
    ).rejects.toThrow();
  });

  async function usableInactiveAccount() {
    const id = (await addCodexAccount("inactive@example.com", "inactive")).accountId!;
    const auth = JSON.parse(codexAuth("inactive@example.com", "inactive"));
    auth.tokens.access_token = jwt({ exp: 3_000_000_000 });
    await fs.writeFile(
      path.join(context.storage.agentAccounts.agentAccountsDirectory(), "codex", id, "auth.json"),
      JSON.stringify(auth),
    );
    return id;
  }

  test("a late inactive usage response cannot restore a removed account", async () => {
    const id = await usableInactiveAccount();
    const response = deferred<Response>();
    const started = deferred<void>();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      started.resolve();
      return response.promise;
    }) as unknown as typeof fetch);
    const reader = (async () => {
      throw new Error("inactive reads must use their own credentials");
    }) as unknown as PlanUsageReader;
    try {
      const pending = readAgentAccountUsage(context, "codex", id, { reader });
      const rejected = pending.catch((error: unknown) => error);
      await started.promise;
      await removeAgentAccount(context, "codex", id);
      response.resolve(
        Response.json({
          rate_limit: { primary_window: { used_percent: 68, limit_window_seconds: 18000 } },
        }),
      );
      expect(await rejected).toEqual(
        expect.objectContaining({ message: expect.stringContaining("account changed") }),
      );
      await expect(readAgentAccountUsage(context, "codex", id, { reader })).rejects.toThrow(
        "Unknown agent account",
      );
      await expect(
        fs.stat(
          path.join(context.storage.agentAccounts.agentAccountsDirectory(), "last-usage.json"),
        ),
      ).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("removal waits for an admitted usage write, then deletes its disk and cache entries", async () => {
    const id = await usableInactiveAccount();
    const writing = deferred<void>();
    const release = deferred<void>();
    const original = fs.writeFile.bind(fs);
    const write = spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (String(file).includes("last-usage.json.")) {
        writing.resolve();
        await release.promise;
      }
      return original(file, data, options);
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        rate_limit: { primary_window: { used_percent: 68, limit_window_seconds: 18000 } },
      }),
    );
    const reader = (async () => usageReading("codex")) as unknown as PlanUsageReader;
    try {
      const pending = readAgentAccountUsage(context, "codex", id, { reader });
      await writing.promise;
      const removal = removeAgentAccount(context, "codex", id);
      release.resolve();
      await Promise.all([pending, removal]);
      const file = path.join(
        context.storage.agentAccounts.agentAccountsDirectory(),
        "last-usage.json",
      );
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({});
      await expect(readAgentAccountUsage(context, "codex", id, { reader })).rejects.toThrow(
        "Unknown agent account",
      );
    } finally {
      release.resolve();
      write.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("inactive account backoff survives ordinary TTL and forced reads, using disk fallback", async () => {
    const id = await usableInactiveAccount();
    let clock = 1_800_000_000_000;
    const reading = {
      ...usageReading("codex", 54),
      fetchedAt: new Date(clock - 60_000).toISOString(),
    };
    await rememberAgentAccountUsage(
      context.storage.agentAccounts.agentAccountsDirectory(),
      "codex",
      id,
      reading,
    );
    resetAgentAccountLastUsageForTests();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "300" },
        })) as unknown as typeof fetch,
    );
    const reader = (async () => {
      throw new Error("inactive read");
    }) as unknown as PlanUsageReader;
    const options = { reader, now: () => clock };
    try {
      const result = await readAgentAccountUsage(context, "codex", id, options);
      expect(result).toMatchObject({
        stale: true,
        windows: reading.windows,
        fetchedAt: reading.fetchedAt,
      });
      expect(result.message).toContain("HTTP 429");
      clock += 121_000;
      expect(await readAgentAccountUsage(context, "codex", id, options)).toEqual(result);
      expect(
        await readAgentAccountUsage(context, "codex", id, { ...options, force: true }),
      ).toEqual(result);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      clock += 179_001;
      await readAgentAccountUsage(context, "codex", id, options);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
