/**
 * Per-session user MCP servers on OpenCode (graphs item 404): the session's
 * permission rules leave it exactly the user servers its policy selects,
 * built from the server list the shared instance reports.
 */
import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { openCodePermissionRules } from "./opencode-provider-helpers.js";
import { OpenCodeSessionPolicy } from "./opencode-session-policy.js";
import { openCodeConfiguredMcpServersFor, openCodeUserMcpRules } from "./opencode-user-mcp.js";

type Rule = { permission: string; pattern: string; action: string };

// OpenCode's documented evaluation: simple globs, the last matching rule wins.
function actionFor(rules: readonly Rule[], permission: string) {
  const glob = (candidate: string, value: string) =>
    new RegExp(
      `^${candidate
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".")}$`,
      "s",
    ).test(value);
  return rules.findLast((rule) => glob(rule.permission, permission) && glob(rule.pattern, "*"))
    ?.action;
}

function policy(
  userMcpServers: string[] | undefined,
  options: {
    deny?: string[];
    approvals?: NativeAgentExecutionPolicy["approvals"];
    toolDeny?: string[];
  } = {},
): NativeAgentExecutionPolicy {
  return {
    id: "pipeline",
    sandbox: "none",
    approvals: options.approvals ?? "auto-approve",
    projectResources: true,
    networkAccess: "full",
    ...(options.toolDeny ? { toolPolicy: { deny: options.toolDeny } } : {}),
    capabilityPolicy: {
      deny: (options.deny ?? []) as never,
      ...(userMcpServers ? { userMcpServers } : {}),
    },
  };
}

const LISTED = [
  "docs",
  "docs_v2",
  "linear",
  "my.notes",
  "orkestrator",
  "orkestrator_workflow_result",
];

describe("openCodeUserMcpRules", () => {
  test("a granted server keeps its tools and an ungranted one loses them", () => {
    const rules = openCodePermissionRules(policy(["docs_v2"]), { configuredMcpServers: LISTED });
    expect(actionFor(rules, "docs_v2_search")).toBe("allow");
    expect(actionFor(rules, "docs_search")).toBe("deny");
    expect(actionFor(rules, "linear_create_issue")).toBe("deny");
    expect(actionFor(rules, "my_notes_read")).toBe("deny");
    // Orkestrator's own servers and built-in tools are untouched.
    expect(actionFor(rules, "orkestrator_send_message")).toBe("allow");
    expect(actionFor(rules, "orkestrator_workflow_result_submit_review")).toBe("allow");
    expect(actionFor(rules, "read")).toBe("allow");
  });

  test("no grant takes every user server's tools; a denial wins over a grant", () => {
    for (const selecting of [policy([]), policy(["linear"], { deny: ["mcp:linear"] })]) {
      const rules = openCodePermissionRules(selecting, { configuredMcpServers: LISTED });
      for (const tool of ["docs_search", "docs_v2_search", "linear_create_issue"]) {
        expect(actionFor(rules, tool)).toBe("deny");
      }
    }
  });

  test("an asking policy keeps asking for granted tools; a denying one approves them", () => {
    const asking = openCodePermissionRules(policy(["linear"], { approvals: "ask" }), {
      configuredMcpServers: LISTED,
    });
    expect(actionFor(asking, "linear_create_issue")).toBe("ask");
    const denying = openCodePermissionRules(policy(["linear"], { approvals: "deny" }), {
      configuredMcpServers: LISTED,
    });
    expect(actionFor(denying, "linear_create_issue")).toBe("allow");
    expect(actionFor(denying, "bash")).toBe("deny");
  });

  test("a tool the user denied by name stays denied under a granted prefix", () => {
    const rules = openCodePermissionRules(policy(["linear"], { toolDeny: ["linear_delete"] }), {
      configuredMcpServers: LISTED,
    });
    expect(actionFor(rules, "linear_delete")).toBe("deny");
    expect(actionFor(rules, "linear_create_issue")).toBe("allow");
  });

  test("a policy that narrows nothing adds no rule", () => {
    expect(openCodeUserMcpRules(policy(undefined), LISTED)).toEqual([]);
  });
});

function fakeClient(statuses: () => unknown) {
  const updates: Rule[][] = [];
  let statusCalls = 0;
  const client = {
    mcp: {
      status: async () => {
        statusCalls += 1;
        const data = statuses();
        if (data instanceof Error) throw data;
        return { data, error: undefined, response: new Response() };
      },
    },
    session: {
      update: async (input: { permission: Rule[] }) => {
        updates.push(input.permission);
        return { data: {}, error: undefined, response: new Response() };
      },
    },
  } as unknown as OpencodeClient;
  return { client, updates, statusCalls: () => statusCalls };
}

const requestOptions = () => ({ signal: new AbortController().signal });

describe("OpenCodeSessionPolicy with a user MCP selection", () => {
  test("re-applies the rules when the instance lists a new server", async () => {
    let listed: Record<string, unknown> = { docs: {}, orkestrator: {} };
    const fake = fakeClient(() => listed);
    const sessions = new OpenCodeSessionPolicy(
      fake.client,
      new Map(),
      requestOptions,
      () => [],
      undefined,
      "/tmp/w",
    );
    const selecting = policy(["docs"]);
    await sessions.apply("s1", selecting);
    expect(fake.updates).toHaveLength(1);
    expect(actionFor(fake.updates[0]!, "docs_search")).toBe("allow");

    // Unchanged list and policy: nothing to append.
    await sessions.synchronize("s1", selecting);
    expect(fake.updates).toHaveLength(1);

    listed = { ...listed, linear: {} };
    await sessions.synchronize("s1", selecting);
    expect(fake.updates).toHaveLength(2);
    expect(actionFor(fake.updates[1]!, "linear_create_issue")).toBe("deny");
  });

  test("an unreadable server list refuses the session", async () => {
    const fake = fakeClient(() => new Error("instance down"));
    const sessions = new OpenCodeSessionPolicy(fake.client, new Map(), requestOptions, () => []);
    await expect(sessions.apply("s1", policy([]))).rejects.toThrow();
    expect(fake.updates).toEqual([]);
    await expect(
      openCodeConfiguredMcpServersFor(
        policy([]),
        fakeClient(() => null).client,
        undefined,
        requestOptions,
      ),
    ).rejects.toThrow("could not be applied");
  });

  test("an ordinary session never reads the server list", async () => {
    const fake = fakeClient(() => ({ docs: {} }));
    const sessions = new OpenCodeSessionPolicy(fake.client, new Map(), requestOptions, () => []);
    await sessions.apply("s1", policy(undefined));
    expect(fake.statusCalls()).toBe(0);
    expect(fake.updates).toHaveLength(1);
  });
});
