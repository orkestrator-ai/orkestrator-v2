/**
 * MCP servers on an added Claude account (0039 item 12).
 *
 * The backend points the CLI at the account's directory (`CLAUDE_CONFIG_DIR`)
 * and copies the host file's servers into that directory's `.claude.json`.
 * The bridge keeps reading the host file, so a server only the account's copy
 * names is loaded by the CLI and declared by nothing the bridge passes. These
 * pin which file counts as that copy and which names start out stale.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_ACCOUNT_HOME_ENV,
  claudeAccountJsonPath,
  setClaudeAccountHomeForTesting,
  setClaudeHomeForTesting,
} from "./claude-home.js";
import { clearJsonFileCache } from "./json-file-cache.js";
import { claudeAccountOnlyMcpServerNames, getMcpRuntimeConfig } from "./mcp-config.js";
import {
  createClaudeRuntimeMcp,
  createStaleMcpServerHook,
  reportedStaleServers,
  syncClaudeRuntimeMcp,
} from "./session-manager-prompt-mcp-sync.js";
import type { ClaudeQueryControl } from "../types/index.js";

let root: string;
let host: string;
let account: string;
let cwd: string;

const ENV_KEYS = ["CLAUDE_CONFIG_DIR", CLAUDE_ACCOUNT_HOME_ENV] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-bridge-mcp-account-"));
  host = join(root, "home");
  account = join(root, "accounts", "claude", "a1");
  cwd = join(root, "project");
  await Promise.all([
    mkdir(host, { recursive: true }),
    mkdir(account, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ]);
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  clearJsonFileCache();
});

afterEach(async () => {
  setClaudeHomeForTesting(null);
  setClaudeAccountHomeForTesting(undefined);
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearJsonFileCache();
  await rm(root, { recursive: true, force: true });
});

describe("claudeAccountJsonPath", () => {
  test("follows CLAUDE_CONFIG_DIR only when the backend marked it as an account home", () => {
    process.env.CLAUDE_CONFIG_DIR = account;
    delete process.env[CLAUDE_ACCOUNT_HOME_ENV];
    // A user's own config directory is not a copy of anything.
    expect(claudeAccountJsonPath()).toBeNull();
    process.env[CLAUDE_ACCOUNT_HOME_ENV] = join(root, "accounts", "claude", "other");
    expect(claudeAccountJsonPath()).toBeNull();
    process.env[CLAUDE_ACCOUNT_HOME_ENV] = `${account}/`;
    expect(claudeAccountJsonPath()).toBe(join(account, ".claude.json"));
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeAccountJsonPath()).toBeNull();
  });

  test("a test home ignores the environment", () => {
    process.env.CLAUDE_CONFIG_DIR = account;
    process.env[CLAUDE_ACCOUNT_HOME_ENV] = account;
    setClaudeHomeForTesting(host);
    expect(claudeAccountJsonPath()).toBeNull();
    setClaudeAccountHomeForTesting(account);
    expect(claudeAccountJsonPath()).toBe(join(account, ".claude.json"));
  });

  test("is null when the account file is the file the bridge reads anyway", () => {
    setClaudeHomeForTesting(host);
    setClaudeAccountHomeForTesting(host);
    expect(claudeAccountJsonPath()).toBeNull();
  });
});

describe("claudeAccountOnlyMcpServerNames", () => {
  const stdio = (command: string) => ({ command });

  async function writeFiles(hostJson: unknown, accountJson: unknown) {
    await writeFile(join(host, ".claude.json"), JSON.stringify(hostJson));
    await writeFile(join(account, ".claude.json"), JSON.stringify(accountJson));
    setClaudeHomeForTesting(host);
    setClaudeAccountHomeForTesting(account);
  }

  test("names what only the account's copy declares, for the sources the CLI loads", async () => {
    await writeFiles(
      {
        mcpServers: { shared: stdio("shared") },
        projects: { [cwd]: { mcpServers: { local: stdio("local") } } },
      },
      {
        oauthAccount: { emailAddress: "someone@example.com" },
        mcpServers: { shared: stdio("shared"), removed: stdio("old"), added: stdio("mine") },
        projects: { [cwd]: { mcpServers: { local: stdio("local"), accountLocal: stdio("x") } } },
      },
    );
    const { names } = await getMcpRuntimeConfig(cwd, {}, undefined, "all");
    expect(Array.from(names).sort()).toEqual(["local", "shared"]);
    expect(await claudeAccountOnlyMcpServerNames(cwd, ["user", "project"], names)).toEqual([
      "added",
      "removed",
    ]);
    // `local` is loaded by the CLI only when that settings source is on.
    expect(await claudeAccountOnlyMcpServerNames(cwd, ["user", "project", "local"], names)).toEqual(
      ["accountLocal", "added", "removed"],
    );
    // A coordinator loads no settings source, and a graph node's grant makes
    // the inline set the only one.
    expect(await claudeAccountOnlyMcpServerNames(cwd, [], names)).toEqual([]);
    expect(await claudeAccountOnlyMcpServerNames(cwd, ["user"], names, true)).toEqual([]);
  });

  test("is empty for the host login, and for an account copy in step with the host", async () => {
    const servers = { mcpServers: { shared: stdio("shared") } };
    await writeFiles(servers, { ...servers, oauthAccount: {} });
    const { names } = await getMcpRuntimeConfig(cwd, {}, undefined, "all");
    expect(await claudeAccountOnlyMcpServerNames(cwd, ["user"], names)).toEqual([]);
    setClaudeAccountHomeForTesting(null);
    await writeFile(
      join(account, ".claude.json"),
      JSON.stringify({ mcpServers: { extra: stdio("x") } }),
    );
    expect(await claudeAccountOnlyMcpServerNames(cwd, ["user"], names)).toEqual([]);
  });

  test("a missing or unreadable account file names nothing", async () => {
    await writeFile(join(host, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    setClaudeHomeForTesting(host);
    setClaudeAccountHomeForTesting(account);
    expect(await claudeAccountOnlyMcpServerNames(cwd, ["user"], new Set())).toEqual([]);
    await writeFile(join(account, ".claude.json"), "{not json");
    expect(await claudeAccountOnlyMcpServerNames(cwd, ["user"], new Set())).toEqual([]);
  });
});

describe("a runtime launched on an account copy", () => {
  const stdio = (name: string) => ({ type: "stdio" as const, command: "fixture", args: [name] });

  function cli(running: string[]) {
    const loaded = new Set(running);
    return {
      loaded,
      control: {
        setMcpServers: async (servers: Record<string, unknown>) => {
          for (const name of Object.keys(servers)) loaded.add(name);
          return { added: Object.keys(servers), removed: [], errors: {} };
        },
        mcpServerStatus: async () =>
          Array.from(loaded, (name) => ({ name, status: "connected", source: "user" })),
      } as unknown as ClaudeQueryControl,
    };
  }

  test("starts with the account-only servers stale, reported and refused", async () => {
    const mcp = createClaudeRuntimeMcp({ keep: stdio("keep") }, ["keep"], ["extra", "keep"]);
    // A name the configuration declares is never stale, whatever the copy says.
    expect(Array.from(mcp.stale)).toEqual(["extra"]);
    expect(reportedStaleServers(mcp)).toEqual(["extra"]);
    const hook = createStaleMcpServerHook(mcp);
    const call = (tool_name: string) =>
      hook({ hook_event_name: "PreToolUse", tool_name, tool_input: {} } as HookInput, "t-1", {
        signal: new AbortController().signal,
      });
    const denied = (await call("mcp__extra__probe")) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput?.permissionDecisionReason).toContain(
      "only in this Claude account's own configuration",
    );
    expect(await call("mcp__keep__probe")).toEqual({});
  });

  test("stays stale while the CLI runs it, and clears once the host declares it", async () => {
    const { control } = cli(["keep", "extra"]);
    const runtime = {
      control,
      mcpServers: "launch",
      mcp: createClaudeRuntimeMcp({ keep: stdio("keep") }, ["keep"], ["extra"]),
    };
    const keepOnly = { keep: stdio("keep") };
    await syncClaudeRuntimeMcp(runtime, {
      servers: keepOnly,
      key: "launch",
      names: new Set(["keep"]),
      required: [],
    });
    expect(Array.from(runtime.mcp.stale)).toEqual(["extra"]);
    const both = { keep: stdio("keep"), extra: stdio("extra") };
    await syncClaudeRuntimeMcp(runtime, {
      servers: both,
      key: "both",
      names: new Set(["keep", "extra"]),
      required: [],
    });
    expect(runtime.mcp.stale.size).toBe(0);
    expect(runtime.mcp.accountOnly.size).toBe(0);
  });
});
