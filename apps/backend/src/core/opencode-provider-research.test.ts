import { describe, expect, test } from "bun:test";
import { OpenCodeProvider } from "./opencode-provider.js";
import { openCodeFake, waitUntil } from "./agent-provider-test-support.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";

const policy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "restricted" },
  "coordinator",
  undefined,
  "search-and-mcp",
);

function harness() {
  const fake = openCodeFake();
  let tools: readonly string[] = ["context7_query-docs"];
  let valid = true;
  let fail = false;
  let registrations = 0;
  const provider = new OpenCodeProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "fixture",
      directory: "/workspace",
    },
    {
      openCodeClient: fake.client,
      autoAnswerRequests: true,
      coordinatorResearchToolIds: () => tools,
      invalidateCoordinatorResearch: () => {
        tools = [];
        valid = false;
      },
      ensureCoordinatorResearch: async () => {
        if (valid) return;
        if (fail) throw new Error("trusted research endpoint unavailable");
        registrations += 1;
        tools = ["context7_query-docs"];
        valid = true;
      },
    },
  );
  return {
    fake,
    provider,
    registrations: () => registrations,
    invalidated: () => !valid,
    setTools(value: readonly string[]) {
      tools = value;
    },
    fail() {
      fail = true;
    },
  };
}

function action(permission: unknown, tool: string) {
  return (permission as { permission: string; action: string }[]).findLast(
    (rule) => rule.permission === "*" || rule.permission === tool,
  )?.action;
}

describe("OpenCode coordinator research lifecycle", () => {
  test("synchronizes research tool changes even with an identical execution policy", async () => {
    const h = harness();
    try {
      await h.provider.synchronizeSessionPolicy("owned-session", policy);
      await h.provider.synchronizeSessionPolicy("owned-session", structuredClone(policy));
      expect(h.fake.updateCalls).toHaveLength(1);
      h.setTools([]);
      await h.provider.synchronizeSessionPolicy("owned-session", policy);
      expect(h.fake.updateCalls).toHaveLength(2);
      expect(action(h.fake.updateCalls[1]!.permission, "context7_query-docs")).toBe("deny");
      h.setTools(["context7_other"]);
      await h.provider.synchronizeSessionPolicy("owned-session", policy);
      expect(action(h.fake.updateCalls[2]!.permission, "context7_other")).toBe("allow");
      expect(action(h.fake.updateCalls[2]!.permission, "context7_query-docs")).toBe("deny");
    } finally {
      await h.provider.dispose();
    }
  });

  test("reload restores trusted registration and re-applies exact permissions before dispatch", async () => {
    const h = harness();
    try {
      await h.provider.createSession("coordinator", "Research", { policy });
      await expect(h.provider.refreshCommands()).resolves.toMatchObject({
        outcome: "reloaded",
      });
      await h.provider.send("owned-session", "Inspect", { requestId: "after-reload" });
      expect(h.registrations()).toBe(1);
      expect(
        action(
          h.fake.updateCalls.findLast((call) => call.permission !== undefined)!.permission,
          "context7_query-docs",
        ),
      ).toBe("allow");
      expect(
        action(
          h.fake.updateCalls.findLast((call) => call.permission !== undefined)!.permission,
          "context7_x_query-docs",
        ),
      ).toBe("deny");
      expect(h.fake.promptCalls).toHaveLength(1);
    } finally {
      await h.provider.dispose();
    }
  });

  test("an ambiguous disposal failure revokes research authority before any later dispatch", async () => {
    const h = harness();
    try {
      await h.provider.createSession("coordinator", "Research", { policy });
      h.fake.setInstanceDisposeHandler(async () => {
        throw new Error("disposal response lost");
      });
      // The command refresh reports its own stale catalogue; research must still be invalidated.
      await h.provider.refreshCommands();
      expect(h.invalidated()).toBe(true);
      h.fail();
      await expect(
        h.provider.send("owned-session", "Inspect", { requestId: "ambiguous-dispose" }),
      ).rejects.toThrow("trusted research endpoint unavailable");
      expect(h.fake.promptCalls).toHaveLength(0);
    } finally {
      await h.provider.dispose();
    }
  });

  test("a disposal event invalidates registration and a failed restoration blocks dispatch", async () => {
    const h = harness();
    try {
      await h.provider.createSession("coordinator", "Research", { policy });
      await waitUntil(() => h.fake.subscriptions.length > 0);
      h.fake.subscriptions[0]!.push({ type: "server.instance.disposed", properties: {} });
      await waitUntil(() => h.invalidated());
      h.fail();
      await expect(
        h.provider.send("owned-session", "Inspect", { requestId: "failed-restore" }),
      ).rejects.toThrow("trusted research endpoint unavailable");
      expect(h.fake.promptCalls).toHaveLength(0);
    } finally {
      await h.provider.dispose();
    }
  });
});
