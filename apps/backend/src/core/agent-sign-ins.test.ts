import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandContext } from "./commands-context.js";
import { openAgentSignInTerminal, readGrokSignIn, readPiSignIn } from "./agent-sign-ins.js";
import type { Environment } from "./models.js";

let home: string;

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-agent-sign-ins-")));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("readGrokSignIn", () => {
  test("accepts the same evidence as the Grok bridge, and never a value", async () => {
    expect(await readGrokSignIn({ HOME: home })).toEqual({ state: "signed-out" });
    expect(await readGrokSignIn({ HOME: home, XAI_API_KEY: "xai-secret" })).toEqual({
      state: "signed-in",
      source: "XAI_API_KEY",
    });
    await fs.mkdir(path.join(home, ".grok"));
    await fs.writeFile(path.join(home, ".grok", "config.toml"), 'auth_provider_command = "x"\n');
    expect(await readGrokSignIn({ HOME: home })).toEqual({
      state: "signed-in",
      source: "Auth provider command",
    });
    await fs.writeFile(path.join(home, ".grok", "auth.json"), '{"token":"grok-secret"}');
    const signIn = await readGrokSignIn({ HOME: home });
    expect(signIn).toEqual({ state: "signed-in", source: "Stored login" });
    expect(JSON.stringify(signIn)).not.toContain("secret");
  });

  test("follows GROK_HOME", async () => {
    const grokHome = path.join(home, "elsewhere");
    await fs.mkdir(grokHome);
    await fs.writeFile(path.join(grokHome, "auth.json"), "{}");
    expect((await readGrokSignIn({ HOME: home, GROK_HOME: grokHome })).state).toBe("signed-in");
  });
});

describe("readPiSignIn", () => {
  test("names stored providers only, then falls back to a provider key in the environment", async () => {
    expect(await readPiSignIn({}, home)).toEqual({ state: "signed-out" });
    expect(await readPiSignIn({ OPENAI_API_KEY: "sk-secret" }, home)).toEqual({
      state: "signed-in",
      source: "OPENAI_API_KEY",
    });
    await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".pi", "agent", "auth.json"),
      JSON.stringify({
        openai: { type: "oauth", refresh: "pi-secret" },
        anthropic: { type: "api_key", key: "pi-secret" },
        broken: "pi-secret",
      }),
    );
    const signIn = await readPiSignIn({}, home);
    expect(signIn).toEqual({ state: "signed-in", source: "anthropic, openai" });
    expect(JSON.stringify(signIn)).not.toContain("secret");
  });

  test("a file that is not a login reads as signed out", async () => {
    await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await fs.writeFile(path.join(home, ".pi", "agent", "auth.json"), "not json");
    expect(await readPiSignIn({}, home)).toEqual({ state: "signed-out" });
  });
});

describe("openAgentSignInTerminal", () => {
  function environment(overrides: Partial<Environment>): Environment {
    return {
      id: "env-1",
      projectId: "project-1",
      environmentType: "local",
      status: "running",
      setupPhase: "ready",
      createdAt: "2026-10-01T00:00:00.000Z",
      ...overrides,
    } as Environment;
  }

  function contextWith(environments: Environment[]): CommandContext {
    return { storage: { loadEnvironments: async () => environments } } as unknown as CommandContext;
  }

  test("runs the fixed login command in the requested or most recent local environment", async () => {
    const launched: Array<Record<string, unknown>> = [];
    const launchTerminalJob = async (args: Record<string, unknown>) => {
      launched.push(args);
      return { tabId: "tab-1" };
    };
    const context = contextWith([
      environment({ id: "container", environmentType: "containerized" as never }),
      environment({ id: "stopped", status: "stopped" as never }),
      environment({ id: "older", lastActivityAt: "2026-10-02T00:00:00.000Z" }),
      environment({ id: "newer", lastActivityAt: "2026-10-20T00:00:00.000Z" }),
    ]);

    expect(await openAgentSignInTerminal(context, "grok", { launchTerminalJob })).toEqual({
      environmentId: "newer",
      projectId: "project-1",
      tabId: "tab-1",
    });
    expect(launched[0]).toMatchObject({
      environmentId: "newer",
      tabType: "plain",
      data: "grok login\n",
      activateTab: true,
    });

    await openAgentSignInTerminal(context, "pi", { environmentId: "older", launchTerminalJob });
    expect(launched[1]).toMatchObject({ environmentId: "older", data: "pi\n" });
    // A container is not this machine's login.
    await openAgentSignInTerminal(context, "pi", { environmentId: "container", launchTerminalJob });
    expect(launched[2]).toMatchObject({ environmentId: "newer" });
  });

  test("asks for a local environment when none is running", async () => {
    await expect(
      openAgentSignInTerminal(contextWith([environment({ status: "stopped" as never })]), "grok", {
        launchTerminalJob: async () => ({ tabId: "unused" }),
      }),
    ).rejects.toThrow("Start a local environment");
  });
});
