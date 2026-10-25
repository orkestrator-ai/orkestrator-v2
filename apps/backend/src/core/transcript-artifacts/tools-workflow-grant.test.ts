/**
 * The artifact-only server a backend workflow turn (Multi Review reviewer,
 * build-pipeline stage, feature planning) gets beside its restricted
 * workflow-result server: `/artifact-mcp`, authenticated only by the turn's
 * artifact grant, owned by the workflow session's own conversation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ARTIFACT_TOOL_NAMES,
  ORKESTRATOR_ARTIFACT_MCP_PATH,
} from "@orkestrator/protocol/transcript-artifacts";
import { AgentToolsServer } from "../agent-tools.js";
import { WorkflowResultService } from "../workflow-result-service.js";
import { WorkflowTranscriptArtifacts } from "../workflow-transcript-artifacts.js";
import {
  ENV,
  PROJECT,
  SAMPLE_CHART,
  createHarness,
  key,
  type Harness,
} from "./service-test-support.js";

const REVIEWER_CONVERSATION = "multi-review:workflow-1:reviewer:reviewer-1";
const OTHER_CONVERSATION = "multi-review:workflow-1:reviewer:reviewer-2";

let h: Harness;
let server: AgentToolsServer;
let workflowResults: WorkflowResultService;

beforeEach(async () => {
  h = await createHarness();
  workflowResults = new WorkflowResultService(h.dataDir);
  server = new AgentToolsServer(h.storage, "127.0.0.1", workflowResults);
  server.setTranscriptArtifactToolHost(h.service);
  await server.start();
});

afterEach(async () => {
  await server.stop();
  workflowResults.closeStorage();
  await h.close();
});

/** POSTs one JSON-RPC request; answers the status and the decoded body. */
async function rpc(
  path: string,
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${server.listeningPort()}${path}`, {
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
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  return { status: response.status, body: payload ? JSON.parse(payload) : {} };
}

async function tool(
  token: string,
  name: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): Promise<Record<string, any>> {
  const { status, body } = await rpc(ORKESTRATOR_ARTIFACT_MCP_PATH, token, "tools/call", {
    name,
    arguments: args,
    ...(toolCallId ? { _meta: { toolCallId } } : {}),
  });
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  return body.result.structuredContent as Record<string, any>;
}

function reviewerGrant(conversationKey = REVIEWER_CONVERSATION, turnId = "turn-1") {
  return h.service.mintArtifactGrant({
    environmentId: ENV,
    projectId: PROJECT,
    conversationKey,
    turnId,
    providerSessionId: "provider-session-1",
  }).grant;
}

describe("a workflow turn's artifact-only server", () => {
  test("lists only the artifact tools and publishes into the turn's own conversation", async () => {
    const grant = reviewerGrant();
    const listed = await rpc(ORKESTRATOR_ARTIFACT_MCP_PATH, grant, "tools/list");
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.map((entry: { name: string }) => entry.name).sort()).toEqual(
      [...ARTIFACT_TOOL_NAMES].sort(),
    );

    // The model names another conversation; the connection's grant decides.
    const foreign = reviewerGrant(OTHER_CONVERSATION, "turn-foreign");
    const created = await tool(grant, "create_artifact", {
      requestKey: key(),
      draft: { title: "Findings", summary: "s", payload: { kind: "chart", spec: SAMPLE_CHART } },
      scopeCapability: foreign,
    });
    expect(created.ok).toBe(true);
    const preview = await tool(grant, "preview_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      revision: 1,
    });
    await h.service.drain();
    const operation = await tool(grant, "get_artifact_operation", {
      operationId: preview.operationId,
    });
    expect(operation.operation.status).toBe("succeeded");
    const published = await tool(
      grant,
      "publish_artifact",
      {
        requestKey: key(),
        artifactId: created.artifactId,
        expectedRevision: 1,
        receiptId: operation.operation.receiptId,
      },
      "toolu_reviewer_publish",
    );
    expect(published.ok).toBe(true);

    const own = h.service.listPublications({
      environmentId: ENV,
      logicalSessionKey: REVIEWER_CONVERSATION,
    }).publications;
    expect(own.map((entry) => entry.ref.publicationId)).toEqual([published.publicationId]);
    // Attributed to the dispatched turn the grant names, and to the call.
    expect(own[0]!.anchor).toEqual({ turnId: "turn-1", toolCallId: "toolu_reviewer_publish" });
    expect(
      h.service.listPublications({ environmentId: ENV, logicalSessionKey: OTHER_CONVERSATION })
        .publications,
    ).toEqual([]);

    // The reviewer transcript read places it beside the call that published it.
    const placement = new WorkflowTranscriptArtifacts(() => h.service);
    const rows = [
      { id: "row-1", role: "assistant", parts: [{ type: "text", content: "Reviewing" }] },
      {
        id: "row-2",
        role: "assistant",
        parts: [
          {
            type: "tool-invocation",
            toolName: "mcp__orkestrator-artifacts__publish_artifact",
            toolUseId: "toolu_reviewer_publish",
            toolState: "success",
            toolArgs: { artifactId: created.artifactId, expectedRevision: 1 },
          },
        ],
      },
    ];
    const placed = placement.place(ENV, REVIEWER_CONVERSATION, rows) as typeof rows;
    expect(placed[0]).toBe(rows[0]!);
    expect(placed[1]!.parts.map((part) => part.type)).toEqual(["tool-invocation", "artifact"]);
    expect(placement.place(ENV, OTHER_CONVERSATION, rows)).toBe(rows);
    expect(placement.place("env-other", REVIEWER_CONVERSATION, rows)).toBe(rows);
  });

  test("refuses everything but a live grant, and a grant anywhere else", async () => {
    const grant = reviewerGrant();
    // A workflow-result capability carries no artifact authority here.
    const resultKey = crypto.randomUUID();
    await workflowResults.prepare({
      resultKey,
      kind: "review-report",
      environmentId: ENV,
      projectId: PROJECT,
      provider: "claude",
    });
    const result = server.workflowResultConnection(ENV, PROJECT, "host", resultKey);
    expect((await rpc(ORKESTRATOR_ARTIFACT_MCP_PATH, result.token, "tools/list")).status).toBe(401);
    // An ordinary tab credential is not a grant either.
    const tab = server.connection(ENV, PROJECT, "host", "tab-1");
    expect((await rpc(ORKESTRATOR_ARTIFACT_MCP_PATH, tab.token, "tools/list")).status).toBe(401);
    // A grant opens nothing on the general server.
    expect((await rpc("/mcp", grant, "tools/list")).status).toBe(401);
    expect(
      (await rpc(ORKESTRATOR_ARTIFACT_MCP_PATH, "oag1.forged.value", "tools/list")).status,
    ).toBe(401);

    // Turn settlement revokes it.
    expect((await rpc(ORKESTRATOR_ARTIFACT_MCP_PATH, grant, "tools/list")).status).toBe(200);
    h.service.revokeArtifactGrantsForTurn(ENV, "turn-1");
    expect((await rpc(ORKESTRATOR_ARTIFACT_MCP_PATH, grant, "tools/list")).status).toBe(401);
  });

  test("is not served while artifact publication is rolled back", async () => {
    const grant = reviewerGrant();
    h.flags.artifactPublication = false;
    expect((await rpc(ORKESTRATOR_ARTIFACT_MCP_PATH, grant, "tools/list")).status).toBe(404);
  });
});
