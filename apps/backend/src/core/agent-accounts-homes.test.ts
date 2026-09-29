import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentAccountHome,
  claudeAccountLoginState,
  claudeKeychainService,
  codexAccountLoginState,
  hostClaudeJsonPath,
  linkSharedEntries,
  prepareAgentAccountHome,
  syncClaudeAccountSettings,
} from "./agent-accounts-homes.js";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-agent-account-homes-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

describe("claudeKeychainService", () => {
  test("uses the plain entry when no directory override is set", () => {
    expect(claudeKeychainService(undefined)).toBe("Claude Code-credentials");
  });

  test("hashes the literal directory string the way Claude Code 2.1.283 does", () => {
    // Observed from the CLI's own `security find-generic-password` lookups.
    expect(claudeKeychainService("/tmp/ork-p0/claude-a")).toBe("Claude Code-credentials-9c0ff472");
    // A trailing slash is a different entry, which is why homes are built one way.
    expect(claudeKeychainService("/tmp/ork-p0/claude-a/")).not.toBe(
      claudeKeychainService("/tmp/ork-p0/claude-a"),
    );
  });
});

describe("hostClaudeJsonPath", () => {
  test("lives beside the config directory in HOME unless CLAUDE_CONFIG_DIR is set", () => {
    expect(hostClaudeJsonPath({}, "/home/u")).toBe("/home/u/.claude.json");
    expect(hostClaudeJsonPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u")).toBe("/cfg/.claude.json");
  });
});

describe("agentAccountHome", () => {
  test("builds a normalized path with no trailing slash", () => {
    expect(agentAccountHome("/data/agent-accounts/", "claude", "id")).toBe(
      "/data/agent-accounts/claude/id",
    );
  });
});

describe("linkSharedEntries", () => {
  test("links existing host entries, creates required ones and keeps account files", async () => {
    const host = path.join(root, "host");
    const account = path.join(root, "account");
    await fs.mkdir(path.join(host, "skills"), { recursive: true });
    await fs.writeFile(path.join(host, "settings.json"), "{}");
    await fs.writeFile(path.join(host, "CLAUDE.md"), "host");
    await fs.mkdir(account, { recursive: true });
    // Written by the CLI through an atomic rename: the account's own now.
    await fs.writeFile(path.join(account, "CLAUDE.md"), "account");

    const entries = ["settings.json", "CLAUDE.md", "skills", "projects", "agents"];
    await linkSharedEntries(account, host, entries, ["projects"]);
    await linkSharedEntries(account, host, entries, ["projects"]);

    expect(await fs.readlink(path.join(account, "settings.json"))).toBe(
      path.join(host, "settings.json"),
    );
    expect(await fs.readlink(path.join(account, "skills"))).toBe(path.join(host, "skills"));
    expect((await fs.stat(path.join(host, "projects"))).isDirectory()).toBe(true);
    expect(await fs.readlink(path.join(account, "projects"))).toBe(path.join(host, "projects"));
    expect(await fs.readFile(path.join(account, "CLAUDE.md"), "utf8")).toBe("account");
    await expect(fs.lstat(path.join(account, "agents"))).rejects.toThrow();
  });

  test("drops a link whose host target has gone", async () => {
    const host = path.join(root, "host");
    const account = path.join(root, "account");
    await fs.mkdir(host, { recursive: true });
    await fs.mkdir(account, { recursive: true });
    await fs.symlink(path.join(host, "rules"), path.join(account, "rules"));

    await linkSharedEntries(account, host, ["rules"]);

    await expect(fs.lstat(path.join(account, "rules"))).rejects.toThrow();
  });
});

describe("syncClaudeAccountSettings", () => {
  test("copies MCP servers and project trust without touching the account's login", async () => {
    const account = path.join(root, "account");
    await fs.mkdir(account, { recursive: true });
    const hostJson = path.join(root, "host.claude.json");
    await fs.writeFile(
      hostJson,
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: "host@example.com" },
        mcpServers: { docs: { type: "stdio", command: "docs" } },
        projects: {
          "/repo": {
            mcpServers: { local: { type: "stdio", command: "local" } },
            hasTrustDialogAccepted: true,
            lastCost: 12,
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(account, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "second@example.com" },
        mcpServers: { stale: {} },
        projects: { "/repo": { allowedTools: ["Bash"], lastCost: 3 } },
      }),
    );

    expect(await syncClaudeAccountSettings(account, hostJson)).toBe("synced");

    const synced = JSON.parse(await fs.readFile(path.join(account, ".claude.json"), "utf8"));
    expect(synced.oauthAccount).toEqual({ emailAddress: "second@example.com" });
    expect(synced.mcpServers).toEqual({ docs: { type: "stdio", command: "docs" } });
    expect(synced.hasCompletedOnboarding).toBe(true);
    // Synced keys follow the host, including removal; the account's own stats stay.
    expect(synced.projects["/repo"]).toEqual({
      mcpServers: { local: { type: "stdio", command: "local" } },
      hasTrustDialogAccepted: true,
      lastCost: 3,
    });
    expect((await fs.stat(path.join(account, ".claude.json"))).mode & 0o777).toBe(0o600);
    expect(await syncClaudeAccountSettings(account, hostJson)).toBe("unchanged");
    await expect(fs.stat(path.join(account, ".claude.json.lock"))).rejects.toThrow();
  });

  test("never overwrites an account file it cannot parse", async () => {
    const account = path.join(root, "account");
    await fs.mkdir(account, { recursive: true });
    const hostJson = path.join(root, "host.claude.json");
    await fs.writeFile(hostJson, JSON.stringify({ mcpServers: { docs: {} } }));
    await fs.writeFile(path.join(account, ".claude.json"), "{ half-written");

    expect(await syncClaudeAccountSettings(account, hostJson)).toBe("skipped");
    expect(await fs.readFile(path.join(account, ".claude.json"), "utf8")).toBe("{ half-written");
  });

  test("reclaims an abandoned Claude lock directory", async () => {
    const account = path.join(root, "account");
    await fs.mkdir(path.join(account, ".claude.json.lock"), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(account, ".claude.json.lock"), old, old);
    const hostJson = path.join(root, "host.claude.json");
    await fs.writeFile(hostJson, JSON.stringify({ mcpServers: { docs: {} } }));

    expect(await syncClaudeAccountSettings(account, hostJson)).toBe("synced");
  });
});

describe("prepareAgentAccountHome", () => {
  test("creates an owner-only Codex home linked to the host sessions", async () => {
    const hostCodex = path.join(root, "codex-host");
    await fs.mkdir(hostCodex, { recursive: true });
    await fs.writeFile(path.join(hostCodex, "config.toml"), "");
    await fs.writeFile(path.join(hostCodex, "state_5.sqlite"), "");
    const home = path.join(root, "accounts", "codex", "one");

    await prepareAgentAccountHome("codex", home, {
      claudeHome: path.join(root, "claude-host"),
      claudeJson: path.join(root, "claude.json"),
      codexHome: hostCodex,
    });

    expect((await fs.stat(home)).mode & 0o777).toBe(0o700);
    expect(await fs.readlink(path.join(home, "sessions"))).toBe(path.join(hostCodex, "sessions"));
    expect(await fs.readlink(path.join(home, "config.toml"))).toBe(
      path.join(hostCodex, "config.toml"),
    );
    await expect(fs.lstat(path.join(home, "state_5.sqlite"))).rejects.toThrow();
  });
});

describe("claudeAccountLoginState", () => {
  const now = 1_000_000;

  test("reads identity from oauthAccount and the plan from the credential", () => {
    const state = claudeAccountLoginState(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "a",
          refreshToken: "r",
          expiresAt: now - 1,
          subscriptionType: "max",
        },
      }),
      {
        oauthAccount: {
          emailAddress: "me@example.com",
          organizationName: "Org",
          accountUuid: "acct",
          organizationUuid: "org",
        },
      },
      now,
    );
    expect(state).toEqual({
      signedIn: true,
      identity: { email: "me@example.com", organizationName: "Org", plan: "max" },
      identityKey: "claude:acct:org",
    });
  });

  test("an expired access token without a refresh token is signed out", () => {
    const state = claudeAccountLoginState(
      JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: now - 1 } }),
      undefined,
      now,
    );
    expect(state.signedIn).toBe(false);
    expect(claudeAccountLoginState(undefined, undefined, now).signedIn).toBe(false);
  });
});

describe("codexAccountLoginState", () => {
  test("reads the ChatGPT identity from the id token", () => {
    const state = codexAccountLoginState(
      JSON.stringify({
        tokens: {
          access_token: "a",
          refresh_token: "r",
          id_token: jwt({
            email: "me@example.com",
            "https://api.openai.com/auth": {
              chatgpt_plan_type: "pro",
              chatgpt_account_id: "acct",
            },
          }),
        },
      }),
    );
    expect(state).toEqual({
      signedIn: true,
      identity: { email: "me@example.com", plan: "pro" },
      identityKey: "codex:acct:me@example.com",
    });
  });

  test("identifies an API-key login without keeping the key", () => {
    const state = codexAccountLoginState(JSON.stringify({ OPENAI_API_KEY: "sk-secret" }));
    expect(state.signedIn).toBe(true);
    expect(state.identity).toEqual({ plan: "API key" });
    expect(state.identityKey).toMatch(/^codex:api-key:[0-9a-f]{16}$/);
    expect(state.identityKey).not.toContain("sk-secret");
  });

  test("anything else is signed out", () => {
    expect(codexAccountLoginState(undefined)).toEqual({ signedIn: false, identity: {} });
    expect(codexAccountLoginState("not json").signedIn).toBe(false);
  });
});
