import { describe, expect, mock, test } from "bun:test";
import type { HookCallback, HookInput, McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQueryControl } from "../types/index.js";
import type { SdkMcpServersConfig } from "./mcp-config.js";
import {
  claudeMcpToolPrefix,
  createClaudeRuntimeMcp,
  createStaleMcpServerHook,
  type McpSyncRuntime,
  reportedStaleServers,
  staleMcpServerFor,
  syncClaudeRuntimeMcp,
} from "./session-manager-prompt-mcp-sync.js";
import {
  mockGetMcpRuntimeConfig,
  queryControlOverrides,
  releaseWithBackgroundWork,
  sendPrompt,
} from "./session-manager-test-harness.js";
import { sessionRuntimeHealthBody } from "../routes/runtime-health-body.js";

const stdio = (name: string, version = "1"): SdkMcpServersConfig[string] => ({
  type: "stdio",
  command: "fixture",
  args: [name, version],
});

/**
 * A control that follows the pinned CLI's rule: `setMcpServers` replaces only
 * what an earlier call gave it, so a launch server survives a call that omits
 * it until some call has named it. `files` are servers the CLI loaded from a
 * settings file that the bridge never passes inline.
 */
function fakeCli(
  launch: SdkMcpServersConfig,
  options: { files?: string[]; neverRemoves?: boolean; noStatus?: boolean } = {},
) {
  const launched = new Set(Object.keys(launch));
  const owned = new Set<string>();
  const files = new Set(options.files ?? []);
  const calls: SdkMcpServersConfig[] = [];
  const statusReads = mock(async (): Promise<McpServerStatus[]> => [
    ...Array.from(files, (name) => ({ name, status: "failed" as const, source: "user" })),
    ...Array.from(new Set([...launched, ...owned]), (name) => ({
      name,
      status: "connected" as const,
      source: "dynamic",
    })),
  ]);
  const control: ClaudeQueryControl = {
    setMcpServers: mock(async (servers: SdkMcpServersConfig) => {
      calls.push(servers);
      const removed: string[] = [];
      for (const name of Array.from(owned)) {
        if (name in servers || options.neverRemoves) continue;
        owned.delete(name);
        removed.push(name);
      }
      for (const name of Object.keys(servers)) {
        launched.delete(name);
        files.delete(name);
        owned.add(name);
      }
      return { added: Object.keys(servers), removed, errors: {} };
    }),
    ...(options.noStatus ? {} : { mcpServerStatus: statusReads }),
  } as unknown as ClaudeQueryControl;
  const running = () => [...files, ...launched, ...owned];
  return { control, calls, statusReads, running };
}

function runtimeFor(
  control: ClaudeQueryControl,
  launch: SdkMcpServersConfig,
  declared: string[] = Object.keys(launch),
): McpSyncRuntime {
  return { control, mcpServers: "launch", mcp: createClaudeRuntimeMcp(launch, declared) };
}

const target = (servers: SdkMcpServersConfig, key: string, names = Object.keys(servers)) => ({
  servers,
  key,
  names: new Set(names),
  required: [] as string[],
});

describe("syncing a running CLI's MCP servers", () => {
  test("a launch server is taken over unchanged before it is dropped", async () => {
    const launch = { alpha: stdio("alpha"), keep: stdio("keep") };
    const cli = fakeCli(launch);
    const runtime = runtimeFor(cli.control, launch);
    await syncClaudeRuntimeMcp(runtime, target({ keep: stdio("keep") }, "next"));
    expect(cli.calls).toEqual([launch, { keep: stdio("keep") }]);
    expect(cli.running()).toEqual(["keep"]);
    expect(runtime.mcp.stale.size).toBe(0);
    expect(runtime.mcpServers).toBe("next");
    expect(reportedStaleServers(runtime.mcp)).toBeUndefined();
  });

  test("a rename unloads the old name and loads the new one", async () => {
    const launch = { alpha: stdio("alpha") };
    const cli = fakeCli(launch);
    const runtime = runtimeFor(cli.control, launch);
    await syncClaudeRuntimeMcp(runtime, target({ beta: stdio("alpha") }, "renamed"));
    expect(cli.running()).toEqual(["beta"]);
    expect(runtime.mcp.stale.size).toBe(0);
  });

  test("adds and edits need no takeover, and an unchanged configuration sends nothing", async () => {
    const launch = { alpha: stdio("alpha") };
    const cli = fakeCli(launch);
    const runtime = runtimeFor(cli.control, launch);
    await syncClaudeRuntimeMcp(
      runtime,
      target({ alpha: stdio("alpha"), beta: stdio("beta") }, "a"),
    );
    await syncClaudeRuntimeMcp(runtime, target({ alpha: stdio("alpha", "2") }, "b"));
    await syncClaudeRuntimeMcp(runtime, target({ alpha: stdio("alpha", "2") }, "b"));
    // The first update named every server, so the second could drop beta itself.
    expect(cli.calls).toEqual([
      { alpha: stdio("alpha"), beta: stdio("beta") },
      { alpha: stdio("alpha", "2") },
    ]);
    expect(cli.running()).toEqual(["alpha"]);
    expect(runtime.mcp.stale.size).toBe(0);
    // Only the update that dropped a server had anything to verify.
    expect(cli.statusReads).toHaveBeenCalledTimes(1);
  });

  test("a server the CLI keeps is reported stale, and re-declaring it clears that", async () => {
    const launch = { alpha: stdio("alpha"), keep: stdio("keep") };
    const cli = fakeCli(launch, { neverRemoves: true });
    const runtime = runtimeFor(cli.control, launch);
    await syncClaudeRuntimeMcp(runtime, target({ keep: stdio("keep") }, "dropped"));
    expect(Array.from(runtime.mcp.stale)).toEqual(["alpha"]);
    expect(reportedStaleServers(runtime.mcp)).toEqual(["alpha"]);
    // Staying stale across a turn that changes nothing.
    await syncClaudeRuntimeMcp(runtime, target({ keep: stdio("keep") }, "dropped"));
    expect(Array.from(runtime.mcp.stale)).toEqual(["alpha"]);
    await syncClaudeRuntimeMcp(
      runtime,
      target({ alpha: stdio("alpha", "2"), keep: stdio("keep") }, "back"),
    );
    expect(runtime.mcp.stale.size).toBe(0);
  });

  test("a server only a settings file declared is stale once the file drops it", async () => {
    // An SSE entry: the bridge never passes it inline, so no update unloads it.
    const launch = { keep: stdio("keep") };
    const cli = fakeCli(launch, { files: ["remote"] });
    const runtime = runtimeFor(cli.control, launch, ["keep", "remote"]);
    await syncClaudeRuntimeMcp(runtime, target(launch, "launch", ["keep"]));
    expect(cli.calls).toEqual([]);
    expect(Array.from(runtime.mcp.stale)).toEqual(["remote"]);
  });

  test("without a status read only a reported removal proves a server gone", async () => {
    const launch = { alpha: stdio("alpha"), beta: stdio("beta") };
    const cli = fakeCli(launch, { noStatus: true });
    const runtime = runtimeFor(cli.control, launch, ["alpha", "beta", "remote"]);
    await syncClaudeRuntimeMcp(runtime, target({ beta: stdio("beta") }, "next"));
    expect(Array.from(runtime.mcp.stale)).toEqual(["remote"]);
  });

  test("a failed update leaves the identity empty, so the retry restates it", async () => {
    const launch = { alpha: stdio("alpha") };
    const control = {
      setMcpServers: mock(async () => ({ added: [], removed: [], errors: { beta: "boom" } })),
    } as unknown as ClaudeQueryControl;
    const runtime = runtimeFor(control, launch);
    await expect(
      syncClaudeRuntimeMcp(runtime, target({ alpha: stdio("alpha"), beta: stdio("beta") }, "x")),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(runtime.mcpServers).toBe("");
    expect(runtime.mcp.declared).toEqual(new Set(["alpha"]));
  });
});

describe("refusing a stale server's tools", () => {
  const mcpWith = (declared: string[], stale: string[]) => {
    const mcp = createClaudeRuntimeMcp({}, declared);
    for (const name of stale) mcp.stale.add(name);
    return mcp;
  };

  test("the prefix follows the CLI's own tool naming", () => {
    expect(claudeMcpToolPrefix("my.server x")).toBe("mcp__my_server_x__");
    expect(claudeMcpToolPrefix("a-b_c")).toBe("mcp__a-b_c__");
  });

  test("the longest prefix wins, and a tie is refused", () => {
    const mcp = mcpWith(["x__y", "a_b"], ["x", "a.b"]);
    expect(staleMcpServerFor(mcp, "mcp__x__probe", {})).toBe("x");
    expect(staleMcpServerFor(mcp, "mcp__x__y__probe", {})).toBeUndefined();
    expect(staleMcpServerFor(mcp, "mcp__a_b__probe", {})).toBe("a.b");
    expect(staleMcpServerFor(mcp, "mcp__other__probe", {})).toBeUndefined();
    expect(staleMcpServerFor(mcp, "Bash", { server: "x" })).toBeUndefined();
  });

  test("MCP resource tools are matched by the server they name", () => {
    const mcp = mcpWith([], ["alpha"]);
    expect(staleMcpServerFor(mcp, "ReadMcpResourceTool", { server: "alpha", uri: "x" })).toBe(
      "alpha",
    );
    expect(staleMcpServerFor(mcp, "ReadMcpResourceTool", { server: "beta" })).toBeUndefined();
  });

  test("the hook denies only a stale server's calls", async () => {
    const mcp = mcpWith(["keep"], []);
    const hook = createStaleMcpServerHook(mcp);
    const call = (tool_name: string) =>
      hook(
        { hook_event_name: "PreToolUse", tool_name, tool_input: {} } as unknown as HookInput,
        "tool-1",
        { signal: new AbortController().signal },
      );
    expect(await call("mcp__alpha__probe")).toEqual({});
    // The runtime's state is read at each call, not captured at launch.
    mcp.stale.add("alpha");
    expect(await call("mcp__alpha__probe")).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(await call("mcp__keep__probe")).toEqual({});
  });
});

describe("joining a running CLI after a removal", () => {
  async function launchWith(servers: SdkMcpServersConfig, name: string) {
    const config = (current: SdkMcpServersConfig) => ({
      servers: current,
      names: new Set(Object.keys(current)),
      revision: { fingerprint: "f", sources: { user: "absent", project: "absent" }, scope: "all" },
    });
    mockGetMcpRuntimeConfig.mockImplementation(async () => config(servers));
    const released = await releaseWithBackgroundWork(name);
    return { ...released, configure: (next: SdkMcpServersConfig) => config(next) };
  }

  /** The PreToolUse hooks the CLI would run for `toolName`, as its matchers select them. */
  function preToolUseHooks(options: Record<string, unknown>, toolName: string): HookCallback[] {
    const hooks = options.hooks as {
      PreToolUse: Array<{ matcher?: string; hooks: HookCallback[] }>;
    };
    return hooks.PreToolUse.filter(
      (entry) => !entry.matcher || new RegExp(entry.matcher).test(toolName),
    ).flatMap((entry) => entry.hooks);
  }

  async function denies(options: Record<string, unknown>, toolName: string) {
    for (const hook of preToolUseHooks(options, toolName)) {
      const output = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: {},
          tool_use_id: "t-1",
        } as unknown as HookInput,
        "t-1",
        { signal: new AbortController().signal },
      );
      const decision = (output as { hookSpecificOutput?: { permissionDecision?: string } })
        .hookSpecificOutput?.permissionDecision;
      if (decision === "deny") return true;
    }
    return false;
  }

  test("the launch set is restated, then the removal applies and nothing is stale", async () => {
    const cli = fakeCli({ alpha: stdio("alpha") });
    queryControlOverrides.setMcpServers = cli.control.setMcpServers;
    queryControlOverrides.mcpServerStatus = cli.control.mcpServerStatus;
    const { session, call, input, firstPrompt, configure } = await launchWith(
      { alpha: stdio("alpha") },
      "mcp removal",
    );
    mockGetMcpRuntimeConfig.mockImplementation(async () => configure({}));
    const second = sendPrompt(session.id, "after removal");
    expect((await input.next()).done).toBe(false);
    expect(cli.calls).toEqual([{ alpha: stdio("alpha") }, {}]);
    expect(cli.running()).toEqual([]);
    const revision = sessionRuntimeHealthBody(session).mcpConfig as Record<string, unknown>;
    expect(revision.staleServers).toBeUndefined();
    expect(await denies(call.options, "mcp__alpha__probe")).toBe(false);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await Promise.all([firstPrompt, second]);
  });

  test("a server the CLI keeps is reported and its tools are refused", async () => {
    const cli = fakeCli({ alpha: stdio("alpha") }, { neverRemoves: true });
    queryControlOverrides.setMcpServers = cli.control.setMcpServers;
    queryControlOverrides.mcpServerStatus = cli.control.mcpServerStatus;
    const { session, call, input, firstPrompt, configure } = await launchWith(
      { alpha: stdio("alpha") },
      "mcp kept",
    );
    mockGetMcpRuntimeConfig.mockImplementation(async () => configure({}));
    const second = sendPrompt(session.id, "after removal");
    // The prompt still runs: refusing the tools holds the removal.
    expect((await input.next()).done).toBe(false);
    const revision = sessionRuntimeHealthBody(session).mcpConfig as Record<string, unknown>;
    expect(revision.staleServers).toEqual(["alpha"]);
    expect(await denies(call.options, "mcp__alpha__probe")).toBe(true);
    expect(await denies(call.options, "mcp__beta__probe")).toBe(false);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await Promise.all([firstPrompt, second]);
  });
});
