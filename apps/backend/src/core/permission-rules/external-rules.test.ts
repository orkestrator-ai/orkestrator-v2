import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "../commands-context.js";
import {
  claudeAllowEntries,
  codexRuleEntries,
  listExternalPermissionRules,
} from "./external-rules.js";

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
