/**
 * Per-session user MCP servers on Codex (graphs item 404).
 *
 * A graph node's policy selects the configured MCP servers its session may
 * load. Codex has no per-thread server list, so the engine reads the
 * effective `mcp_servers` table back and disables every server outside the
 * selection for that thread; a granted one is left on, with its tools
 * approved up front unless the policy asks.
 */
import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  codexConfiguredMcpServerNames,
  codexReadOnlyTurnPolicy,
  codexUserMcpThreadConfig,
} from "../codex-config.js";
import { BUILD, harness, thread } from "./app-server-engine-test-harness.js";
import type { EngineTurnConfig } from "./types.js";

const RESERVED = new Set(["orkestrator", "codex_apps"]);

function selecting(
  userMcpServers: string[] | undefined,
  deny: string[] = [],
  approvals: NativeAgentExecutionPolicy["approvals"] = "auto-approve",
): NativeAgentExecutionPolicy {
  return {
    id: "pipeline",
    sandbox: "none",
    approvals,
    // On, so the thread needs no skills/list round trip.
    projectResources: true,
    networkAccess: "full",
    capabilityPolicy: {
      deny: deny as never,
      ...(userMcpServers ? { userMcpServers } : {}),
    },
  };
}

describe("codexUserMcpThreadConfig", () => {
  test("a granted server stays on and an ungranted one is disabled", () => {
    expect(
      codexUserMcpThreadConfig(selecting(["docs"]), ["docs", "linear", "orkestrator"], RESERVED),
    ).toEqual({
      "mcp_servers.linear.enabled": false,
      "mcp_servers.docs.default_tools_approval_mode": "approve",
    });
  });

  test("no grant disables every user server; reserved servers are never touched", () => {
    expect(
      codexUserMcpThreadConfig(selecting([]), ["docs", "codex_apps", "orkestrator"], RESERVED),
    ).toEqual({ "mcp_servers.docs.enabled": false });
  });

  test("a denial wins over a grant, and a deny-only policy disables just that server", () => {
    expect(
      codexUserMcpThreadConfig(selecting(["docs"], ["mcp:docs"]), ["docs", "linear"], RESERVED),
    ).toEqual({ "mcp_servers.docs.enabled": false, "mcp_servers.linear.enabled": false });
    expect(
      codexUserMcpThreadConfig(selecting(undefined, ["mcp:docs"]), ["docs", "linear"], RESERVED),
    ).toEqual({ "mcp_servers.docs.enabled": false });
  });

  test("a policy that narrows nothing changes nothing", () => {
    expect(codexUserMcpThreadConfig(selecting(undefined), ["docs"], RESERVED)).toEqual({});
    expect(codexUserMcpThreadConfig(undefined, ["docs"], RESERVED)).toEqual({});
  });

  test("an asking policy keeps Codex's own approval for granted tools", () => {
    expect(
      codexUserMcpThreadConfig(selecting(["docs"], [], "ask"), ["docs", "linear"], RESERVED),
    ).toEqual({ "mcp_servers.linear.enabled": false });
  });

  test("a server that cannot be disabled by name refuses the thread", () => {
    expect(() => codexUserMcpThreadConfig(selecting([]), ["my.server"], RESERVED)).toThrow(
      "cannot be disabled",
    );
    // Granted, it needs no override and is simply left as configured.
    expect(
      codexUserMcpThreadConfig(selecting(["my.server"], [], "ask"), ["my.server"], RESERVED),
    ).toEqual({});
  });

  test("reads the configured names from config/read", () => {
    expect(codexConfiguredMcpServerNames({ mcp_servers: { a: {}, b: {} } })).toEqual(["a", "b"]);
    expect(codexConfiguredMcpServerNames({})).toEqual([]);
    expect(codexConfiguredMcpServerNames({ mcp_servers: [] })).toBeUndefined();
    expect(codexConfiguredMcpServerNames(null)).toBeUndefined();
  });

  test("a read-only turn keeps the session's selection and other denials", () => {
    const turn = codexReadOnlyTurnPolicy({
      ...selecting(["docs"]),
      capabilityPolicy: {
        deny: ["file.write"],
        allow: ["web.search"],
        extendedDeny: ["subagents"],
        userMcpServers: ["docs"],
      },
    });
    expect(turn.capabilityPolicy).toEqual({
      deny: ["file.write", "network"],
      extendedDeny: ["subagents"],
      userMcpServers: ["docs"],
    });
  });
});

describe("thread configuration on the engine", () => {
  const config: EngineTurnConfig = { ...BUILD, policy: selecting(["docs"]) };

  test("start, resume and fork disable the ungranted servers", async () => {
    const h = harness({
      "config/read": () => ({
        config: { mcp_servers: { docs: { url: "https://docs.test" }, linear: { command: "x" } } },
      }),
      "thread/start": () => ({ thread: thread("t1") }),
      "thread/resume": () => ({ thread: thread("t1") }),
      "thread/fork": () => ({ thread: thread("t2") }),
    });
    try {
      await h.engine.start();
      await h.engine.startThread({ config });
      await h.engine.resumeThread("t1", { config, includeTurns: true });
      await h.engine.forkThread("t1", config);
      for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
        const params = h.child().requests.find((request) => request.method === method)?.params;
        expect(params?.config).toMatchObject({
          "mcp_servers.linear.enabled": false,
          "mcp_servers.docs.default_tools_approval_mode": "approve",
        });
        expect(Object.keys(params?.config ?? {})).not.toContain("mcp_servers.docs.enabled");
      }
      expect(
        h
          .child()
          .requests.filter((request) => request.method === "config/read")
          .map((request) => request.params),
      ).toEqual(Array(3).fill({ cwd: "/tmp/workspace" }));
    } finally {
      await h.engine.stop();
    }
  });

  test("an unreadable MCP configuration refuses the thread", async () => {
    const h = harness({
      "config/read": () => ({ config: { mcp_servers: "broken" } }),
      "thread/start": () => ({ thread: thread("t1") }),
    });
    try {
      await h.engine.start();
      await expect(h.engine.startThread({ config })).rejects.toThrow(
        "MCP selection could not be applied",
      );
      expect(h.child().requests.some((request) => request.method === "thread/start")).toBe(false);
    } finally {
      await h.engine.stop();
    }
  });

  test("an ordinary session reads no MCP configuration", async () => {
    const h = harness({ "thread/start": () => ({ thread: thread("t1") }) });
    try {
      await h.engine.start();
      await h.engine.startThread({ config: { ...BUILD, policy: selecting(undefined) } });
      expect(h.child().requests.some((request) => request.method === "config/read")).toBe(false);
    } finally {
      await h.engine.stop();
    }
  });
});
