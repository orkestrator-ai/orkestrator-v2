import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { ReviewIssue } from "@orkestrator/protocol/structured-review";
import { REPORT_FINDING_TOOL_NAME } from "@orkestrator/protocol/workflow-results";
import { AgentToolsServer } from "./agent-tools.js";
import { ProvisionalFindingInbox } from "./review-provisional-findings.js";
import { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

type RpcBody = {
  result?: {
    tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
};

const finding: ReviewIssue = {
  severity: "P1",
  confidence: 85,
  category: "correctness",
  title: "Clock resets on restart",
  file: "src/review.ts",
  line: 12,
  symbol: "restartStep",
  description: "Restarting a step clears the runtime the shared session still uses.",
  evidence: "restartStep deletes stepRuntimes",
  suggestion: "Keep the previous runtime",
  verification: "Restart a step and read its runtime",
};

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
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  return payload ? (JSON.parse(payload) as RpcBody) : {};
}

function reviewing(resultKey: string): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "running",
        requestId: resultKey,
        resultTransport: "tool-v1",
        providerSessionId: "session-1",
      },
    ],
    fixModel: { agent: "claude", model: "opus" },
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    backendRevision: 1,
  };
}

describe("report_finding on the Orkestrator MCP server", () => {
  let dataDir: string;
  let storage: StorageService;
  let workflowResults: WorkflowResultService;
  let server: AgentToolsServer;
  let inbox: ProvisionalFindingInbox;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-report-finding-"));
    storage = new StorageService(dataDir);
    await storage.init();
    workflowResults = new WorkflowResultService(dataDir);
    server = new AgentToolsServer(storage, "127.0.0.1", workflowResults);
    inbox = new ProvisionalFindingInbox({
      slotOpen: async (scope, resultKey) =>
        (await workflowResults.status(scope, resultKey))?.lifecycle === "open",
      wake: () => undefined,
    });
    server.setProvisionalFindingSink(inbox);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    workflowResults.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function attempt(
    kind: "review-report" | "fix-result",
    provider: "claude" | "opencode" = "claude",
  ) {
    const resultKey = crypto.randomUUID();
    await workflowResults.prepare({
      resultKey,
      kind,
      environmentId: "env-1",
      projectId: "project-1",
      provider,
    });
    return {
      resultKey,
      connection: server.workflowResultConnection(
        "env-1",
        "project-1",
        "host",
        resultKey,
        provider,
      ),
    };
  }

  const toolNames = (body: RpcBody) => body.result?.tools?.map((tool) => tool.name) ?? [];

  test("lists the tool on a live reviewer's own attempt, and only there", async () => {
    const reviewer = await attempt("review-report");
    // A review attempt the backend is not following live (a build-pipeline
    // reviewer, or one that settled) is not offered the tool.
    expect(
      toolNames(await rpc(reviewer.connection.url, reviewer.connection.token, "tools/list")),
    ).not.toContain(REPORT_FINDING_TOOL_NAME);

    inbox.track(reviewing(reviewer.resultKey));
    const listed = await rpc(reviewer.connection.url, reviewer.connection.token, "tools/list");
    expect(toolNames(listed)).toEqual([
      "validate_workflow_result",
      "submit_review_report",
      "get_workflow_result_status",
      REPORT_FINDING_TOOL_NAME,
    ]);
    const schema = listed.result?.tools?.find((tool) => tool.name === REPORT_FINDING_TOOL_NAME)
      ?.inputSchema as { required: string[]; properties: { finding: { required: string[] } } };
    expect(schema.required).toEqual(["resultKey", "finding"]);
    expect(schema.properties.finding.required).not.toContain("reviewModels");
    expect(schema.properties.finding.required).toContain("severity");

    const fix = await attempt("fix-result");
    expect(
      toolNames(await rpc(fix.connection.url, fix.connection.token, "tools/list")),
    ).not.toContain(REPORT_FINDING_TOOL_NAME);
  });

  test("records a finding for its own attempt, idempotently, and refuses another key", async () => {
    const reviewer = await attempt("review-report");
    inbox.track(reviewing(reviewer.resultKey));
    const call = (args: Record<string, unknown>) =>
      rpc(reviewer.connection.url, reviewer.connection.token, "tools/call", {
        name: REPORT_FINDING_TOOL_NAME,
        arguments: args,
      });

    const first = await call({ resultKey: reviewer.resultKey, finding });
    expect(first.result).toMatchObject({
      structuredContent: { ok: true, duplicate: false, provisionalCount: 1, limit: 50 },
    });
    const retry = await call({ resultKey: reviewer.resultKey, finding });
    expect(retry.result?.structuredContent).toMatchObject({
      ok: true,
      duplicate: true,
      findingId: first.result?.structuredContent?.findingId,
    });
    expect(inbox.take(reviewer.resultKey)).toHaveLength(1);

    const crossed = await call({ resultKey: crypto.randomUUID(), finding });
    expect(crossed.result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "invalid_finding", nextAction: "correct" } },
    });
    expect(inbox.take(reviewer.resultKey)).toHaveLength(0);

    const oversized = await call({
      resultKey: reviewer.resultKey,
      finding: { ...finding, title: "t".repeat(2_000) },
    });
    expect(oversized.result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "invalid_finding", nextAction: "correct" } },
    });
  });

  test("refuses a finished attempt", async () => {
    const reviewer = await attempt("review-report");
    inbox.track(reviewing(reviewer.resultKey));
    await workflowResults.close(reviewer.resultKey, "superseded");
    const closed = await rpc(reviewer.connection.url, reviewer.connection.token, "tools/call", {
      name: REPORT_FINDING_TOOL_NAME,
      arguments: { resultKey: reviewer.resultKey, finding },
    });
    expect(closed.result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "attempt_closed" } },
    });
  });

  test("an attempt's result tools answer only for its own result key", async () => {
    const reviewer = await attempt("review-report");
    const other = await attempt("review-report");
    const { url, token } = reviewer.connection;
    const report = {
      reviewScope: {
        targetBranch: "main",
        baseRef: "origin/main...HEAD",
        commit: null,
        filesReviewed: ["src/review.ts"],
        filesSkipped: [],
        filesLeftUncommitted: [],
        commandsRun: [],
        commandsNotRun: [],
        limitations: [],
      },
      whatChanged: {
        overview: "Change",
        before: "Before",
        after: "After",
        keyCodeChanges: [],
        userImpact: "Impact",
      },
      riskProfile: { changeTypes: ["ui"], riskAreas: [], overallRisk: "low", reasoning: "Small" },
      testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
      strengths: [],
      issues: [{ ...finding, alternativeFixes: null, reviewModels: null, reviewSourceIds: null }],
      testCoverageGaps: [],
      verdict: { ready: "with-fixes", reasoning: "One issue" },
      summaryOfChange: "Change",
      reviewSummary: "One finding",
    };
    for (const [name, args] of [
      ["validate_workflow_result", { result: report }],
      ["submit_review_report", { result: report }],
      ["submit_review_report", { validatedDigest: "a".repeat(64) }],
      ["get_workflow_result_status", {}],
    ] as const) {
      const crossed = await rpc(url, token, "tools/call", {
        name,
        arguments: { resultKey: other.resultKey, ...args },
      });
      // Correctable toward its own key, never a door into the other slot.
      expect(crossed.result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            code: "invalid_result",
            nextAction: "correct",
            message: expect.stringContaining(reviewer.resultKey),
          },
        },
      });
      expect(JSON.stringify(crossed.result)).not.toContain(other.resultKey);
    }
    // Its own key reaches its own slot.
    const own = await rpc(url, token, "tools/call", {
      name: "get_workflow_result_status",
      arguments: { resultKey: reviewer.resultKey },
    });
    expect(own.result?.structuredContent).toMatchObject({
      resultKey: reviewer.resultKey,
      lifecycle: "open",
    });
  });

  test("the OpenCode broker checks the signed capability and the attempt's kind", async () => {
    const reviewer = await attempt("review-report", "opencode");
    const other = await attempt("review-report", "opencode");
    const fix = await attempt("fix-result", "opencode");
    inbox.track(reviewing(reviewer.resultKey));
    const { url, token } = reviewer.connection;
    expect(toolNames(await rpc(url, token, "tools/list"))).toContain(REPORT_FINDING_TOOL_NAME);
    const call = (resultKey: string, capability: string | undefined) =>
      rpc(url, token, "tools/call", {
        name: REPORT_FINDING_TOOL_NAME,
        arguments: { resultKey, capability, finding },
      });

    expect(
      (await call(reviewer.resultKey, reviewer.connection.workflowResultCapability)).result
        ?.structuredContent,
    ).toMatchObject({ ok: true });
    const keyCorrection = await call(reviewer.resultKey, other.connection.workflowResultCapability);
    expect(keyCorrection.result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "invalid_finding",
          nextAction: "correct",
          message: expect.stringContaining(other.resultKey),
        },
      },
    });
    expect(JSON.stringify(keyCorrection.result)).not.toContain(reviewer.resultKey);
    expect(
      (await call(fix.resultKey, fix.connection.workflowResultCapability)).result
        ?.structuredContent,
    ).toMatchObject({ ok: false, error: { code: "capability_denied" } });
    // Signed and of the right kind, but not a reviewer the backend follows.
    expect(
      (await call(other.resultKey, other.connection.workflowResultCapability)).result
        ?.structuredContent,
    ).toMatchObject({ ok: false, error: { code: "not_accepting" } });
  });
});
