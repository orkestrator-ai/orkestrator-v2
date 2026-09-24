import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { loadCatalog } from "./catalog.js";
import { providerSources, resolveProviderHomes } from "./providers.js";
import { renameReferenceWarnings } from "./references.js";
import { McpSourceStore } from "./source-store.js";

let root: string;
let home: string;
let worktree: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "mcp-refs-"));
  home = path.join(root, "home");
  worktree = path.join(root, "worktree");
  mkdirSync(home, { recursive: true });
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function warningsFor(provider: AgentPlatform, sourceId: string, name: string) {
  const specs = await providerSources(provider, {
    context: { kind: "environment", location: "local-worktree", worktreePath: worktree },
    homes: resolveProviderHomes({}, home),
    exists: async (file) => existsSync(file),
  });
  const store = new McpSourceStore({ keyFile: path.join(root, "data", "revision.key") });
  const catalog = await loadCatalog(store, specs);
  const source = catalog.sources.find((candidate) => candidate.spec.sourceId === sourceId)!;
  return renameReferenceWarnings(catalog, source, name);
}

describe("rename reports provider-owned references to the old name", () => {
  test("Claude user and local servers named in a project's disabledMcpServers", async () => {
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { db: { command: "x" } },
        projects: {
          [worktree]: { disabledMcpServers: ["db"], mcpServers: { db: { command: "y" } } },
          "/elsewhere": { disabledMcpServers: ["db"] },
          "/unrelated": { disabledMcpServers: ["other"] },
        },
      }),
    );
    const user = await warningsFor("claude", "claude:user", "db");
    expect(user).toHaveLength(1);
    expect(user[0]).toContain("disabledMcpServers");
    expect(user[0]).toContain(worktree);
    expect(user[0]).toContain("/elsewhere");
    expect(user[0]).not.toContain("/unrelated");
    // The private local map only concerns its own project entry.
    const local = await warningsFor("claude", "claude:local", "db");
    expect(local).toHaveLength(1);
    expect(local[0]).not.toContain("/elsewhere");
    expect(await warningsFor("claude", "claude:user", "none")).toEqual([]);
  });

  test("Claude project servers named in this project's .mcp.json approvals", async () => {
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        projects: { [worktree]: { enabledMcpjsonServers: ["shared"], disabledMcpjsonServers: [] } },
      }),
    );
    writeFileSync(
      path.join(worktree, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "x" } } }),
    );
    const warnings = await warningsFor("claude", "claude:project", "shared");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("enabledMcpjsonServers");
  });

  test("OpenCode tool switches keyed by the server name", async () => {
    const dir = path.join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        mcp: { jira: { type: "remote", url: "https://j.example/mcp" } },
        tools: { "jira_*": false, jiraish_x: true },
        agent: { plan: { tools: { jira_create: false } } },
      }),
    );
    const warnings = await warningsFor("opencode", "opencode:user-opencode.json", "jira");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tools.jira_*");
    expect(warnings[0]).toContain("agent.plan.tools.jira_create");
    expect(warnings[0]).not.toContain("jiraish");
  });

  test("providers without name references report nothing", async () => {
    expect(await warningsFor("codex", "codex:user", "x")).toEqual([]);
  });
});
