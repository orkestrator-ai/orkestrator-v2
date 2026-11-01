import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_ACCOUNTS_CHANGED_EVENT } from "@orkestrator/protocol/agent-accounts";
import { parseInheritedGlobalSettings } from "@orkestrator/protocol/controller-settings";
import {
  applyAutomaticAccountSwitch,
  listAgentAccounts,
  resumeAgentAccountAutoSwitch,
  setActiveAgentAccount,
  setAgentAccountAutoSwitch,
} from "./agent-accounts.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { StorageService } from "./storage.js";

let root: string;
let storage: StorageService;
let context: CommandContext;
let emitted: Array<{ event: string; payload: unknown }>;
const A = randomUUID();
const B = randomUUID();
const NO_EMAIL = randomUUID();

const savedEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  ORKESTRATOR_AGENT_TEST_HOST_HOME: process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME,
};

beforeEach(async () => {
  emitted = [];
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-auto-switch-")));
  process.env.CODEX_HOME = path.join(root, "host-codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "host-claude");
  process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = path.join(root, "host-home");
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  // An agent-test profile with no granted host credentials: nothing reads the
  // real login, and each fake account's identity is the one stored for it.
  context = {
    storage,
    runtime: new BackendRuntime({ emit: () => undefined }),
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
  } as unknown as CommandContext;
  await storage.agentAccounts.mutateAgentAccounts((store) => ({
    store: {
      ...store,
      accounts: [
        account(A, "a@example.com"),
        account(B, "b@example.com"),
        account(NO_EMAIL, undefined),
      ],
      active: { codex: A },
    },
    result: undefined,
  }));
});

afterEach(async () => {
  context.runtime.shutdown();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

function account(id: string, email: string | undefined) {
  return {
    id,
    platform: "codex" as const,
    label: email ?? "API key",
    createdAt: "2026-11-01T00:00:00.000Z",
    identityKey: id,
    ...(email ? { identity: { email } } : {}),
  };
}

const state = async () => (await listAgentAccounts(context)).autoSwitch!.codex!;

describe("the main tick", () => {
  test("is off by default, and only ever turned on by asking", async () => {
    expect((await state()).mode).toBe("off");
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    expect((await state()).mode).toBe("automatic");
    expect((await storage.loadConfig()).global.agentAccountAutoSwitch).toEqual({
      codex: { enabled: true, excludedEmails: [] },
    });
    await setAgentAccountAutoSwitch(context, "codex", { enabled: false });
    expect((await state()).mode).toBe("off");
    expect((await storage.loadConfig()).global.agentAccountAutoSwitch).toBeUndefined();
    expect(emitted.at(-1)).toEqual({
      event: AGENT_ACCOUNTS_CHANGED_EVENT,
      payload: { platform: "codex" },
    });
  });

  test("a whole-config save from a settings form cannot undo a tick", async () => {
    const stale = (await storage.loadConfig()).global;
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    await storage.updateGlobalConfig(stale);
    expect((await state()).mode).toBe("automatic");
    await storage.updateGlobalConfig({
      ...stale,
      agentAccountAutoSwitch: { codex: { enabled: false, excludedEmails: ["x@example.com"] } },
    });
    expect((await storage.loadConfig()).global.agentAccountAutoSwitch).toEqual({
      codex: { enabled: true, excludedEmails: [] },
    });
  });
});

describe("a manual switch", () => {
  test("pins the account and turns automatic switching off until ticked again", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    const snapshot = await setActiveAgentAccount(context, "codex", B);
    expect(snapshot.active.codex).toBe(B);
    expect(snapshot.autoSwitch?.codex).toMatchObject({ mode: "pinned", pinnedAccountId: B });
    // The tick is shared and the pin is this machine's, so setting it does not end the pin.
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    expect((await state()).mode).toBe("pinned");
    await resumeAgentAccountAutoSwitch(context, "codex");
    const resumed = await state();
    expect(resumed.mode).toBe("automatic");
    expect(resumed.pinnedAccountId).toBeUndefined();
  });

  test("picking the account already in use is still a pin, and announced", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    emitted = [];
    await setActiveAgentAccount(context, "codex", A);
    expect(await state()).toMatchObject({ mode: "pinned", pinnedAccountId: A });
    expect(emitted).toEqual([
      { event: AGENT_ACCOUNTS_CHANGED_EVENT, payload: { platform: "codex" } },
    ]);
  });

  test("with the tick off there is nothing to pin", async () => {
    await setActiveAgentAccount(context, "codex", B);
    expect((await state()).mode).toBe("off");
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    expect((await state()).mode).toBe("automatic");
  });

  test("a pin left while the tick is off is still there to end when it comes back", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    await setActiveAgentAccount(context, "codex", B);
    await setAgentAccountAutoSwitch(context, "codex", { enabled: false });
    expect(await state()).toMatchObject({ mode: "off", pinnedAccountId: B });
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    await resumeAgentAccountAutoSwitch(context, "codex");
    const resumed = await state();
    expect(resumed.mode).toBe("automatic");
    expect(resumed.pinnedAccountId).toBeUndefined();
  });

  test("the other provider's tick is not touched", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    await setAgentAccountAutoSwitch(context, "claude", { enabled: true });
    await setActiveAgentAccount(context, "codex", B);
    const snapshot = await listAgentAccounts(context);
    expect(snapshot.autoSwitch?.codex?.mode).toBe("pinned");
    expect(snapshot.autoSwitch?.claude?.mode).toBe("automatic");
  });

  test("resuming on a machine ends only its pin and leaves its ticks alone", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    await setActiveAgentAccount(context, "codex", B);
    const ticks = (await storage.loadConfig()).global.agentAccountAutoSwitch;
    await resumeAgentAccountAutoSwitch(context, "codex");
    expect((await state()).mode).toBe("automatic");
    expect((await storage.loadConfig()).global.agentAccountAutoSwitch).toEqual(ticks);
  });
});

describe("the feature's own switch", () => {
  test("does not count as manual, and records what it did", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    emitted = [];
    expect(
      await applyAutomaticAccountSwitch(context, "codex", B, {
        expectedActive: A,
        reason: "threshold",
      }),
    ).toBe(true);
    const after = await listAgentAccounts(context);
    expect(after.active.codex).toBe(B);
    expect(after.autoSwitch?.codex).toMatchObject({
      mode: "automatic",
      lastSwitch: { fromAccountId: A, toAccountId: B, reason: "threshold" },
    });
    expect(emitted).toEqual([
      { event: AGENT_ACCOUNTS_CHANGED_EVENT, payload: { platform: "codex" } },
    ]);
  });

  test("gives way to a pin or another active account, changing nothing", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    await setActiveAgentAccount(context, "codex", A);
    expect(
      await applyAutomaticAccountSwitch(context, "codex", B, {
        expectedActive: A,
        reason: "limit",
      }),
    ).toBe(false);
    expect((await listAgentAccounts(context)).active.codex).toBe(A);

    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    expect(
      await applyAutomaticAccountSwitch(context, "codex", B, {
        expectedActive: "someone-else",
        reason: "limit",
      }),
    ).toBe(false);
    expect((await listAgentAccounts(context)).active.codex).toBe(A);
  });

  test("survives a restart, as a pin does", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    await setActiveAgentAccount(context, "codex", B);
    const reopened = new StorageService(path.join(root, "data"));
    await reopened.init();
    context = { ...context, storage: reopened } as CommandContext;
    expect(await state()).toMatchObject({ mode: "pinned", pinnedAccountId: B });
  });
});

describe("the per-account ticks", () => {
  test("travel by email, and an account with no email stays out until ticked here", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    // This profile's host login has no email, so it stays out like any other.
    expect((await state()).includedAccountIds.sort()).toEqual([A, B].sort());

    await setAgentAccountAutoSwitch(context, "codex", {
      email: "B@example.com",
      included: false,
    });
    expect((await state()).includedAccountIds).not.toContain(B);
    expect(
      (await storage.loadConfig()).global.agentAccountAutoSwitch?.codex?.excludedEmails,
    ).toEqual(["b@example.com"]);

    await setAgentAccountAutoSwitch(context, "codex", { accountId: NO_EMAIL, included: true });
    expect((await state()).includedAccountIds).toContain(NO_EMAIL);
    // Its tick stays on this machine: nothing about it is in what travels.
    expect(
      JSON.stringify((await storage.loadConfig()).global.agentAccountAutoSwitch),
    ).not.toContain(NO_EMAIL);
    await setAgentAccountAutoSwitch(context, "codex", { accountId: NO_EMAIL, included: false });
    expect((await state()).includedAccountIds).not.toContain(NO_EMAIL);
  });
});

describe("settings from a command node", () => {
  const ticks = { codex: { enabled: true, excludedEmails: ["a@example.com"] } };

  test("apply to this machine's own accounts, and leave with the command node", async () => {
    storage.inheritedGlobalSettings = () =>
      parseInheritedGlobalSettings({ agentAccountAutoSwitch: ticks });
    const leaf = await state();
    expect(leaf.mode).toBe("automatic");
    expect(leaf.includedAccountIds).toContain(B);
    expect(leaf.includedAccountIds).not.toContain(A);

    storage.inheritedGlobalSettings = () => null;
    expect((await state()).mode).toBe("off");
  });

  test("a manual switch on the leaf pins it there, under the command node's tick", async () => {
    storage.inheritedGlobalSettings = () => ({ agentAccountAutoSwitch: ticks });
    await setActiveAgentAccount(context, "codex", B);
    expect(await state()).toMatchObject({ mode: "pinned", pinnedAccountId: B });
    // The command node sending its unchanged ticks again does not resume it.
    storage.inheritedGlobalSettings = () => ({ agentAccountAutoSwitch: { ...ticks } });
    expect((await state()).mode).toBe("pinned");
  });

  test("a leaf refuses the ticks its command node holds, but keeps what is its own", async () => {
    storage.inheritedGlobalSettings = () => ({ agentAccountAutoSwitch: ticks });
    await setActiveAgentAccount(context, "codex", B);
    for (const change of [{ enabled: false }, { email: "a@example.com", included: false }]) {
      await expect(setAgentAccountAutoSwitch(context, "codex", change)).rejects.toThrow(
        "from its command node",
      );
    }
    expect((await storage.loadOwnConfig()).global.agentAccountAutoSwitch).toBeUndefined();
    await setAgentAccountAutoSwitch(context, "codex", { accountId: NO_EMAIL, included: true });
    expect((await state()).includedAccountIds).toContain(NO_EMAIL);
    await resumeAgentAccountAutoSwitch(context, "codex");
    expect((await state()).mode).toBe("automatic");
  });

  test("an older command node sends no ticks, which reads as off on a newer leaf", async () => {
    await setAgentAccountAutoSwitch(context, "codex", { enabled: true });
    storage.inheritedGlobalSettings = () => ({ terminalScrollback: 5_000 });
    expect((await state()).mode).toBe("off");
    // The leaf's own value is kept underneath for when the command node detaches.
    expect((await storage.loadOwnConfig()).global.agentAccountAutoSwitch?.codex?.enabled).toBe(
      true,
    );
  });

  test("an older leaf drops what it does not know and keeps working", () => {
    // The same parser an older leaf has, facing a key from a newer command node.
    expect(
      parseInheritedGlobalSettings({
        terminalScrollback: 5_000,
        aKeyFromTheFuture: { enabled: true },
      }),
    ).toEqual({ terminalScrollback: 5_000 });
  });

  test("nothing a command node sends can carry a credential into the accounts", () => {
    const parsed = parseInheritedGlobalSettings({
      agentAccountAutoSwitch: ticks,
      anthropicApiKey: "secret",
      githubToken: "secret",
    });
    expect(Object.keys(parsed)).toEqual(["agentAccountAutoSwitch"]);
  });
});
