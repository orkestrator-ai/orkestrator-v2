/**
 * Artifact grants, the design connection and worker mail on 2.x turns
 * (`turn-connections.ts`, `mcp.ts`), against the fake 2.x server.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { resolveNativeAgentExecutionPolicy } from "../native-agent-execution-policy.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import {
  OPENCODE2_ARTIFACTS_MCP_PREFIX,
  OPENCODE2_DESIGN_MCP_PREFIX,
  openCode2SessionMcpServer,
  openCode2TabMcpServer,
} from "./permissions.js";
import { OpenCode2Provider } from "./provider.js";
import type { OpenCode2WorkerMailbox } from "./turn-connections.js";
import type { OpenCode2PermissionRule } from "./types.js";

let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

function setup(workerMailbox?: OpenCode2WorkerMailbox) {
  server = new FakeOpenCode2Server();
  provider = new OpenCode2Provider(server.client(), {
    monitorEvents: false,
    mcp: { connectTimeoutMs: 50, sleep: () => Bun.sleep(1) },
    ...(workerMailbox ? { workerMailbox } : {}),
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
const WORKER_MAIL = {
  environmentId: "env",
  tabId: "pipeline-worker:stage-1",
  capability: "wm.worker-capability",
};

const design = (id: string) => openCode2SessionMcpServer(OPENCODE2_DESIGN_MCP_PREFIX, id);
const artifacts = (id: string) => openCode2SessionMcpServer(OPENCODE2_ARTIFACTS_MCP_PREFIX, id);

function config(server: FakeOpenCode2Server, name: string) {
  return server.mcp.get(name)?.config as
    { url: string; headers: Record<string, string> } | undefined;
}

/** The rule OpenCode applies to a tool: the last whose glob matches. */
function effect(rules: readonly OpenCode2PermissionRule[], tool: string) {
  const match = (input: string, pattern: string) =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(
      input,
    );
  return rules.findLast((rule) => match(tool, rule.action))?.effect ?? "ask";
}

function rulesOf(server: FakeOpenCode2Server, id: string) {
  return (server.sessions.get(id)!.rules ?? []) as OpenCode2PermissionRule[];
}

function promptText(server: FakeOpenCode2Server): string {
  return server.calls
    .filter((call) => call.path.endsWith("/prompt"))
    .map((call) => JSON.stringify(call.body))
    .join("\n");
}

describe("artifact grants", () => {
  test("a result turn gets its grant as the session's own artifact-only server", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "r", { policy: POLICY });
    await provider.send(id, "review it", {
      requestId: "wr-1",
      readOnly: true,
      agentMcp: BROKER,
      workflowResultTool: "submit_review_report",
      artifactGrant: "grant-secret-1",
    });
    expect(config(server, artifacts(id))).toMatchObject({
      url: "http://127.0.0.1:9/artifact-mcp",
      headers: { Authorization: "Bearer grant-secret-1" },
    });
    // Never in the prompt or its metadata, unlike 1.x's system text.
    expect(promptText(server)).not.toContain("grant-secret-1");
    // Its tools are this session's; another session's rules refuse them.
    const other = await provider.createSession("review", "o", { policy: POLICY });
    expect(effect(rulesOf(server, id), `${artifacts(id)}_create_artifact`)).toBe("allow");
    expect(effect(rulesOf(server, other), `${artifacts(id)}_create_artifact`)).toBe("deny");
    // The result turn itself still submits through its own tool only.
    expect(effect(rulesOf(server, id), "orkestrator_workflow_result_submit_review_report")).toBe(
      "allow",
    );

    // The next turn's grant replaces it; a turn without one drops it.
    server.finishRun(id);
    await provider.settleTurn(id, "wr-1");
    await provider.send(id, "again", {
      requestId: "wr-2",
      agentMcp: BROKER,
      workflowResultTool: "submit_review_report",
      artifactGrant: "grant-secret-2",
    });
    expect(config(server, artifacts(id))?.headers).toEqual({
      Authorization: "Bearer grant-secret-2",
    });
    server.finishRun(id);
    await provider.settleTurn(id, "wr-2");
    await provider.send(id, "plain", { requestId: "p-1" });
    expect(server.mcp.has(artifacts(id))).toBe(false);
  });

  test("a subork's result turn keeps the artifact server out of reach, as on 1.x", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "subork", {
      policy: POLICY,
      reviewerSession: true,
    });
    await provider.send(id, "answer", {
      requestId: "sub-1",
      readOnly: true,
      reviewShellPolicy: POLICY,
      agentMcp: BROKER,
      workflowResultTool: "submit_subork_answer",
      artifactGrant: "grant-sub",
    });
    const rules = rulesOf(server, id);
    expect(effect(rules, `${artifacts(id)}_create_artifact`)).toBe("deny");
    expect(effect(rules, `${openCode2TabMcpServer(id)}_send_message`)).toBe("deny");
    expect(effect(rules, "orkestrator_workflow_result_submit_subork_answer")).toBe("allow");
  });

  test("a tab's own connection carries artifact authority; its grant is not registered", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "tab");
    await provider.send(id, "hi", {
      requestId: "t-1",
      agentMcp: { url: "http://127.0.0.1:9/mcp", token: "tab-token" },
      artifactGrant: "grant-tab",
      tabMail: { environmentId: "env", tabId: "tab-1" },
    });
    expect(server.mcp.has(openCode2TabMcpServer(id))).toBe(true);
    expect(server.mcp.has(artifacts(id))).toBe(false);
    expect(promptText(server)).not.toContain("grant-tab");
  });
});

describe("the design connection", () => {
  test("a tab connection with design gets its own design server with the same credential", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("build", "tab");
    const other = await provider.createSession("build", "other");
    await provider.send(id, "draw", {
      requestId: "d-1",
      agentMcp: { url: "http://127.0.0.1:9/mcp", token: "tab-token", design: true },
    });
    expect(config(server, design(id))).toMatchObject({
      url: "http://127.0.0.1:9/design-mcp",
      headers: { Authorization: "Bearer tab-token" },
    });
    expect(effect(rulesOf(server, id), `${design(id)}_create_canvas`)).toBe("allow");
    expect(effect(rulesOf(server, other), `${design(id)}_create_canvas`)).toBe("deny");

    // Gone once the environment has no canvases any more, and on close.
    server.finishRun(id);
    await provider.send(id, "again", {
      requestId: "d-2",
      agentMcp: { url: "http://127.0.0.1:9/mcp", token: "tab-token" },
    });
    expect(server.mcp.has(design(id))).toBe(false);
    server.finishRun(id);
    await provider.send(id, "draw again", {
      requestId: "d-3",
      agentMcp: { url: "http://127.0.0.1:9/mcp", token: "tab-token", design: true },
    });
    expect(server.mcp.has(design(id))).toBe(true);
    await provider.closeSession(id);
    expect(server.mcp.has(design(id))).toBe(false);
    expect(server.mcp.has(openCode2TabMcpServer(id))).toBe(false);
  });

  test("a workflow-result connection never gets one", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("review", "r", { policy: POLICY });
    await provider.send(id, "review", {
      requestId: "d-4",
      agentMcp: { ...BROKER, design: true },
      workflowResultTool: "submit_review_report",
    });
    expect(server.mcp.has(design(id))).toBe(false);
  });
});

describe("worker mail", () => {
  test("a worker turn connects as its own mailbox; the capability never reaches OpenCode", async () => {
    const asked: unknown[] = [];
    const { server, provider } = setup(async (mail) => {
      asked.push(mail);
      return { url: "http://127.0.0.1:9/mcp", token: "worker-token" };
    });
    const id = await provider.createSession("build", "stage");
    await provider.send(id, "implement", {
      requestId: "w-1",
      workerMail: WORKER_MAIL,
      artifactGrant: "grant-w",
    });
    expect(asked).toEqual([WORKER_MAIL]);
    expect(config(server, openCode2TabMcpServer(id))?.headers).toEqual({
      Authorization: "Bearer worker-token",
    });
    // The worker connection carries artifacts itself, as a bridge worker's does.
    expect(server.mcp.has(artifacts(id))).toBe(false);
    const sent = promptText(server) + JSON.stringify([...server.mcp.values()]);
    expect(sent).not.toContain("wm.worker-capability");
    expect(sent).not.toContain("grant-w");
  });

  test("without a mailbox the turn still runs, with no Orkestrator connection", async () => {
    const { server, provider } = setup(async () => undefined);
    const id = await provider.createSession("build", "stage");
    await provider.send(id, "implement", { requestId: "w-2", workerMail: WORKER_MAIL });
    expect(server.mcp.size).toBe(0);
    expect(server.calls.some((call) => call.path.endsWith("/prompt"))).toBe(true);
  });
});
