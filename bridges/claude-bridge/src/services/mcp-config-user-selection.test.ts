/**
 * Per-session user MCP servers (graphs item 404).
 *
 * A graph node's policy selects the configured servers its session may load
 * (`capabilityPolicy.userMcpServers`). These pin the Claude half: the inline
 * set holds exactly the granted servers (plus the reserved Orkestrator
 * server), the CLI is told to load nothing else (`strictMcpConfig`), a
 * read-only turn keeps the grant, and only granted servers' tools are
 * approved up front or admitted by the read-only hook.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { setClaudeHomeForTesting } from "./claude-home.js";
import { clearJsonFileCache } from "./json-file-cache.js";
import {
  claudeGrantedMcpServerNames,
  claudeUserMcpQueryOptions,
  getMcpRuntimeConfig,
  mcpSourceScopeForPolicy,
  userMcpServerFilter,
} from "./mcp-config.js";
import {
  claudeTurnPolicy,
  READ_ONLY_TURN_POLICY,
  readOnlyTurnPolicy,
} from "./claude-query-config.js";
import { claudeReadOnlyAllowedTools, createCoordinatorReadOnlyHook } from "./read-only-policy.js";

const AGENT_ENV = {
  ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/mcp",
  ORKESTRATOR_AGENT_MCP_TOKEN: "node-token",
};

const pipeline: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

function selecting(userMcpServers: string[], deny: string[] = []): NativeAgentExecutionPolicy {
  return { ...pipeline, capabilityPolicy: { deny: deny as never, userMcpServers } };
}

describe("user MCP selection on Claude", () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-bridge-mcp-select-home-"));
    cwd = await mkdtemp(join(tmpdir(), "claude-bridge-mcp-select-project-"));
    setClaudeHomeForTesting(home);
    clearJsonFileCache();
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          docs: { type: "http", url: "https://docs.example.test/mcp" },
          linear: { command: "linear-mcp" },
          // A configured server under the reserved name never wins.
          orkestrator: { command: "not-orkestrator" },
        },
      }),
    );
  });

  afterEach(async () => {
    setClaudeHomeForTesting(null);
    clearJsonFileCache();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  test("a granted server is in the inline set and an ungranted one is absent", async () => {
    const policy = selecting(["docs"]);
    const { servers, names } = await getMcpRuntimeConfig(
      cwd,
      AGENT_ENV,
      undefined,
      mcpSourceScopeForPolicy(policy),
      userMcpServerFilter(policy),
    );
    expect(Object.keys(servers).sort()).toEqual(["docs", "orkestrator"]);
    expect(servers.orkestrator).toMatchObject({
      type: "http",
      url: AGENT_ENV.ORKESTRATOR_AGENT_MCP_URL,
    });
    expect(names.has("linear")).toBe(false);
    expect(names.has("docs")).toBe(true);
  });

  test("no grant means no user server; a denial wins over a grant", async () => {
    for (const policy of [selecting([]), selecting(["docs"], ["mcp:docs"])]) {
      const { servers } = await getMcpRuntimeConfig(
        cwd,
        AGENT_ENV,
        undefined,
        mcpSourceScopeForPolicy(policy),
        userMcpServerFilter(policy),
      );
      expect(Object.keys(servers)).toEqual(["orkestrator"]);
    }
  });

  test("a policy without a selection keeps every configured server", async () => {
    expect(userMcpServerFilter(pipeline)).toBeUndefined();
    expect(claudeUserMcpQueryOptions(pipeline)).toEqual({});
    const { servers } = await getMcpRuntimeConfig(cwd, {}, undefined, "user");
    expect(Object.keys(servers).sort()).toEqual(["docs", "linear", "orkestrator"]);
  });

  test("a selecting policy makes the inline set the only MCP source", () => {
    expect(claudeUserMcpQueryOptions(selecting([]))).toEqual({ strictMcpConfig: true });
    expect(claudeUserMcpQueryOptions(selecting(["docs"]))).toEqual({ strictMcpConfig: true });
  });

  test("a read-only turn keeps the grant and loads only the granted user servers", async () => {
    const session = selecting(["docs"], ["file.write", "file.patch", "shell.mutate"]);
    const turn = claudeTurnPolicy(session, true)!;
    expect(turn.id).toBe("coordinator-read-only");
    expect(turn.capabilityPolicy?.userMcpServers).toEqual(["docs"]);
    // The fixed read-only policy alone still loads nothing.
    expect(readOnlyTurnPolicy(undefined)).toEqual(READ_ONLY_TURN_POLICY);
    expect(mcpSourceScopeForPolicy(READ_ONLY_TURN_POLICY)).toBe("none");
    expect(mcpSourceScopeForPolicy(readOnlyTurnPolicy(selecting([])))).toBe("none");
    expect(mcpSourceScopeForPolicy(turn)).toBe("user");
    const { servers } = await getMcpRuntimeConfig(
      cwd,
      AGENT_ENV,
      undefined,
      mcpSourceScopeForPolicy(turn),
      userMcpServerFilter(turn),
    );
    expect(Object.keys(servers).sort()).toEqual(["docs", "orkestrator"]);
  });

  test("only granted servers' tools are approved and admitted on a read-only turn", async () => {
    const turn = claudeTurnPolicy(selecting(["docs"]), true)!;
    const loaded = new Set(["docs", "orkestrator"]);
    expect(claudeGrantedMcpServerNames(turn, loaded)).toEqual(["docs"]);
    expect(claudeGrantedMcpServerNames(selecting(["linear"]), loaded)).toEqual([]);
    expect(claudeGrantedMcpServerNames(pipeline, loaded)).toEqual([]);
    expect(claudeReadOnlyAllowedTools({ policy: turn, grantedMcpServerNames: ["docs"] })).toContain(
      "mcp__docs__*",
    );

    const hook = createCoordinatorReadOnlyHook(turn, []);
    const call = (toolName: string) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: {},
          session_id: "s",
          transcript_path: "/dev/null",
          cwd,
          tool_use_id: "t",
        } as unknown as HookInput,
        "t",
        { signal: new AbortController().signal },
      );
    expect(await call("mcp__docs__search")).toEqual({});
    const refused = (await call("mcp__linear__create_issue")) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(refused.hookSpecificOutput?.permissionDecision).toBe("deny");
    // A coordinator's own policy carries no grant, so its hook is unchanged.
    const coordinatorHook = createCoordinatorReadOnlyHook(READ_ONLY_TURN_POLICY, []);
    const coordinatorRefusal = (await coordinatorHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__docs__search",
        tool_input: {},
        session_id: "s",
        transcript_path: "/dev/null",
        cwd,
        tool_use_id: "t",
      } as unknown as HookInput,
      "t",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(coordinatorRefusal.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
