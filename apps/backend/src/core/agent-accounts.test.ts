import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

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
import type { SpawnLike } from "./agent-accounts-login.js";
import type { CommandContext } from "./commands-context.js";
import type { PlanUsageReader } from "./plan-usage.js";
import { StorageService } from "./storage.js";

let root: string;
let context: CommandContext;
const savedEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
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
});

afterEach(async () => {
  cancelAgentAccountLogin();
  resetAgentAccountLoginForTests();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("agent accounts", () => {
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
