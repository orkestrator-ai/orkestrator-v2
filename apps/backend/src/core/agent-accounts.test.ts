import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { MAX_AGENT_ACCOUNTS_PER_PLATFORM } from "@orkestrator/protocol/agent-accounts";

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
import { staleLoginLocalBridges } from "./agent-account-bridge-state.js";
import type { SpawnLike } from "./agent-accounts-login.js";
import { localServerProcesses } from "./commands-runtime-state.js";
import type { CommandContext } from "./commands-context.js";
import type { PlanUsageReader } from "./plan-usage.js";
import { StorageService } from "./storage.js";
import { terminalAccountHomes } from "./terminal-account-usage.js";

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

beforeEach(async () => {
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
  } as unknown as CommandContext;
  resetAgentAccountLoginForTests();
  terminalAccountHomes.clear();
});

afterEach(async () => {
  cancelAgentAccountLogin();
  resetAgentAccountLoginForTests();
  terminalAccountHomes.clear();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("agent accounts", () => {
  test("reserves the login slot before a delayed registry read", async () => {
    const original = context.storage.loadAgentAccounts.bind(context.storage);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.storage.loadAgentAccounts = async () => {
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
    await context.storage.mutateAgentAccounts((store) => ({
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

    afterEach(() => {
      staleLoginLocalBridges.clear();
      localServerProcesses.delete("claude:env-1");
    });

    test("renews the active account in place and flags running bridges", async () => {
      const accountId = await addActiveClaudeAccount("claude-one");
      localServerProcesses.set("claude:env-1", {} as never);
      let command: string[] = [];
      await startAgentAccountLogin(context, "claude", {
        reauthenticate: true,
        executable: "claude",
        spawnImpl: (cmd, args, options) => {
          command = [cmd, ...args];
          expect(options.env.CLAUDE_CONFIG_DIR).toContain(accountId);
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
      expect(staleLoginLocalBridges.has("claude:env-1")).toBe(true);
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
    terminalAccountHomes.set("terminal-1", home);
    await expect(removeAgentAccount(context, "codex", accountId!)).rejects.toThrow("terminal");
    expect((await fs.stat(home)).isDirectory()).toBe(true);
    terminalAccountHomes.delete("terminal-1");
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
});
