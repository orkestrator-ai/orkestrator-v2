import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WEB_ANNOTATION_CONFLICT,
  isWebAnnotationRequestActive,
  type WebAnnotationRequest,
  type WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureAnnotation,
  fixtureCapture,
  fixtureEntry,
  fixtureRequest,
} from "@orkestrator/protocol/web-annotations-fixtures";
import type { WebAnnotationResultReportInput } from "@orkestrator/protocol/web-annotations-validation";
import { AgentToolsServer } from "./agent-tools.js";
import { StorageService } from "./storage.js";
import type { WebAnnotationToolHost, WebAnnotationToolScope } from "./web-annotation-contracts.js";
import {
  WEB_ANNOTATION_TOOL_NAMES,
  WebAnnotationToolLimiter,
  registerWebAnnotationTools,
} from "./web-annotation-tools.js";

type Handler = (input: Record<string, unknown>) => Promise<{
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}>;

const ENV = "env-fixture";
const SCOPE: WebAnnotationToolScope = { environmentId: ENV, tabId: "tab-agent-1" };

class FakeHost implements WebAnnotationToolHost {
  assignments = new Map<
    string,
    { request: WebAnnotationRequest; brief: string; latestResult?: WebAnnotationResult | null }
  >();
  evidenceCalls: string[] = [];
  reports: WebAnnotationResultReportInput[] = [];
  revision = 0;
  hang = false;
  lastResult: WebAnnotationResult | null = null;

  assign(request: WebAnnotationRequest, tabId = request.destination.tabId) {
    this.assignments.set(`${request.environmentId}\0${tabId}`, {
      request,
      brief: "Orkestrator web annotation request ...",
    });
  }

  async assignedRequest(scope: WebAnnotationToolScope) {
    if (this.hang) await new Promise(() => undefined);
    return this.assignments.get(`${scope.environmentId}\0${scope.tabId}`) ?? null;
  }

  async evidence(_scope: WebAnnotationToolScope, requestId: string, annotationId: string) {
    this.evidenceCalls.push(`${requestId}/${annotationId}`);
    return {
      annotation: fixtureAnnotation({ id: annotationId }),
      capture: fixtureCapture("element", { annotationId }),
      entries: [fixtureEntry({ annotationId, body: "b".repeat(8_000) })],
    };
  }

  async reportResult(
    scope: WebAnnotationToolScope,
    report: WebAnnotationResultReportInput,
  ): Promise<WebAnnotationResult> {
    const assignment = await this.assignedRequest(scope);
    if ((report.expectedResultRevision ?? 0) !== this.revision) {
      throw new Error(`${WEB_ANNOTATION_CONFLICT} result revision is ${this.revision}`);
    }
    this.reports.push(report);
    this.revision += 1;
    return (this.lastResult = {
      id: `result-${report.requestId}`,
      requestId: report.requestId,
      bodyHash: assignment!.request.bodyHash,
      revision: this.revision,
      provenance: "agent-reported",
      provisional: isWebAnnotationRequestActive(assignment!.request.state),
      outcomes: report.outcomes,
      summary: report.summary,
      files: report.files,
      checks: report.checks.map((check) => ({ ...check, provenance: "agent-reported" as const })),
      evidenceAssetIds: [],
      captureIds: [],
      limitations: report.limitations,
      questions: report.questions,
      supersedes: null,
      createdAt: new Date(0).toISOString(),
    });
  }
}

function register(
  host: WebAnnotationToolHost,
  scope = SCOPE,
  limiter = new WebAnnotationToolLimiter(),
) {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  registerWebAnnotationTools(server as never, host, scope, limiter);
  return handlers;
}

function running(overrides: Partial<WebAnnotationRequest> = {}) {
  return fixtureRequest("running", { id: "req-1", ...overrides });
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    expectedResultRevision: null,
    summary: "Increased padding.",
    outcomes: [{ annotationId: "annotation-1", outcome: "addressed", note: null }],
    files: ["src/settings.tsx"],
    checks: [{ description: "bun test", outcome: "passed" }],
    limitations: [],
    questions: [],
    ...overrides,
  };
}

describe("web annotation agent tools", () => {
  test("registers only read/report tools; nothing can resolve or dispatch", () => {
    const handlers = register(new FakeHost());
    expect([...handlers.keys()]).toEqual([...WEB_ANNOTATION_TOOL_NAMES]);
  });

  test("the assigned request comes from backend state, not from the caller", async () => {
    const host = new FakeHost();
    host.assign(running());
    const handlers = register(host);
    const result = await handlers.get("get_annotation_request")!({});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      request: { requestId: "req-1", operation: "implement", state: "running" },
      active: true,
    });

    const otherTab = register(host, { environmentId: ENV, tabId: "tab-2" });
    const none = await otherTab.get("get_annotation_request")!({});
    expect(none.isError).toBe(true);
    expect(none.structuredContent).toMatchObject({ error: { code: "no-assigned-request" } });
  });

  test("a host binding for another tab is refused rather than widened", async () => {
    const host = new FakeHost();
    host.assign(running(), "tab-2");
    const handlers = register(host, { environmentId: ENV, tabId: "tab-2" });
    const result = await handlers.get("get_annotation_request")!({});
    expect(result.structuredContent).toMatchObject({ error: { code: "request-not-assigned" } });
  });

  test("forged request ids and another session's annotations are refused", async () => {
    const host = new FakeHost();
    host.assign(running());
    const handlers = register(host);
    const forged = await handlers.get("get_annotation_evidence")!({
      requestId: "req-other",
      annotationId: "annotation-1",
    });
    expect(forged.structuredContent).toMatchObject({ error: { code: "request-not-assigned" } });
    const foreign = await handlers.get("get_annotation_evidence")!({
      requestId: "req-1",
      annotationId: "annotation-9",
    });
    expect(foreign.structuredContent).toMatchObject({
      error: { code: "annotation-not-in-request" },
    });
    expect(host.evidenceCalls).toEqual([]);

    const allowed = await handlers.get("get_annotation_evidence")!({
      requestId: "req-1",
      annotationId: "annotation-1",
    });
    expect(allowed.structuredContent).toMatchObject({
      ok: true,
      annotation: { id: "annotation-1" },
      truncated: false,
    });
    expect(host.evidenceCalls).toEqual(["req-1/annotation-1"]);

    const forgedReport = await handlers.get("report_annotation_result")!(
      report({ requestId: "req-other" }),
    );
    expect(forgedReport.structuredContent).toMatchObject({
      error: { code: "request-not-assigned" },
    });
    const foreignOutcome = await handlers.get("report_annotation_result")!(
      report({ outcomes: [{ annotationId: "annotation-9", outcome: "addressed", note: null }] }),
    );
    expect(foreignOutcome.structuredContent).toMatchObject({
      error: { code: "annotation-not-in-request" },
    });
    expect(host.reports).toEqual([]);
  });

  test("a report while the turn is active is provisional and agent-reported", async () => {
    const host = new FakeHost();
    host.assign(running());
    const handlers = register(host);
    const result = await handlers.get("report_annotation_result")!(report());
    expect(result.structuredContent).toEqual({
      ok: true,
      result: {
        resultId: "result-req-1",
        requestId: "req-1",
        revision: 1,
        provisional: true,
        provenance: "agent-reported",
        fileChecks: [],
      },
    });
  });

  test("the request read returns the current result revision and citable evidence ids", async () => {
    const host = new FakeHost();
    const request = running({
      attachments: [
        {
          assetId: "asset-1",
          digest: "sha256:ab",
          bytes: 3,
          relativePath: ".orkestrator/annotations/ab.png",
        },
      ],
    });
    host.assign(request);
    const handlers = register(host);
    const before = await handlers.get("get_annotation_request")!({});
    expect(before.structuredContent).toMatchObject({ request: { result: null, resultCount: 0 } });

    const reported = await handlers.get("report_annotation_result")!(
      report({ evidenceIds: ["capture-element", "asset-1"] }),
    );
    expect(reported.structuredContent).toMatchObject({ ok: true, result: { revision: 1 } });
    expect(host.reports[0]?.evidenceIds).toEqual(["capture-element", "asset-1"]);

    const latest = host.lastResult!;
    host.assignments.set(`${ENV}\0${request.destination.tabId}`, {
      request: { ...request, resultIds: [latest.id] },
      brief: "Orkestrator web annotation request ...",
      latestResult: latest,
    });
    const after = await handlers.get("get_annotation_request")!({});
    expect(after.structuredContent).toMatchObject({
      request: {
        resultCount: 1,
        result: {
          resultId: latest.id,
          revision: 1,
          provenance: "agent-reported",
          summary: "Increased padding.",
        },
        evidenceIds: {
          captures: [{ annotationId: "annotation-1", captureId: "capture-element" }],
          attachments: [{ assetId: "asset-1", digest: "sha256:ab" }],
        },
      },
    });

    const invalid = await handlers.get("report_annotation_result")!(
      report({ expectedResultRevision: 1, evidenceIds: ["../etc/passwd"] }),
    );
    expect(invalid.isError).toBe(true);
  });

  test("duplicate and stale-revision reports conflict instead of overwriting", async () => {
    const host = new FakeHost();
    host.assign(running());
    const handlers = register(host);
    await handlers.get("report_annotation_result")!(report());
    const duplicate = await handlers.get("report_annotation_result")!(report());
    expect(duplicate.structuredContent).toMatchObject({ error: { code: "stale-result-revision" } });
    const revised = await handlers.get("report_annotation_result")!(
      report({ expectedResultRevision: 1, summary: "Revised." }),
    );
    expect(revised.structuredContent).toMatchObject({ ok: true, result: { revision: 2 } });
    expect(host.reports.map((entry) => entry.summary)).toEqual(["Increased padding.", "Revised."]);
  });

  test("late reports after cancellation cannot record, resolve, or dispatch", async () => {
    const host = new FakeHost();
    host.assign(running({ state: "cancelled", cancelRequestedAt: new Date(0).toISOString() }));
    const handlers = register(host);
    const late = await handlers.get("report_annotation_result")!(report());
    expect(late.structuredContent).toMatchObject({ error: { code: "request-closed" } });
    host.assignments.clear();
    const unassigned = await handlers.get("report_annotation_result")!(report());
    expect(unassigned.structuredContent).toMatchObject({ error: { code: "no-assigned-request" } });
    expect(host.reports).toEqual([]);
  });

  test("invalid reports are rejected before reaching the host", async () => {
    const host = new FakeHost();
    host.assign(running());
    const handlers = register(host);
    const traversal = await handlers.get("report_annotation_result")!(
      report({ files: ["../../etc/passwd"] }),
    );
    expect(traversal.structuredContent).toMatchObject({ error: { code: "invalid-report" } });
    expect(host.reports).toEqual([]);
  });

  test("concurrency and deadlines are bounded without unhandled rejections", async () => {
    const host = new FakeHost();
    host.assign(running());
    host.hang = true;
    const limiter = new WebAnnotationToolLimiter({ timeoutMs: 30, perScope: 1 });
    const handlers = register(host, SCOPE, limiter);
    const first = handlers.get("get_annotation_request")!({});
    const second = await handlers.get("get_annotation_request")!({});
    expect(second.structuredContent).toMatchObject({ error: { code: "busy" } });
    expect((await first).structuredContent).toMatchObject({ error: { code: "timeout" } });
    host.hang = false;
    expect((await handlers.get("get_annotation_request")!({})).structuredContent).toMatchObject({
      ok: true,
    });
  });
});

describe("agent tools server wiring", () => {
  let dataDir: string;
  let storage: StorageService;
  let server: AgentToolsServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-wa-tools-"));
    storage = new StorageService(dataDir);
    await storage.init();
    server = new AgentToolsServer(storage, "127.0.0.1");
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function rpc(url: string, token: string, method: string, params?: Record<string, unknown>) {
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
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length)
      : text;
    return {
      status: response.status,
      body: (payload ? JSON.parse(payload) : {}) as {
        result?: { tools?: Array<{ name: string }>; structuredContent?: Record<string, unknown> };
      },
    };
  }

  const toolNames = (body: { result?: { tools?: Array<{ name: string }> } }) =>
    (body.result?.tools ?? []).map((tool) => tool.name);

  test("tools are advertised only with a host and only to tab credentials; revocation denies", async () => {
    const tab = server.connection(ENV, "proj-1", "host", "tab-agent-1");
    const environmentWide = server.connection(ENV, "proj-1", "host");
    expect(toolNames((await rpc(tab.url, tab.token, "tools/list")).body)).not.toContain(
      "get_annotation_request",
    );

    const host = new FakeHost();
    host.assign(running({ environmentId: ENV }));
    server.setWebAnnotationToolHost(host);
    expect(server.hasWebAnnotationTools()).toBe(true);
    const listed = toolNames((await rpc(tab.url, tab.token, "tools/list")).body);
    expect(listed).toEqual(expect.arrayContaining([...WEB_ANNOTATION_TOOL_NAMES]));
    expect(
      toolNames((await rpc(environmentWide.url, environmentWide.token, "tools/list")).body),
    ).not.toContain("get_annotation_request");

    const call = await rpc(tab.url, tab.token, "tools/call", {
      name: "get_annotation_request",
      arguments: {},
    });
    expect(call.body.result?.structuredContent).toMatchObject({
      ok: true,
      request: { requestId: "req-1" },
    });

    server.revokeTab(ENV, "tab-agent-1");
    const revoked = await rpc(tab.url, tab.token, "tools/call", {
      name: "get_annotation_request",
      arguments: {},
    });
    expect(revoked.status).toBe(401);

    server.setWebAnnotationToolHost(null);
    const fresh = server.connection(ENV, "proj-1", "host", "tab-agent-1");
    expect(toolNames((await rpc(fresh.url, fresh.token, "tools/list")).body)).not.toContain(
      "get_annotation_request",
    );
  });
});
