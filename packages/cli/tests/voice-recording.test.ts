import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { startRelay } from "../examples/voice-mcp-relay.js";
import {
  idsInResult,
  recordCall,
  recordingReport,
  scoreRecording,
  targetsOf,
  type RecordedCall,
  type RecordingEntry,
} from "../examples/voice-recording.js";

const ENV = "env-voice";
const OTHER_ENV = "env-other";
const SESSION = encodePublicSessionId(ENV, "tab-1");
const OTHER_SESSION = encodePublicSessionId(OTHER_ENV, "tab-9");
const EXAMPLES = path.resolve(import.meta.dirname, "../examples");

function envelope(action: string, result: unknown, extra: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: "1",
    result: {
      content: [{ type: "text", text: `${action} done` }],
      structuredContent: { schemaVersion: 1, ok: true, action, result, ...extra },
    },
  };
}

function call(
  tool: string,
  targets: RecordedCall["targets"],
  resultIds: string[] = [],
  ok = true,
): RecordedCall {
  return { type: "call", at: "", tool, ms: 1, ok, textBytes: 10, targets, resultIds };
}

describe("voice recordings", () => {
  test("targets come from a call's arguments, or run_action's input", () => {
    expect(targetsOf({ sessionId: SESSION, prompt: "secret", requestId: "r" })).toEqual({
      session: SESSION,
    });
    expect(targetsOf({ environmentId: ENV, tabId: "tab-1", expectedOperationId: "op-1" })).toEqual({
      environment: ENV,
      session: SESSION,
      operation: "op-1",
    });
    expect(
      targetsOf({
        action: "session.interactions",
        input: { sessionId: SESSION, interactionId: "int-1" },
      }),
    ).toEqual({ session: SESSION, interaction: "int-1" });
    expect(targetsOf({ projectId: "project-voice" })).toEqual({ project: "project-voice" });
    expect(targetsOf({ input: { projectId: "project-voice" } })).toEqual({
      project: "project-voice",
    });
    expect(targetsOf({ environmentId: ENV, tabId: "bad tab" })).toEqual({
      environment: ENV,
      session: "invalid-session-identity",
    });
  });

  test("result IDs are collected only from resource fields, bounded", () => {
    expect(
      idsInResult({
        receipt: { operationId: "op-1", resources: { sessionId: SESSION } },
        result: { items: [{ id: "int-1", note: OTHER_SESSION }, { title: "not an id" }] },
      }).sort(),
    ).toEqual(["int-1", "op-1", SESSION].sort());
    const many = { items: Array.from({ length: 500 }, (_, index) => ({ id: `id-${index}` })) };
    expect(idsInResult(many)).toHaveLength(200);
  });

  test("a recorded call keeps IDs and sizes, never prompts or result text", () => {
    const { entry } = recordCall(
      "start_work",
      { environmentId: ENV, prompt: "PROMPT-CANARY", requestId: "r" },
      envelope(
        "session.start",
        { said: "RESULT-CANARY" },
        { receipt: { operationId: "op-1", resources: { sessionId: SESSION } } },
      ),
      12.5,
    );
    expect(entry).toMatchObject({
      tool: "start_work",
      ok: true,
      ms: 12.5,
      targets: { environment: ENV },
    });
    expect(entry.resultIds.sort()).toEqual(["op-1", SESSION].sort());
    expect(JSON.stringify(entry)).not.toContain("CANARY");
  });

  test("transcript and free-text handles never enter resultIds", () => {
    const { entry } = recordCall(
      "read_session",
      { sessionId: SESSION },
      envelope("session.transcript", {
        sessionId: SESSION,
        messages: [
          {
            id: "message-1",
            text: "ses_PRIVATE-CANARY confidential content",
            parts: [{ id: "PRIVATE-CANARY" }],
          },
        ],
        text: OTHER_SESSION,
        title: "ses_PRIVATE-CANARY",
        body: { sessionId: OTHER_SESSION },
        items: [{ id: "ses_PRIVATE-CANARY confidential content" }],
      }),
      1,
    );
    expect(entry.resultIds).toEqual([SESSION]);
    expect(JSON.stringify(entry)).not.toContain("CANARY");
    expect(JSON.stringify(entry)).not.toContain(OTHER_SESSION);
  });

  test("malformed tab identities remain session copy errors through extraction and scoring", () => {
    for (const tabId of ["bad tab", "x".repeat(201), "x".repeat(10_000)]) {
      const entry = recordCall("read_session", { environmentId: ENV, tabId }, {}, 1).entry;
      const score = scoreRecording([call("start_work", { environment: ENV }, [SESSION]), entry], {
        environmentId: ENV,
      });
      expect(score.handleCopyErrors).toEqual([
        { index: 1, tool: "read_session", kinds: ["session"] },
      ]);
      expect(score.copyErrorRate).toBe(0.5);
      expect(JSON.stringify(entry)).not.toContain(tabId);
    }
    const valid = recordCall("read_session", { environmentId: ENV, tabId: "tab-1" }, {}, 1).entry;
    expect(
      scoreRecording([call("start_work", { environment: ENV }, [SESSION]), valid], {
        environmentId: ENV,
      }).copyErrorRate,
    ).toBe(0);
  });

  test("project targets distinguish exact, misresolved and unreturned IDs", () => {
    const entries = [
      call("overview", {}, ["project-other"]),
      call("run_action", { project: "project-voice" }),
      call("overview", { project: "project-other" }),
      call("overview", { project: "project-typo" }),
    ];
    const score = scoreRecording(entries, { environmentId: ENV, projectId: "project-voice" });
    expect(score.targetedCalls).toBe(3);
    expect(score.misresolvedTargets).toEqual([{ index: 2, tool: "overview", kinds: ["project"] }]);
    expect(score.handleCopyErrors).toEqual([{ index: 3, tool: "overview", kinds: ["project"] }]);
  });

  test("the script with exact handles scores zero", () => {
    const entries: RecordingEntry[] = [
      { type: "tools/list", at: "", tools: 12, bytes: 7_000 },
      call("overview", {}, [ENV, OTHER_ENV, OTHER_SESSION]),
      call("start_work", { environment: ENV }, ["op-1", SESSION]),
      call("run_status", { operation: "op-1" }, ["int-1"]),
      call("answer_question", { session: SESSION, interaction: "int-1" }),
      call("stop_session", { session: SESSION }),
      call("read_session", { session: SESSION }),
    ];
    const score = scoreRecording(entries, { environmentId: ENV });
    expect(score).toEqual({
      sessionIds: [SESSION],
      targetedCalls: 5,
      misresolvedTargets: [],
      handleCopyErrors: [],
      misresolvedRate: 0,
      copyErrorRate: 0,
    });
  });

  test("a wrong but real target is misresolved; an unreturned or malformed handle is a copy error", () => {
    const typo = `${SESSION.slice(0, -2)}xx`;
    const entries: RecordingEntry[] = [
      call("overview", {}, [ENV, OTHER_ENV, OTHER_SESSION]),
      call("start_work", { environment: OTHER_ENV }, ["op-0", OTHER_SESSION]),
      call("start_work", { environment: ENV }, ["op-1", SESSION]),
      call("stop_session", { session: OTHER_SESSION }),
      call("read_session", { session: typo }, [], false),
      call("read_session", { session: "ses_not-base64!" }, [], false),
      call("run_status", { operation: "op-404" }, [], false),
      call("read_session", { session: SESSION }),
    ];
    const score = scoreRecording(entries, { environmentId: ENV });
    expect(score.sessionIds).toEqual([SESSION]);
    expect(score.misresolvedTargets).toEqual([
      { index: 1, tool: "start_work", kinds: ["environment"] },
      { index: 3, tool: "stop_session", kinds: ["session"] },
    ]);
    expect(score.handleCopyErrors).toEqual([
      { index: 4, tool: "read_session", kinds: ["session"] },
      { index: 5, tool: "read_session", kinds: ["session"] },
      { index: 6, tool: "run_status", kinds: ["operation"] },
    ]);
    expect(score.targetedCalls).toBe(7);
    expect(score.misresolvedRate).toBeCloseTo(2 / 7);
    expect(score.copyErrorRate).toBeCloseTo(3 / 7);
  });

  test("repeats of the script follow the latest session", () => {
    const second = encodePublicSessionId(ENV, "tab-2");
    const entries: RecordingEntry[] = [
      call("start_work", { environment: ENV }, ["op-1", SESSION]),
      call("stop_session", { session: SESSION }),
      call("start_work", { environment: ENV }, ["op-2", second]),
      call("stop_session", { session: second }),
      // Addressing the first run's session after the second started is wrong.
      call("read_session", { session: SESSION }),
    ];
    const score = scoreRecording(entries, { environmentId: ENV });
    expect(score.sessionIds).toEqual([SESSION, second]);
    expect(score.misresolvedTargets).toEqual([
      { index: 4, tool: "read_session", kinds: ["session"] },
    ]);
    expect(score.handleCopyErrors).toEqual([]);
  });

  test("the report covers latency, sizes and the score", () => {
    const entries: RecordingEntry[] = [
      { type: "tools/list", at: "", tools: 12, bytes: 7_096 },
      { ...call("overview", {}, [ENV]), ms: 3, textBytes: 400 },
      { ...call("overview", {}, [ENV]), ms: 1_500, textBytes: 80 },
    ];
    const report = recordingReport(entries, { environmentId: ENV });
    expect(report.tools).toEqual({ count: 12, bytes: 7_096, approxTokens: 1_774 });
    expect(report.latency.readsP50Ms).toBe(3);
    expect(report.latency.readsP95Ms).toBe(1_500);
    expect(report.latency.readsP95UnderOneSecond).toBe(false);
    expect(report.resultText).toEqual({ maxBytes: 400, approxMaxTokens: 100 });
    expect(report.score.targetedCalls).toBe(0);
  });
});

describe("recording relay", () => {
  test("forwards requests with the caller's token and records each tool call", async () => {
    const seen: Array<{ authorization: string | null; body: unknown }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { method: string; params?: { name?: string } };
        seen.push({ authorization: request.headers.get("authorization"), body });
        if (body.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: "1", result: { tools: [{ name: "a" }] } });
        }
        if (body.params?.name === "start_work") {
          // A streamable-HTTP reply as one SSE event.
          const reply = envelope(
            "session.start",
            {},
            { receipt: { operationId: "op-1", resources: { sessionId: SESSION } } },
          );
          return new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("unauthorized", { status: 401 });
      },
    });
    const recorded: RecordingEntry[] = [];
    const relay = startRelay({
      upstream: `http://127.0.0.1:${upstream.port}/mcp`,
      record: (entry) => {
        recorded.push(entry);
      },
    });
    try {
      const post = (body: unknown) =>
        fetch(`http://127.0.0.1:${relay.port}/mcp`, {
          method: "POST",
          headers: { Authorization: "Bearer voice-token", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await post({ jsonrpc: "2.0", id: "1", method: "tools/list" })).status).toBe(200);
      const started = await post({
        jsonrpc: "2.0",
        id: "2",
        method: "tools/call",
        params: {
          name: "start_work",
          arguments: { environmentId: ENV, prompt: "PROMPT-CANARY", requestId: "r" },
        },
      });
      expect(started.headers.get("content-type")).toBe("text/event-stream");
      expect(await started.text()).toContain("op-1");
      const refused = await post({
        jsonrpc: "2.0",
        id: "3",
        method: "tools/call",
        params: { name: "overview", arguments: {} },
      });
      expect(refused.status).toBe(401);

      expect(seen.map((request) => request.authorization)).toEqual([
        "Bearer voice-token",
        "Bearer voice-token",
        "Bearer voice-token",
      ]);
      expect(recorded).toHaveLength(3);
      expect(recorded[2]).toMatchObject({
        type: "call",
        tool: "overview",
        ok: false,
        code: "http:401",
      });
      expect(recorded[0]).toMatchObject({ type: "tools/list", tools: 1 });
      expect(recorded[1]).toMatchObject({
        type: "call",
        tool: "start_work",
        ok: true,
        targets: { environment: ENV },
      });
      expect(JSON.stringify(recorded)).not.toContain("CANARY");
      expect(JSON.stringify(recorded)).not.toContain("voice-token");
    } finally {
      relay.stop(true);
      upstream.stop(true);
    }
  });

  test("failed HTTP, network and malformed replies retain attempted targets and failures", async () => {
    const recorded: RecordingEntry[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { params } = (await request.json()) as { params: { arguments: { mode: string } } };
        if (params.arguments.mode === "malformed") return new Response("PRIVATE-CANARY");
        if (params.arguments.mode === "null") return Response.json(null);
        return new Response("PRIVATE-CANARY", { status: Number(params.arguments.mode) });
      },
    });
    const relay = startRelay({
      upstream: `http://127.0.0.1:${upstream.port}/mcp`,
      record: (entry) => {
        recorded.push(entry);
      },
    });
    const post = (mode: string) =>
      fetch(`http://127.0.0.1:${relay.port}/mcp`, {
        method: "POST",
        body: JSON.stringify({
          method: "tools/call",
          params: { name: "read_session", arguments: { sessionId: SESSION, mode } },
        }),
      });
    try {
      for (const mode of ["401", "500", "malformed", "null"]) {
        expect((await post(mode)).status).toBe(Number(mode) || 200);
      }
      await upstream.stop(true);
      expect((await post("network")).status).toBe(502);
      expect(recorded).toHaveLength(5);
      const calls = recorded as RecordedCall[];
      expect(calls.map((entry) => entry.code)).toEqual([
        "http:401",
        "http:500",
        "invalid-response",
        "invalid-envelope",
        "network-error",
      ]);
      for (const entry of calls) {
        expect(entry).toMatchObject({
          type: "call",
          tool: "read_session",
          ok: false,
          targets: { session: SESSION },
          resultIds: [],
        });
        expect(entry.ms).toBeGreaterThanOrEqual(0);
      }
      const report = recordingReport(recorded, { environmentId: ENV });
      expect(report.calls).toBe(5);
      expect(report.score.targetedCalls).toBe(5);
      expect(report.score.handleCopyErrors).toHaveLength(5);
      expect(report.latency.byTool.read_session!.failures).toHaveLength(5);
      expect(JSON.stringify(recorded)).not.toContain("CANARY");
    } finally {
      relay.stop(true);
      upstream.stop(true);
    }
  });

  test("recording rejection fails the request and refuses subsequent forwarding", async () => {
    let forwarded = 0;
    let failures = 0;
    let writes = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        forwarded++;
        return Response.json(envelope("overview", {}));
      },
    });
    const relay = startRelay({
      upstream: `http://127.0.0.1:${upstream.port}/mcp`,
      record: () => {
        writes++;
        throw new Error("PRIVATE-CANARY");
      },
      onRecordingError: () => {
        failures++;
      },
    });
    try {
      for (let index = 0; index < 2; index++) {
        const response = await fetch(`http://127.0.0.1:${relay.port}/mcp`, {
          method: "POST",
          body: JSON.stringify({ method: "tools/call", params: { name: "overview" } }),
        });
        expect(response.status).toBe(503);
        expect(await response.text()).toBe("Recording failed; recording is incomplete");
      }
      expect(failures).toBe(1);
      expect(writes).toBe(1);
      expect(forwarded).toBe(1);
    } finally {
      relay.stop(true);
      upstream.stop(true);
    }
  });

  test("an invalid recording destination fails before announcing readiness", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "voice-relay-"));
    try {
      const result = Bun.spawnSync(
        [
          "bun",
          path.join(EXAMPLES, "voice-mcp-relay.ts"),
          "--record",
          path.join(directory, "missing", "run.jsonl"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).not.toContain("Relaying");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("chunked oversized requests are refused before forwarding", async () => {
    let forwarded = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        forwarded++;
        return new Response("ok");
      },
    });
    const relay = startRelay({
      upstream: `http://127.0.0.1:${upstream.port}/mcp`,
      record: () => undefined,
    });
    try {
      const chunk = new Uint8Array(1024 * 1024);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < 5; index++) controller.enqueue(chunk);
          controller.close();
        },
      });
      const response = await fetch(`http://127.0.0.1:${relay.port}/mcp`, { method: "POST", body });
      expect(response.status).toBe(413);
      expect(forwarded).toBe(0);
    } finally {
      relay.stop(true);
      upstream.stop(true);
    }
  });

  test("refuses oversized requests and reports an unreachable upstream", async () => {
    const relay = startRelay({ upstream: "http://127.0.0.1:1/mcp", record: () => undefined });
    try {
      const url = `http://127.0.0.1:${relay.port}/mcp`;
      expect(
        (await fetch(url, { method: "POST", body: "x".repeat(4 * 1024 * 1024 + 1) })).status,
      ).toBe(413);
      expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(502);
    } finally {
      relay.stop(true);
    }
  });
});

describe("voice-qualify script modes", () => {
  test("--score reports a recording", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "voice-score-"));
    try {
      const file = path.join(directory, "run.jsonl");
      const entries: RecordingEntry[] = [
        call("start_work", { environment: ENV }, ["op-1", SESSION]),
        call("read_session", { session: SESSION }),
        call("overview", { project: "project-voice" }),
      ];
      await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const run = Bun.spawnSync(
        [
          "bun",
          path.join(EXAMPLES, "voice-qualify.ts"),
          "--score",
          file,
          "--environment",
          ENV,
          "--project",
          "project-voice",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(run.exitCode).toBe(0);
      const report = JSON.parse(run.stdout.toString()) as ReturnType<typeof recordingReport>;
      expect(report.score).toMatchObject({ sessionIds: [SESSION], targetedCalls: 3 });
      expect(report.score.handleCopyErrors).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const run = async (
    kind: string | undefined,
    afterStates: Array<{
      state: string;
      execution?: { state: string; interactions?: Array<{ id: string }> };
    }> = [{ state: "succeeded", execution: { state: "completed", interactions: [] } }],
  ) => {
    const directory = await mkdtemp(path.join(tmpdir(), "voice-approval-"));
    const answers: Array<Record<string, unknown>> = [];
    let resolved = false;
    let pollsAfterAnswer = 0;
    let stoppedAfter = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          method: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        if (body.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: "1", result: { tools: [{ name: "a" }] } });
        }
        const args = body.params?.arguments ?? {};
        switch (body.params?.name) {
          case "start_work":
            return Response.json(
              envelope(
                "session.start",
                {},
                { receipt: { operationId: "op-1", resources: { sessionId: SESSION } } },
              ),
            );
          case "run_status":
            return Response.json(
              envelope(
                "run.get",
                {},
                {
                  receipt: {
                    ...(resolved
                      ? afterStates[Math.min(pollsAfterAnswer++, afterStates.length - 1)]
                      : {
                          state: "running",
                          execution: {
                            state: "waiting-for-input",
                            interactions: [{ id: "int-1", revision: 2 }],
                          },
                        }),
                  },
                },
              ),
            );
          case "run_action":
            return Response.json(
              envelope("session.interactions", {
                items:
                  kind === undefined
                    ? []
                    : [
                        {
                          id: "int-1",
                          kind,
                          questions: [
                            {
                              id: "q",
                              required: true,
                              allowFreeText: false,
                              options: [
                                { id: "deny", label: "Deny" },
                                { id: "allow", label: "Allow" },
                              ],
                            },
                          ],
                        },
                      ],
              }),
            );
          case "stop_session":
            stoppedAfter = pollsAfterAnswer;
            return Response.json({
              result: {
                isError: true,
                structuredContent: { ok: false, error: { code: "session-idle" } },
              },
            });
          case "answer_question":
            answers.push(args);
            if (kind !== "question" && !args.confirmToken) {
              return Response.json({
                jsonrpc: "2.0",
                id: "1",
                result: {
                  isError: true,
                  content: [{ type: "text", text: "Confirm" }],
                  structuredContent: {
                    schemaVersion: 1,
                    ok: false,
                    action: "session.interaction.resolve",
                    error: { code: "confirmation-required", details: { confirmToken: "tok" } },
                  },
                },
              });
            }
            resolved = true;
            return Response.json(envelope("session.interaction.resolve", {}));
          default:
            return Response.json(envelope(body.params?.name ?? "unknown", {}));
        }
      },
    });
    try {
      const record = path.join(directory, "run.jsonl");
      const child = Bun.spawn(
        [
          "bun",
          path.join(EXAMPLES, "voice-qualify.ts"),
          "--url",
          `http://127.0.0.1:${server.port}/mcp`,
          "--environment",
          ENV,
          "--read-repeats",
          "1",
          "--approval-wait",
          "5",
          "--expect-approval",
          "--record",
          record,
        ],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, ORKESTRATOR_MCP_TOKEN: "t" } },
      );
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      const recording = await readFile(record, "utf8");
      return { exitCode, report: JSON.parse(stdout), answers, recording, stoppedAfter };
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  };

  test("--expect-approval passes only when an approval is confirmed and answered", async () => {
    const approval = await run("command-approval");
    expect(approval.exitCode).toBe(0);
    expect(approval.report.approval).toBe("confirmed and answered");
    expect(approval.report.steps[2]).toEqual({
      step: "answer_question",
      outcome: "command-approval confirmed and answered; run then completed",
    });
    expect(approval.answers.map((answer) => answer.confirmToken)).toEqual([undefined, "tok"]);
    expect(approval.answers[1]!.answers).toEqual([{ questionId: "q", optionIds: ["allow"] }]);
    expect(approval.report.selfCheck).toMatchObject({
      sessionIds: [SESSION],
      misresolvedTargets: [],
      handleCopyErrors: [],
    });
    expect(approval.recording.trim().split("\n").length).toBeGreaterThan(4);
    expect(approval.report.steps[3]).toEqual({
      step: "stop_session",
      outcome: "already finished (session-idle)",
    });

    const question = await run("question");
    expect(question.exitCode).toBe(1);
    expect(question.report.approval).toBe("not raised or refused");
  });
  for (const kind of ["file-approval", "plan-approval", "permission", undefined]) {
    test(`--expect-approval ${kind === "file-approval" ? "accepts" : "rejects"} ${kind ?? "missing details"}`, async () => {
      const result = await run(kind);
      expect(result.exitCode).toBe(kind === "file-approval" ? 0 : 1);
      expect(result.answers.map((answer) => answer.confirmToken)).toEqual([undefined, "tok"]);
    });
  }

  test("post-answer wait follows admitted, unknown, empty waiting and running through completion", async () => {
    const result = await run("command-approval", [
      { state: "admitted" },
      { state: "unknown" },
      { state: "running", execution: { state: "waiting-for-input", interactions: [] } },
      { state: "running", execution: { state: "running" } },
      { state: "succeeded", execution: { state: "completed" } },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stoppedAfter).toBe(5);
    expect(result.report.steps[2].outcome).toEndWith("run then completed");
  });

  test("post-answer wait ends for a distinct pending interaction", async () => {
    const result = await run("command-approval", [
      {
        state: "running",
        execution: { state: "waiting-for-input", interactions: [{ id: "int-1" }] },
      },
      {
        state: "running",
        execution: { state: "waiting-for-input", interactions: [{ id: "int-1" }, { id: "int-2" }] },
      },
    ]);
    expect(result.stoppedAfter).toBe(2);
    expect(result.report.steps[2].outcome).toEndWith("run then waiting-for-input");
  });
});
