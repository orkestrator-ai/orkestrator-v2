/**
 * Source scope and the per-query configuration revision.
 *
 * Split from `mcp-config.test.ts` because these pin two rules that are about
 * policy and reporting rather than parsing: a coordinator's inline MCP set is
 * the injected Orkestrator server(s) and nothing else, and a query can say
 * exactly which saved configuration it started with.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { setClaudeHomeForTesting } from "./claude-home.js";
import { clearJsonFileCache } from "./json-file-cache.js";
import { getMcpRuntimeConfig, mcpSourceScopeForPolicy } from "./mcp-config.js";
import { coordinatorProcessPolicy } from "./read-only-policy.js";
import { READ_ONLY_TURN_POLICY } from "./claude-query-config.js";

const AGENT_ENV = {
  ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/mcp",
  ORKESTRATOR_AGENT_MCP_TOKEN: "coordinator-token",
};

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("base64url")}`;
}

describe("mcpSourceScopeForPolicy", () => {
  test("maps each policy to the sources it may load", () => {
    expect(mcpSourceScopeForPolicy(undefined)).toBe("all");
    expect(
      mcpSourceScopeForPolicy({
        id: "interactive-host",
        sandbox: "none",
        approvals: "auto-approve",
        projectResources: true,
        networkAccess: "full",
      } as NativeAgentExecutionPolicy),
    ).toBe("all");
    expect(
      mcpSourceScopeForPolicy({
        id: "interactive-host",
        sandbox: "provider",
        approvals: "ask",
        projectResources: false,
        networkAccess: "restricted",
      } as NativeAgentExecutionPolicy),
    ).toBe("user");
    // Both ways a turn becomes a coordinator: the process authority and a
    // read-only prompt.
    expect(mcpSourceScopeForPolicy(coordinatorProcessPolicy())).toBe("none");
    expect(mcpSourceScopeForPolicy(READ_ONLY_TURN_POLICY)).toBe("none");
  });
});

describe("getMcpRuntimeConfig scope and revision", () => {
  let home: string;
  let cwd: string;
  let claudeJson: string;
  let mcpJson: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-bridge-mcp-scope-home-"));
    cwd = await mkdtemp(join(tmpdir(), "claude-bridge-mcp-scope-project-"));
    setClaudeHomeForTesting(home);
    clearJsonFileCache();
    claudeJson = JSON.stringify({
      mcpServers: { userServer: { command: "user-command" } },
      projects: { [cwd]: { mcpServers: { localServer: { command: "local-command" } } } },
    });
    mcpJson = JSON.stringify({ mcpServers: { projectServer: { command: "project-command" } } });
    await writeFile(join(home, ".claude.json"), claudeJson);
    await writeFile(join(cwd, ".mcp.json"), mcpJson);
  });

  afterEach(async () => {
    setClaudeHomeForTesting(null);
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    clearJsonFileCache();
  });

  test("a coordinator loads only the injected Orkestrator server", async () => {
    const scope = mcpSourceScopeForPolicy(coordinatorProcessPolicy());
    const { servers, names, revision } = await getMcpRuntimeConfig(
      cwd,
      AGENT_ENV,
      undefined,
      scope,
    );

    expect(Object.keys(servers)).toEqual(["orkestrator"]);
    expect([...names]).toEqual(["orkestrator"]);
    expect(revision.scope).toBe("none");
    expect(revision.sources).toEqual({ user: "excluded", project: "excluded" });
  });

  test("a coordinator with a design connection keeps both injected servers only", async () => {
    const { servers } = await getMcpRuntimeConfig(
      cwd,
      {},
      { url: "http://127.0.0.1:4567/mcp", token: "tab-token", design: true },
      "none",
    );
    expect(Object.keys(servers).sort()).toEqual(["orkestrator", "orkestrator-design"]);
  });

  test("a coordinator without an injected server gets an empty inline set", async () => {
    const { servers, names } = await getMcpRuntimeConfig(cwd, {}, undefined, "none");
    expect(servers).toEqual({});
    expect(names.size).toBe(0);
  });

  test("all sources report the digest of the exact bytes read", async () => {
    const { servers, revision } = await getMcpRuntimeConfig(cwd, {}, undefined, "all");

    expect(Object.keys(servers).sort()).toEqual(["localServer", "projectServer", "userServer"]);
    expect(revision.scope).toBe("all");
    expect(revision.sources).toEqual({ user: sha256(claudeJson), project: sha256(mcpJson) });
    expect(revision.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a missing project file is absent, not excluded", async () => {
    await rm(join(cwd, ".mcp.json"));
    const { revision } = await getMcpRuntimeConfig(cwd, {}, undefined, "all");
    expect(revision.sources.project).toBe("absent");
  });

  test("the fingerprint moves with a saved edit and is stable otherwise", async () => {
    const first = await getMcpRuntimeConfig(cwd, {}, undefined, "all");
    const again = await getMcpRuntimeConfig(cwd, {}, undefined, "all");
    expect(again.revision).toEqual(first.revision);

    // Past coarse mtime granularity; the size differs too.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const edited = JSON.stringify({ mcpServers: { renamed: { command: "project-command" } } });
    await writeFile(join(cwd, ".mcp.json"), edited);

    const after = await getMcpRuntimeConfig(cwd, {}, undefined, "all");
    expect(after.revision.sources.project).toBe(sha256(edited));
    expect(after.revision.sources.user).toBe(first.revision.sources.user);
    expect(after.revision.fingerprint).not.toBe(first.revision.fingerprint);
    expect(Object.keys(after.servers)).toContain("renamed");
  });

  test("a malformed file still has a digest, so fixing it reads as a change", async () => {
    await writeFile(join(cwd, ".mcp.json"), "{ not json");
    const { servers, revision } = await getMcpRuntimeConfig(cwd, {}, undefined, "all");
    expect(Object.keys(servers)).not.toContain("projectServer");
    expect(revision.sources.project).toBe(sha256("{ not json"));
  });

  test("the revision never carries a path or a server body", async () => {
    const { revision } = await getMcpRuntimeConfig(cwd, AGENT_ENV, undefined, "all");
    const serialized = JSON.stringify(revision);
    for (const secret of [home, cwd, "user-command", "project-command", "coordinator-token"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
