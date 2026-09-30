import { describe, expect, jest, test } from "bun:test";

import { harness, threadPayload } from "./app-server-runtime-test-harness.js";

jest.setTimeout(30_000);

const RESULT_TURN = {
  prompt: "Submit the report",
  attachments: [],
  readOnly: true,
  agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "attempt-secret" },
  workflowResultTool: "submit_consolidated_review",
};

function orkestratorTools(...names: string[]) {
  return {
    data: [
      {
        name: "orkestrator",
        runtimeStatus: "connected",
        tools: Object.fromEntries(names.map((name) => [name, { name }])),
        toolsError: null,
      },
    ],
    nextCursor: null,
  };
}

function configuredBearer(params: Record<string, unknown>): string {
  const config = params.config as Record<string, { http_headers: { Authorization: string } }>;
  return config["mcp_servers.orkestrator"].http_headers.Authorization;
}

describe("workflow result turns", () => {
  test("refuses a result turn whose thread does not offer the submit tool", async () => {
    let listed = ["submit_validation_plan"];
    const h = await harness({ "mcpServerStatus/list": () => orkestratorTools(...listed) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "Prepare", requestId: "prepare", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const refused = await h.runtime.prompt(sessionId, { ...RESULT_TURN, requestId: "consolidate" });

    expect(refused).toMatchObject({ ok: false, status: 424 });
    expect(refused.ok ? "" : refused.error).toContain("submit_consolidated_review");
    const turns = () => h.child().requests.filter((request) => request.method === "turn/start");
    expect(turns()).toHaveLength(1);
    expect(
      h.child().requests.find((request) => request.method === "mcpServerStatus/list")?.params,
    ).toEqual({ threadId: "thread-1", serverName: "orkestrator", detail: "toolsAndAuthOnly" });

    // Nothing was journaled, so the same request id dispatches once the tool is there.
    listed = ["submit_consolidated_review"];
    expect(
      await h.runtime.prompt(sessionId, { ...RESULT_TURN, requestId: "consolidate" }),
    ).toMatchObject({ ok: true, result: { status: "processing" } });
    expect(turns()).toHaveLength(2);
  });

  test("a reload whose resume fails re-attaches the released thread on the next prompt", async () => {
    let failResume = false;
    const h = await harness({
      "thread/resume": (params) => {
        if (failResume) throw new Error("resume unavailable");
        return { thread: threadPayload(String(params.threadId)) };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "Prepare", requestId: "prepare", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    failResume = true;
    expect(
      await h.runtime.prompt(sessionId, { ...RESULT_TURN, requestId: "consolidate" }),
    ).toMatchObject({ ok: false, status: 503 });

    failResume = false;
    const resumesBefore = h
      .child()
      .requests.filter((request) => request.method === "thread/resume").length;
    expect(
      await h.runtime.prompt(sessionId, { prompt: "Carry on", requestId: "next", attachments: [] }),
    ).toMatchObject({ ok: true });
    expect(
      h.child().requests.filter((request) => request.method === "thread/resume").length,
    ).toBeGreaterThan(resumesBefore);
    expect(
      h
        .child()
        .requests.filter((request) => request.method === "turn/start")
        .at(-1)?.params.threadId,
    ).toBe("thread-1");
  });

  test("refuses rotated result credentials until unsubscribe confirms the old connection unloaded", async () => {
    let loaded = false;
    let failUnsubscribe = false;
    let liveToken: unknown;
    const h = await harness({
      "thread/start": (params) => {
        loaded = true;
        liveToken = configuredBearer(params);
        return { thread: threadPayload("thread-1") };
      },
      "thread/unsubscribe": () => {
        if (failUnsubscribe) throw new Error("unsubscribe unavailable");
        loaded = false;
        return {};
      },
      "thread/resume": (params) => {
        // A loaded app-server thread ignores every configuration override.
        if (!loaded) {
          liveToken = configuredBearer(params);
        }
        loaded = true;
        return { thread: threadPayload(String(params.threadId)) };
      },
      "mcpServerStatus/list": () => orkestratorTools("submit_consolidated_review"),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(await h.runtime.prompt(sessionId, { ...RESULT_TURN, requestId: "first" })).toMatchObject(
      { ok: true },
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const rotated = {
      ...RESULT_TURN,
      agentMcp: { ...RESULT_TURN.agentMcp, token: "rotated-secret" },
      requestId: "rotated",
    };
    const turns = () => h.child().requests.filter((request) => request.method === "turn/start");
    failUnsubscribe = true;
    const resumesBefore = h
      .child()
      .requests.filter((request) => request.method === "thread/resume").length;
    expect(await h.runtime.prompt(sessionId, rotated)).toMatchObject({ ok: false, status: 503 });
    expect(h.child().requests.filter((request) => request.method === "thread/resume")).toHaveLength(
      resumesBefore,
    );
    expect(liveToken).toBe("Bearer attempt-secret");
    expect(turns()).toHaveLength(1);
    // Re-attachment may rejoin the old thread, but the result reload must still
    // confirm unsubscribe before tool inventory or dispatch admission.
    expect(await h.runtime.prompt(sessionId, rotated)).toMatchObject({ ok: false, status: 503 });
    expect(liveToken).toBe("Bearer attempt-secret");
    expect(turns()).toHaveLength(1);
    expect(
      h.child().requests.filter((request) => request.method === "mcpServerStatus/list"),
    ).toHaveLength(1);

    failUnsubscribe = false;
    // Reusing the request id succeeds: neither refusal admitted a dispatch.
    expect(await h.runtime.prompt(sessionId, rotated)).toMatchObject({ ok: true });
    expect(liveToken).toBe("Bearer rotated-secret");
    expect(turns()).toHaveLength(2);
  });

  test("an unanswerable tool listing does not block the result turn", async () => {
    const h = await harness({
      "mcpServerStatus/list": () => {
        throw new Error("status unavailable");
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    expect(
      await h.runtime.prompt(sessionId, { ...RESULT_TURN, requestId: "consolidate" }),
    ).toMatchObject({ ok: true });
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(true);
  });

  test("starts a fresh thread rather than reloading one that was never prompted", async () => {
    let started = 0;
    let listed: string[] = [];
    const h = await harness({
      "thread/start": () => ({ thread: threadPayload(`thread-${++started}`) }),
      "mcpServerStatus/list": () => orkestratorTools(...listed),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(
      await h.runtime.prompt(sessionId, { ...RESULT_TURN, requestId: "consolidate" }),
    ).toMatchObject({ ok: false, status: 424 });

    listed = ["submit_consolidated_review"];
    expect(
      await h.runtime.prompt(sessionId, { ...RESULT_TURN, requestId: "consolidate" }),
    ).toMatchObject({ ok: true });

    const requests = h.child().requests;
    // thread-1 has no rollout: resuming it would fail with "no rollout found".
    expect(requests.some((request) => request.method === "thread/resume")).toBe(false);
    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
    expect(requests.find((request) => request.method === "turn/start")?.params.threadId).toBe(
      "thread-2",
    );
  });
});
