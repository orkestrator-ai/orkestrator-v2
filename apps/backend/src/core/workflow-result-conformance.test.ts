import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeReadOnlyAllowedTools } from "../../../../bridges/claude-bridge/src/services/read-only-policy.js";
import { AgentToolsServer } from "./agent-tools.js";
import { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

/**
 * Transport conformance for the qualified tool-mode adapters.
 *
 * These exercise the real HTTP boundary and the real durable store, with no
 * model calls. They cover the behaviours an adapter has to satisfy before its
 * provider/workflow combination may be enabled: discovery before the first
 * prompt, model-visible correction, recovery of a lost response, isolation
 * between concurrent attempts, and reconnect across a backend restart.
 */

type RpcBody = {
  result?: {
    tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
};

describe("workflow result transport conformance", () => {
  let dataDir: string;
  let storage: StorageService;
  let workflowResults: WorkflowResultService;
  let server: AgentToolsServer;
  const scope = { environmentId: "env-1", projectId: "project-1" };

  async function rpc(
    url: string,
    token: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<RpcBody> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        ...(params ? { params } : {}),
      }),
    });
    const text = await response.text();
    const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
      ? (text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length) ?? "{}")
      : text;
    return JSON.parse(payload) as RpcBody;
  }

  async function slot(kind: "feature-plan-state" | "review-report" = "feature-plan-state") {
    const resultKey = crypto.randomUUID();
    await workflowResults.prepare({ resultKey, kind, ...scope, provider: "codex" });
    return {
      resultKey,
      connection: server.workflowResultConnection(
        scope.environmentId,
        scope.projectId,
        "host",
        resultKey,
      ),
    };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-workflow-conformance-"));
    storage = new StorageService(dataDir);
    workflowResults = new WorkflowResultService(dataDir);
    server = new AgentToolsServer(storage, "127.0.0.1", workflowResults);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the submission tool and its schema are available before the first prompt runs", async () => {
    const { connection } = await slot("review-report");
    const listed = await rpc(connection.url, connection.token, "tools/list");
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual([
      "submit_review_report",
      "get_workflow_result_status",
    ]);
    const submission = listed.result?.tools?.[0];
    expect(submission?.inputSchema).toMatchObject({
      type: "object",
      required: ["resultKey", "result"],
    });
  });

  test("an invalid call returns model-visible feedback and the correction is accepted once", async () => {
    const { resultKey, connection } = await slot();
    // Rejected by the published input schema before the handler runs. The
    // model still receives it as tool feedback rather than a transport failure.
    const malformed = await rpc(connection.url, connection.token, "tools/call", {
      name: "submit_feature_plan_state",
      arguments: { resultKey, result: { phase: "nope", title: "T", summary: "" } },
    });
    expect(malformed.result?.isError).toBe(true);

    // Rejected by the domain validator, which returns the correction contract.
    const invalid = await rpc(connection.url, connection.token, "tools/call", {
      name: "submit_feature_plan_state",
      arguments: { resultKey, result: { phase: "stories", title: "T", summary: "" } },
    });
    expect(invalid.result?.isError).toBe(true);
    expect(invalid.result?.structuredContent).toMatchObject({
      ok: false,
      error: { code: "invalid_result", nextAction: "correct" },
    });
    expect(await workflowResults.projection(resultKey)).toBe("correcting");

    const corrected = await rpc(connection.url, connection.token, "tools/call", {
      name: "submit_feature_plan_state",
      arguments: { resultKey, result: { phase: "collecting", title: "T", summary: "" } },
    });
    expect(corrected.result?.structuredContent).toMatchObject({ ok: true, duplicate: false });
    expect(await workflowResults.projection(resultKey)).toBe("received");
  });

  test("an accepted result is recoverable when its tool response is lost", async () => {
    const { resultKey, connection } = await slot();
    const accepted = await rpc(connection.url, connection.token, "tools/call", {
      name: "submit_feature_plan_state",
      arguments: { resultKey, result: { phase: "collecting", title: "T", summary: "" } },
    });
    const acceptedContent = accepted.result?.structuredContent as
      | { receipt: { receiptId: string } }
      | undefined;
    const receipt = acceptedContent?.receipt;
    expect(receipt?.receiptId).toEqual(expect.any(String));

    const status = await rpc(connection.url, connection.token, "tools/call", {
      name: "get_workflow_result_status",
      arguments: { resultKey },
    });
    expect(status.result?.structuredContent).toMatchObject({
      lifecycle: "accepted",
      receipt: { receiptId: receipt?.receiptId },
    });

    const replay = await rpc(connection.url, connection.token, "tools/call", {
      name: "submit_feature_plan_state",
      arguments: { resultKey, result: { phase: "collecting", title: "T", summary: "" } },
    });
    expect(replay.result?.structuredContent).toMatchObject({
      ok: true,
      duplicate: true,
      receipt: { receiptId: receipt?.receiptId },
    });
  });

  test("one attempt's capability cannot submit or read another attempt in the same server", async () => {
    const first = await slot();
    const second = await slot();

    const crossSubmit = await rpc(first.connection.url, first.connection.token, "tools/call", {
      name: "submit_feature_plan_state",
      arguments: {
        resultKey: second.resultKey,
        result: { phase: "collecting", title: "T", summary: "" },
      },
    });
    expect(crossSubmit.result?.structuredContent).toMatchObject({
      ok: false,
      error: { code: "capability_denied" },
    });

    const crossStatus = await rpc(first.connection.url, first.connection.token, "tools/call", {
      name: "get_workflow_result_status",
      arguments: { resultKey: second.resultKey },
    });
    expect(crossStatus.result?.structuredContent).toMatchObject({
      ok: false,
      error: { code: "capability_denied" },
    });
    expect(await workflowResults.projection(second.resultKey)).toBe("preparing");
  });

  test("a workflow capability carries no other agent tool a subagent could inherit", async () => {
    const { connection } = await slot();
    const listed = await rpc(connection.url, connection.token, "tools/list");
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).not.toContain("create_ticket");
    expect(names).not.toContain("send_message");
    expect(names.length).toBe(2);
  });

  test("a capability signed for another environment is not accepted", async () => {
    const { resultKey } = await slot();
    const foreign = server.workflowResultConnection("env-2", "project-1", "host", resultKey);
    const listed = await rpc(foreign.url, foreign.token, "tools/list");
    expect(listed.result?.tools).toBeUndefined();
  });

  test("the restricted review policy admits the result server and nothing else new", () => {
    const allowed = claudeReadOnlyAllowedTools({
      agentMcpServerNames: ["orkestrator-workflow-result"],
    });
    expect(allowed).toContain("mcp__orkestrator-workflow-result__*");
    expect(allowed.filter((tool) => tool.startsWith("mcp__"))).toEqual([
      "mcp__orkestrator-workflow-result__*",
    ]);
    expect(allowed).not.toContain("Write");
    expect(allowed).not.toContain("Edit");
  });

  test("a backend restart keeps the attempt URL, capability, and receipt", async () => {
    const { resultKey, connection } = await slot();
    await rpc(connection.url, connection.token, "tools/call", {
      name: "submit_feature_plan_state",
      arguments: { resultKey, result: { phase: "collecting", title: "T", summary: "" } },
    });
    await server.stop();

    const restartedResults = new WorkflowResultService(dataDir);
    server = new AgentToolsServer(storage, "127.0.0.1", restartedResults);
    await server.start();
    const renewed = server.workflowResultConnection(
      scope.environmentId,
      scope.projectId,
      "host",
      resultKey,
    );
    expect(renewed).toEqual(connection);

    const status = await rpc(renewed.url, renewed.token, "tools/call", {
      name: "get_workflow_result_status",
      arguments: { resultKey },
    });
    expect(status.result?.structuredContent).toMatchObject({ lifecycle: "accepted" });
    workflowResults = restartedResults;
  });

  test("a turn that never calls the tool reaches a closed slot rather than an open wait", async () => {
    const { resultKey } = await slot();
    await workflowResults.close(resultKey, "superseded");
    expect(await workflowResults.projection(resultKey)).toBeUndefined();
    expect(await workflowResults.status(scope, resultKey)).toMatchObject({
      lifecycle: "superseded",
      completion: "blocked",
    });
    expect(
      workflowResults.metrics.snapshot().counters[
        "missing_submissions|provider=codex|kind=feature-plan-state|reason=superseded"
      ],
    ).toBe(1);
  });

  test("a busy attempt does not block calls for unrelated attempts", async () => {
    const busy = await slot();
    const other = await slot();
    const payload = { phase: "collecting", title: "T", summary: "" };
    const [busyResult, otherResult] = await Promise.all([
      rpc(busy.connection.url, busy.connection.token, "tools/call", {
        name: "submit_feature_plan_state",
        arguments: { resultKey: busy.resultKey, result: payload },
      }),
      rpc(other.connection.url, other.connection.token, "tools/call", {
        name: "submit_feature_plan_state",
        arguments: { resultKey: other.resultKey, result: payload },
      }),
    ]);
    expect(busyResult.result?.structuredContent).toMatchObject({ ok: true });
    expect(otherResult.result?.structuredContent).toMatchObject({ ok: true });
  });
});
