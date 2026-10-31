import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
  privateSharedEntries,
  syncClaudeAccountSettings,
} from "./agent-accounts-homes.js";

let root: string;

// Keep these expectations independent of the production directory lists.
const sharedDirectories = {
  claude: [
    "agents",
    "commands",
    "skills",
    "plugins",
    "hooks",
    "rules",
    "output-styles",
    "projects",
    "todos",
    "file-history",
    "plans",
  ],
  codex: ["skills", "rules", "prompts", "plugins", "sessions", "archived_sessions"],
};

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

  test("moves a required directory the host lacks up to the host and links it", async () => {
    const host = path.join(root, "host");
    const account = path.join(root, "account");
    // Saved by the account before the host had a `plans` directory.
    await fs.mkdir(path.join(account, "plans"), { recursive: true });
    await fs.writeFile(path.join(account, "plans", "plan.md"), "account plan");

    await linkSharedEntries(account, host, ["plans"], ["plans"]);

    expect(await fs.readlink(path.join(account, "plans"))).toBe(path.join(host, "plans"));
    expect(await fs.readFile(path.join(host, "plans", "plan.md"), "utf8")).toBe("account plan");
    expect(await privateSharedEntries("claude", account)).toEqual([]);
  });

  test("never merges an account directory into the host's own", async () => {
    const host = path.join(root, "host");
    const account = path.join(root, "account");
    await fs.mkdir(path.join(host, "plans"), { recursive: true });
    await fs.writeFile(path.join(host, "plans", "host.md"), "host");
    await fs.mkdir(path.join(account, "plans"), { recursive: true });
    await fs.writeFile(path.join(account, "plans", "account.md"), "account");

    await linkSharedEntries(account, host, ["plans"], ["plans"]);

    expect(await fs.readdir(path.join(host, "plans"))).toEqual(["host.md"]);
    expect(await fs.readdir(path.join(account, "plans"))).toEqual(["account.md"]);
    expect(await privateSharedEntries("claude", account)).toEqual(["plans"]);
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

describe("privateSharedEntries", () => {
  test("names shared entries the account now holds as its own file or directory", async () => {
    const host = path.join(root, "host");
    const account = path.join(root, "account");
    await fs.mkdir(path.join(host, "rules"), { recursive: true });
    await fs.writeFile(path.join(host, "config.toml"), "host");
    await fs.writeFile(path.join(host, "AGENTS.md"), "host");
    await fs.mkdir(account, { recursive: true });
    await linkSharedEntries(account, host, ["config.toml", "AGENTS.md", "rules"]);
    expect(await privateSharedEntries("codex", account)).toEqual([]);

    // A save by atomic rename replaces the link with the account's own file.
    await fs.rm(path.join(account, "config.toml"));
    await fs.writeFile(path.join(account, "config.toml"), "account");
    await fs.rm(path.join(account, "rules"));
    await fs.mkdir(path.join(account, "rules"));
    // Not a shared entry: the login itself is always the account's own.
    await fs.writeFile(path.join(account, "auth.json"), "{}");

    expect(await privateSharedEntries("codex", account)).toEqual(["config.toml", "rules"]);
    expect(await privateSharedEntries("claude", account)).toEqual(["rules"]);
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
        projects: {
          "/repo": { allowedTools: ["Bash"], lastCost: 3 },
          "/account-only": {
            mcpServers: { inside: { command: "inside" } },
            lastCost: 7,
            hasTrustDialogAccepted: true,
          },
        },
      }),
    );

    expect(await syncClaudeAccountSettings(account, hostJson)).toBe("synced");

    const synced = JSON.parse(await fs.readFile(path.join(account, ".claude.json"), "utf8"));
    expect(synced.oauthAccount).toEqual({ emailAddress: "second@example.com" });
    expect(synced.mcpServers).toEqual({ docs: { type: "stdio", command: "docs" } });
    expect(synced.hasCompletedOnboarding).toBe(true);
    expect(synced.projects["/account-only"]).toEqual({ lastCost: 7, hasTrustDialogAccepted: true });
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
    for (const entry of sharedDirectories.codex) {
      expect((await fs.stat(path.join(hostCodex, entry))).isDirectory()).toBe(true);
      expect(await fs.readlink(path.join(home, entry))).toBe(path.join(hostCodex, entry));
    }
    expect(await fs.readlink(path.join(home, "config.toml"))).toBe(
      path.join(hostCodex, "config.toml"),
    );
    await expect(fs.lstat(path.join(home, "state_5.sqlite"))).rejects.toThrow();
  });
});

describe("prepareAgentAccountHome for Claude", () => {
  test("creates every shared directory on the host so no account grows its own", async () => {
    const hostClaude = path.join(root, "claude-host");
    await fs.mkdir(hostClaude, { recursive: true });
    await fs.writeFile(path.join(hostClaude, "settings.json"), "{}");
    const home = path.join(root, "accounts", "claude", "one");

    await prepareAgentAccountHome("claude", home, {
      claudeHome: hostClaude,
      claudeJson: path.join(root, "claude.json"),
      codexHome: path.join(root, "codex-host"),
    });

    for (const entry of sharedDirectories.claude) {
      expect((await fs.stat(path.join(hostClaude, entry))).isDirectory()).toBe(true);
      expect(await fs.readlink(path.join(home, entry))).toBe(path.join(hostClaude, entry));
    }
    // Files are linked only when the host has them.
    await expect(fs.lstat(path.join(home, "keybindings.json"))).rejects.toThrow();
    expect(await privateSharedEntries("claude", home)).toEqual([]);
  });
});

for (const platform of ["claude", "codex"] as const) {
  describe(`prepareAgentAccountHome ${platform} adoption fallbacks`, () => {
    function sources() {
      return {
        claudeHome: path.join(root, "host"),
        claudeJson: path.join(root, "host.claude.json"),
        codexHome: path.join(root, "host"),
      };
    }

    test.each(["foo", "nested/foo"])(
      "keeps skills private and readable with an external relative link at %s",
      async (entry) => {
        const account = path.join(root, "account");
        const skills = path.join(account, "skills");
        const skillStore = path.join(account, "skill-store", "foo");
        const link = path.join(skills, entry);
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.mkdir(skillStore, { recursive: true });
        await fs.writeFile(path.join(skillStore, "SKILL.md"), "account skill");
        const relativeTarget = path.relative(path.dirname(link), skillStore);
        await fs.symlink(relativeTarget, link);

        await prepareAgentAccountHome(platform, account, sources());
        await prepareAgentAccountHome(platform, account, sources());

        expect((await fs.lstat(skills)).isDirectory()).toBe(true);
        expect(await fs.readlink(link)).toBe(relativeTarget);
        expect(await fs.realpath(link)).toBe(skillStore);
        expect(await fs.readFile(path.join(link, "SKILL.md"), "utf8")).toBe("account skill");
        expect(await fs.readdir(path.join(root, "host", "skills"))).toEqual([]);
        expect(await privateSharedEntries(platform, account)).toEqual(["skills"]);
        expect(await fs.readlink(path.join(account, "rules"))).toBe(
          path.join(root, "host", "rules"),
        );
      },
    );

    test("adopts skills containing absolute links without following them", async () => {
      const account = path.join(root, "account");
      const skills = path.join(account, "skills");
      const store = path.join(root, "skill-store", "foo");
      await fs.mkdir(skills, { recursive: true });
      await fs.mkdir(store, { recursive: true });
      await fs.writeFile(path.join(store, "SKILL.md"), "absolute skill");
      await fs.symlink(store, path.join(skills, "foo"));
      // A link cycle must not cause recursive traversal of linked directories.
      await fs.symlink(skills, path.join(skills, "self"));

      await prepareAgentAccountHome(platform, account, sources());

      expect(await fs.readlink(skills)).toBe(path.join(root, "host", "skills"));
      expect(await fs.readFile(path.join(skills, "foo", "SKILL.md"), "utf8")).toBe(
        "absolute skill",
      );
      expect(await privateSharedEntries(platform, account)).toEqual([]);
    });

    test("leaves a non-directory account entry private and creates the host directory", async () => {
      const account = path.join(root, "account");
      await fs.mkdir(account, { recursive: true });
      await fs.writeFile(path.join(account, "skills"), "account contents");

      await prepareAgentAccountHome(platform, account, sources());

      expect(await fs.readFile(path.join(account, "skills"), "utf8")).toBe("account contents");
      expect((await fs.stat(path.join(root, "host", "skills"))).isDirectory()).toBe(true);
      expect(await privateSharedEntries(platform, account)).toEqual(["skills"]);
      expect(await fs.readlink(path.join(account, "rules"))).toBe(path.join(root, "host", "rules"));
    });

    test.each(["EXDEV", "EACCES"])(
      "keeps account contents private and finishes preparation when adoption fails with %s",
      async (code) => {
        const account = path.join(root, "account");
        const skills = path.join(account, "skills");
        await fs.mkdir(skills, { recursive: true });
        await fs.writeFile(path.join(skills, "SKILL.md"), "private skill");
        const rename = spyOn(fs, "rename").mockRejectedValueOnce(
          Object.assign(new Error("adoption failed"), { code }),
        );
        try {
          await prepareAgentAccountHome(platform, account, sources());
          expect(rename).toHaveBeenCalledWith(skills, path.join(root, "host", "skills"));
        } finally {
          rename.mockRestore();
        }

        expect((await fs.lstat(skills)).isDirectory()).toBe(true);
        expect(await fs.readFile(path.join(skills, "SKILL.md"), "utf8")).toBe("private skill");
        expect(await fs.readdir(path.join(root, "host", "skills"))).toEqual([]);
        expect(await privateSharedEntries(platform, account)).toEqual(["skills"]);
        expect(await fs.readlink(path.join(account, "rules"))).toBe(
          path.join(root, "host", "rules"),
        );
      },
    );

    for (const obstacle of ["file", "dangling symlink"] as const) {
      test.each(["missing", "stale link"])(
        `continues with a host ${obstacle} and a %s account entry`,
        async (accountEntry) => {
          const host = path.join(root, "host");
          const account = path.join(root, "account");
          await fs.mkdir(host, { recursive: true });
          await fs.mkdir(path.join(account, "skills"), { recursive: true });
          await fs.writeFile(path.join(account, "skills", "SKILL.md"), "private skill");
          for (const entry of ["skills", "plugins"]) {
            const target = path.join(host, entry);
            if (obstacle === "file") await fs.writeFile(target, "host contents");
            else await fs.symlink(path.join(root, "missing", entry), target);
          }
          if (accountEntry === "stale link") {
            await fs.symlink(path.join(host, "plugins"), path.join(account, "plugins"));
          }

          await prepareAgentAccountHome(platform, account, sources());
          await prepareAgentAccountHome(platform, account, sources());

          expect(await fs.readFile(path.join(account, "skills", "SKILL.md"), "utf8")).toBe(
            "private skill",
          );
          expect(await privateSharedEntries(platform, account)).toEqual(["skills"]);
          await expect(fs.lstat(path.join(account, "plugins"))).rejects.toThrow();
          for (const entry of ["skills", "plugins"]) {
            const target = path.join(host, entry);
            if (obstacle === "file") {
              expect(await fs.readFile(target, "utf8")).toBe("host contents");
            } else {
              expect(await fs.readlink(target)).toBe(path.join(root, "missing", entry));
            }
          }
          expect(await fs.readlink(path.join(account, "rules"))).toBe(path.join(host, "rules"));
        },
      );
    }
  });
}

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
