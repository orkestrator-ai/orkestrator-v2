import { afterEach, describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  PromptRejectedError,
  ProviderDispatchPreparationError,
} from "../agent-provider-contract.js";
import { resolveNativeAgentExecutionPolicy } from "../native-agent-execution-policy.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { openCode2TabMcpServer } from "./permissions.js";
import { OpenCode2Provider } from "./provider.js";
import type { OpenCode2PermissionRule } from "./types.js";

let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

function setup() {
  server = new FakeOpenCode2Server();
  provider = new OpenCode2Provider(server.client(), {
    monitorEvents: false,
    mcp: { connectTimeoutMs: 50, sleep: () => Bun.sleep(1) },
  });
  return { server, provider };
}

const POLICY: NativeAgentExecutionPolicy = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "full" },
  "automated-review",
);
const BROKER = {
  url: "http://127.0.0.1:9/mcp",
  token: "broker-secret",
  workflowResultCapability: "cap-1",
};

function rulesOf(server: FakeOpenCode2Server, id: string) {
  return (server.sessions.get(id)!.rules ?? []) as OpenCode2PermissionRule[];
}

function denies(rules: readonly OpenCode2PermissionRule[], action: string) {
  return rules.some((rule) => rule.action === action && rule.effect === "deny");
}

function owner(server: FakeOpenCode2Server, id: string) {
  return (server.sessions.get(id)!.metadata?.orkestrator as { turn?: unknown } | undefined)?.turn;
}

describe("Orkestrator MCP connections", () => {
  test("a tab's connection is its session's own server, re-registered when the token rotates", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "tab");
    const name = openCode2TabMcpServer(id);
    await provider.send(id, "hi", {
      requestId: "r1",
      agentMcp: { url: "http://127.0.0.1:9/mcp", token: "t1" },
    });
    expect(server.mcp.get(name)?.config).toEqual({
      type: "remote",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer t1" },
      oauth: false,
      codemode: false,
      timeout: { startup: 5_000, catalog: 5_000 },
    });
    // Its own server is allowed for this session; every other tab's is not.
    const rules = rulesOf(server, id);
    expect(rules.at(-1)).toEqual({ action: `${name}_*`, resource: "*", effect: "allow" });
    expect(denies(rules, "orkestrator_tab_*")).toBe(true);

    const puts = () =>
      server.calls.filter((call) => call.method === "PUT" && call.path.includes("/mcp/")).length;
    server.finishRun(id);
    await provider.send(id, "again", {
      requestId: "r2",
      agentMcp: { url: "http://127.0.0.1:9/mcp", token: "t1" },
    });
    expect(puts()).toBe(1);
    server.finishRun(id);
    await provider.send(id, "rotated", {
      requestId: "r3",
      agentMcp: { url: "http://127.0.0.1:9/mcp", token: "t2" },
    });
    expect(puts()).toBe(2);
    expect((server.mcp.get(name)!.config as { headers: unknown }).headers).toEqual({
      Authorization: "Bearer t2",
    });

    // Closing the tab removes its server, so the credential stops being presented.
    await provider.closeSession(id);
    expect(server.mcp.has(name)).toBe(false);
  });

  test("a server that does not connect refuses the turn before anything is sent", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "tab");
    server.mcpAddStatus = "failed";
    const error = await provider
      .send(id, "hi", { requestId: "r1", agentMcp: { url: "http://x/mcp", token: "secret-t" } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderDispatchPreparationError);
    expect(String((error as Error).message)).not.toContain("secret-t");
    expect(server.calls.some((call) => call.path.endsWith("/prompt"))).toBe(false);
  });

  test("the user's servers are listed and toggled; Orkestrator's are not offered", async () => {
    const { server, provider } = setup();
    server.mcp.set("github", { config: {}, status: "connected" });
    server.mcp.set("docs", { config: {}, status: "disabled" });
    server.mcp.set("orkestrator_workflow_result", { config: {}, status: "connected" });
    server.mcp.set(openCode2TabMcpServer("ses_x"), { config: {}, status: "connected" });
    expect(await provider.mcpServers()).toEqual([
      { id: "github", name: "github", status: "connected", actions: ["disable"] },
      { id: "docs", name: "docs", status: "disabled", actions: ["enable", "reconnect"] },
    ]);
    await provider.mcpServerAction("ses_x", "github", "disable");
    expect(server.mcp.get("github")?.status).toBe("disabled");
    await provider.mcpServerAction("ses_x", "docs", "enable");
    expect(server.mcp.get("docs")?.status).toBe("connected");
    await expect(
      provider.mcpServerAction("ses_x", "orkestrator_workflow_result", "disable"),
    ).rejects.toThrow("managed by Orkestrator");
  });
});

describe("read-only turns", () => {
  test("are granted before the prompt and restored once the run settles", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "r", { policy: POLICY });
    await provider.send(id, "look", { requestId: "ro-1", readOnly: true });
    const promptAt = server.calls.findIndex((call) => call.path.endsWith("/prompt"));
    const grantAt = server.calls.findLastIndex(
      (call, index) => index < promptAt && call.method === "PATCH",
    );
    expect(grantAt).toBeGreaterThan(-1);
    for (const action of ["edit", "shell", "subagent", "webfetch"]) {
      expect(denies(rulesOf(server, id), action)).toBe(true);
    }
    expect(owner(server, id)).toEqual({ version: 1, requestId: "ro-1", settled: false });

    // Still running: the grant stays.
    expect(await provider.settleTurn(id, "ro-1")).toBe(false);
    server.finishRun(id);
    expect(await provider.settleTurn(id, "ro-1")).toBe(true);
    expect(denies(rulesOf(server, id), "edit")).toBe(false);
    expect(owner(server, id)).toEqual({ version: 1, requestId: "ro-1", settled: true });
    // The base policy rules are back.
    expect(rulesOf(server, id)[0]).toEqual({ action: "*", resource: "*", effect: "allow" });
  });

  test("an ordinary turn holds no grant but is not settled while its run is going", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "b");
    await provider.send(id, "work", { requestId: "plain" });
    expect(await provider.settleTurn(id, "plain")).toBe(false);
    server.finishRun(id);
    expect(await provider.settleTurn(id, "plain")).toBe(true);
    // A request the history does not hold, and no grant: nothing to wait for.
    expect(await provider.settleTurn(id, "unknown")).toBe(true);
  });

  test("an older request cannot settle a newer request's grant", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "r", { policy: POLICY });
    await provider.send(id, "one", { requestId: "old", readOnly: true });
    server.finishRun(id);
    await provider.send(id, "two", { requestId: "new", readOnly: true });
    expect(await provider.settleTurn(id, "old")).toBe(true);
    expect(owner(server, id)).toEqual({ version: 1, requestId: "new", settled: false });
    expect(denies(rulesOf(server, id), "edit")).toBe(true);
  });

  test("a grant that did not persist sends nothing and reports the request absent", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "r", { policy: POLICY });
    server.dropNextSessionUpdate = true;
    await expect(
      provider.send(id, "look", { requestId: "ro-x", readOnly: true }),
    ).rejects.toBeInstanceOf(ProviderDispatchPreparationError);
    expect(server.calls.some((call) => call.path.endsWith("/prompt"))).toBe(false);
    expect(await provider.dispatchStatus(id, "ro-x")).toBe("absent");
  });

  test("a refused prompt restores the grant at once", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "r", { policy: POLICY });
    server.failNextPrompt = { status: 400, body: { _tag: "InvalidRequestError", message: "no" } };
    await expect(
      provider.send(id, "look", { requestId: "ro-2", readOnly: true }),
    ).rejects.toBeInstanceOf(PromptRejectedError);
    expect(denies(rulesOf(server, id), "edit")).toBe(false);
    expect(owner(server, id)).toEqual({ version: 1, requestId: "ro-2", settled: true });
  });

  test("abort settles whichever turn holds the grant", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "r", { policy: POLICY });
    await provider.send(id, "look", { requestId: "ro-3", readOnly: true });
    await provider.abort(id);
    expect(denies(rulesOf(server, id), "edit")).toBe(false);
    expect(owner(server, id)).toEqual({ version: 1, requestId: "ro-3", settled: true });
  });

  test("a reviewer's constrained shell applies only to a session marked as a reviewer", async () => {
    const { server, provider } = setup();
    const reviewer = await provider.createSession("review", "r", {
      policy: POLICY,
      reviewerSession: true,
    });
    const plain = await provider.createSession("review", "p", { policy: POLICY });
    for (const id of [reviewer, plain]) {
      await provider.send(id, "look", {
        requestId: `rv-${id}`,
        readOnly: true,
        reviewShellPolicy: POLICY,
      });
    }
    const shellAllows = (id: string) =>
      rulesOf(server, id).some(
        (rule) =>
          rule.action === "shell" && rule.resource === "git status" && rule.effect === "allow",
      );
    expect(shellAllows(reviewer)).toBe(true);
    expect(shellAllows(plain)).toBe(false);
    expect(denies(rulesOf(server, plain), "shell")).toBe(true);
  });
});

describe("workflow results", () => {
  test("a result turn registers the broker and grants its own tool for the turn", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "r", { policy: POLICY });
    await provider.prepareDispatch(id, {
      agentMcp: BROKER,
      workflowResultTool: "submit_review_report",
    });
    expect(server.mcp.has("orkestrator_workflow_result")).toBe(true);
    await provider.send(id, "review it", {
      requestId: "wr-1",
      readOnly: true,
      agentMcp: BROKER,
      workflowResultTool: "submit_review_report",
    });
    const rules = rulesOf(server, id);
    const last = (action: string) => rules.findLast((rule) => rule.action === action)?.effect;
    expect(last("orkestrator_workflow_result_submit_review_report")).toBe("allow");
    expect(last("orkestrator_workflow_result_submit_fix_result")).toBe("deny");

    server.finishRun(id);
    expect(await provider.settleTurn(id, "wr-1")).toBe(true);
    const settled = rulesOf(server, id);
    expect(
      settled.findLast((rule) => rule.action.startsWith("orkestrator_workflow_result"))?.effect,
    ).toBe("deny");
    expect(
      settled.some((rule) => rule.action === "orkestrator_workflow_result_submit_review_report"),
    ).toBe(false);
  });

  test("an incomplete result configuration is refused before anything is sent", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "r");
    await expect(
      provider.send(id, "x", { requestId: "w", workflowResultTool: "submit_review_report" }),
    ).rejects.toBeInstanceOf(ProviderDispatchPreparationError);
    await expect(
      provider.send(id, "x", {
        requestId: "w2",
        agentMcp: BROKER,
        workflowResultTool: "not_a_tool",
      }),
    ).rejects.toBeInstanceOf(ProviderDispatchPreparationError);
    expect(server.calls.some((call) => call.path.endsWith("/prompt"))).toBe(false);
  });
});

describe("structured output", () => {
  test("asks for one final JSON value and reads it once the run settles", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("plan", "p");
    await provider.send(id, "plan it", { requestId: "s-1", schema: { type: "object" } });
    const prompt = server.calls.find((call) => call.path.endsWith("/prompt"))!;
    expect(String((prompt.body as { text: string }).text)).toContain("## Required OpenCode output");
    expect(await provider.structured(id, "s-1")).toBeNull();
    server.finishRun(id, "succeeded", '{"steps":2}');
    expect(await provider.structured(id, "s-1")).toEqual({
      ok: true,
      provider: "opencode",
      requestId: "s-1",
      value: { steps: 2 },
    });
  });

  test("a malformed answer and a failed run are typed failures", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("plan", "p");
    await provider.send(id, "a", { requestId: "s-2", schema: { type: "object" } });
    server.finishRun(id, "succeeded", "not json");
    expect(await provider.structured(id, "s-2")).toMatchObject({
      ok: false,
      error: { code: "malformed_output" },
    });
    await provider.send(id, "b", { requestId: "s-3", schema: { type: "object" } });
    server.finishRun(id, "failed");
    expect(await provider.structured(id, "s-3")).toMatchObject({
      ok: false,
      error: { code: "provider_error" },
    });
  });

  test("a turn cannot ask for both a result tool and structured output", async () => {
    const { provider } = setup();
    const id = await provider.createSession("plan", "p");
    await expect(
      provider.send(id, "a", {
        requestId: "s-4",
        schema: { type: "object" },
        agentMcp: BROKER,
        workflowResultTool: "submit_review_report",
      }),
    ).rejects.toBeInstanceOf(ProviderDispatchPreparationError);
  });
});

test("an auto-approved reviewer retains its current user MCP selection", async () => {
  const { server, provider } = setup();
  const policy: NativeAgentExecutionPolicy = {
    ...POLICY,
    approvals: "auto-approve",
    capabilityPolicy: { deny: [], userMcpServers: ["docs"] },
  };
  server.mcp.set("docs", { config: {}, status: "connected" });
  server.mcp.set("linear", { config: {}, status: "connected" });
  const id = await provider.createSession("review", "r", { policy, reviewerSession: true });
  server.mcp.set("extra", { config: {}, status: "connected" });
  await provider.send(id, "review", {
    requestId: "review-mcp",
    readOnly: true,
    reviewShellPolicy: policy,
  });
  const effect = (name: string) =>
    rulesOf(server, id).findLast((rule) => rule.action === name)?.effect;
  expect(effect("linear_*")).toBe("deny");
  expect(effect("extra_*")).toBe("deny");
  expect(effect("docs_*")).toBe("allow");
});

test("a reviewer refuses dispatch when its current MCP inventory cannot be validated", async () => {
  const { server, provider } = setup();
  const policy: NativeAgentExecutionPolicy = {
    ...POLICY,
    capabilityPolicy: { deny: [], userMcpServers: ["docs"] },
  };
  const id = await provider.createSession("review", "r", { policy, reviewerSession: true });
  const client = server.client();
  client.listMcpServers = async () => {
    throw new Error("unreadable inventory");
  };
  const { OpenCode2TurnGrants } = await import("./turn-grants.js");
  await expect(
    new OpenCode2TurnGrants(client).begin(id, {
      requestId: "refused",
      readOnly: true,
      reviewShellPolicy: policy,
    }),
  ).rejects.toBeInstanceOf(ProviderDispatchPreparationError);
  expect(server.calls.some((call) => call.path.endsWith("/prompt"))).toBe(false);
});
