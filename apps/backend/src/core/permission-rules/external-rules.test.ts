import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexRuleEntries } from "@orkestrator/protocol/permission-rules";
import type { CommandContext } from "../commands-context.js";
import { claudeAllowEntries, listExternalPermissionRules } from "./external-rules.js";

const directories: string[] = [];
const savedEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-external-rules-"));
  directories.push(directory);
  return directory;
}

describe("parsers", () => {
  test("Codex rule lines skip blanks and comments", () => {
    expect(
      codexRuleEntries(
        '# saved by codex\n\nprefix_rule(pattern=["npm", "test"], decision="allow")\n  \n',
      ),
    ).toEqual(['prefix_rule(pattern=["npm", "test"], decision="allow")']);
  });

  test("Codex 0.166.0's saved command and network rules are each one entry", () => {
    // Exactly as the pinned binary wrote them (todo 0160, task 2).
    const lines = [
      'prefix_rule(pattern=["touch", "probe-file.txt"], decision="allow")',
      'network_rule(host="probe-host.example.test", protocol="http", decision="allow", justification="Allow http access to probe-host.example.test")',
      'network_rule(host="blocked.example.test", protocol="http", decision="deny", justification="Deny http access to blocked.example.test")',
    ];
    expect(codexRuleEntries(`${lines.join("\n")}\n`)).toEqual(lines);
  });

  test("Claude allow entries are read from permissions.allow only", () => {
    expect(
      claudeAllowEntries(
        JSON.stringify({ permissions: { allow: ["Bash(npm test:*)", 4], deny: ["Bash(rm:*)"] } }),
      ),
    ).toEqual(["Bash(npm test:*)"]);
    expect(claudeAllowEntries("{}")).toEqual([]);
    expect(claudeAllowEntries("not json")).toBeNull();
    expect(claudeAllowEntries("[]")).toBeNull();
  });
});

test("lists host and project rule files read-only, once each, and never edits them", async () => {
  const codexHome = await tempDir();
  const claudeDir = await tempDir();
  const worktree = await tempDir();
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  await fs.mkdir(path.join(codexHome, "rules"));
  const codexRules = 'prefix_rule(pattern=["curl"], decision="allow")\n';
  await fs.writeFile(path.join(codexHome, "rules", "default.rules"), codexRules);
  await fs.writeFile(path.join(codexHome, "rules", "notes.txt"), "ignored");
  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ permissions: { allow: ["WebFetch(domain:example.com)"] } }),
  );
  await fs.mkdir(path.join(worktree, ".claude"));
  await fs.writeFile(path.join(worktree, ".claude", "settings.local.json"), "{broken");

  const context = {
    storage: {
      agentAccounts: {
        loadAgentAccounts: async () => ({ version: 1, accounts: [], active: {} }),
        agentAccountsDirectory: () => path.join(codexHome, "accounts"),
      },
      loadEnvironments: async () => [
        {
          id: "env-1",
          projectId: "project-1",
          name: "feature",
          environmentType: "local",
          worktreePath: worktree,
        },
        {
          id: "env-2",
          projectId: "project-2",
          name: "other",
          environmentType: "local",
          worktreePath: worktree,
        },
      ],
    },
  } as unknown as CommandContext;

  const { files } = await listExternalPermissionRules(context, "project-1");
  expect(files).toEqual([
    expect.objectContaining({
      provider: "codex",
      location: "host",
      path: path.join(codexHome, "rules", "default.rules"),
      entries: ['prefix_rule(pattern=["curl"], decision="allow")'],
    }),
    expect.objectContaining({
      provider: "claude",
      location: "host",
      entries: ["WebFetch(domain:example.com)"],
    }),
    expect.objectContaining({
      provider: "claude",
      location: "project",
      environmentId: "env-1",
      error: "Not valid JSON",
    }),
  ]);
  expect(await fs.readFile(path.join(codexHome, "rules", "default.rules"), "utf8")).toBe(
    codexRules,
  );
});

test("container marker frames carry byte truncation and omit a cut final rule", async () => {
  const { containerCodexRules } = await import("./external-rules.js");
  const environment = {
    id: "env",
    name: "fixture",
    containerId: "container",
    status: "running",
  } as import("../models.js").Environment;
  const complete = 'prefix_rule(pattern=["npm", "test"], decision="allow")';
  const content = `${complete}\nprefix_rule(${"x".repeat(262144 - complete.length - 13)}`;
  const read = async (_container: string, script: string) => {
    expect(script).toContain("wc -c");
    return `@@orkestrator-rules-file@@ 262200 /home/user/.codex/rules/big.rules\n${content}\n@@orkestrator-rules-file@@ 8 /home/user/.codex/rules/small.rules\nanother\n\n`;
  };
  const files = await containerCodexRules(environment, read);
  expect(files).toEqual([
    expect.objectContaining({
      path: "/home/user/.codex/rules/big.rules",
      truncated: true,
      entries: [complete],
    }),
    expect.objectContaining({
      path: "/home/user/.codex/rules/small.rules",
      truncated: false,
      entries: ["another"],
    }),
  ]);
  expect(
    await containerCodexRules(environment, async () => {
      throw new Error("offline");
    }),
  ).toEqual([expect.objectContaining({ error: "Could not read the container" })]);
});

test("added accounts expose independent rule files and deduplicate linked host files", async () => {
  const root = await tempDir();
  process.env.CODEX_HOME = path.join(root, "host-codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "host-claude");
  const { agentAccountHome } = await import("../agent-accounts-homes.js");
  const codex = agentAccountHome(root, "codex", "codex-account");
  const claude = agentAccountHome(root, "claude", "claude-account");
  await fs.mkdir(path.join(codex, "rules"), { recursive: true });
  await fs.mkdir(claude, { recursive: true });
  await fs.writeFile(path.join(codex, "rules", "default.rules"), "account_rule\n");
  await fs.writeFile(
    path.join(claude, "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] } }),
  );
  const context = {
    storage: {
      agentAccounts: {
        agentAccountsDirectory: () => root,
        loadAgentAccounts: async () => ({
          accounts: [
            { id: "codex-account", platform: "codex", label: "Codex fixture" },
            { id: "claude-account", platform: "claude", label: "Claude fixture" },
          ],
        }),
      },
      loadEnvironments: async () => [],
    },
  } as unknown as CommandContext;
  const { files } = await listExternalPermissionRules(context);
  expect(files).toEqual([
    expect.objectContaining({ location: "account", provider: "codex", entries: ["account_rule"] }),
    expect.objectContaining({
      location: "account",
      provider: "claude",
      entries: ["Bash(npm test:*)"],
    }),
  ]);
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
  await fs.symlink(path.join(codex, "rules"), path.join(process.env.CODEX_HOME, "rules"));
  expect(
    (await listExternalPermissionRules(context)).files.filter((file) => file.provider === "codex"),
  ).toHaveLength(1);
});
