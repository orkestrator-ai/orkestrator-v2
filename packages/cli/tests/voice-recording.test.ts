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
    // An invalid tab cannot form a handle; the environment is still a target.
    expect(targetsOf({ environmentId: ENV, tabId: "bad tab" })).toEqual({ environment: ENV });
  });

  test("result IDs are collected from ID keys and session handles, bounded", () => {
    expect(
      idsInResult({
        receipt: { operationId: "op-1", resources: { sessionId: SESSION } },
        result: { items: [{ id: "int-1", note: OTHER_SESSION }, { title: "not an id" }] },
      }).sort(),
    ).toEqual(["int-1", "op-1", OTHER_SESSION, SESSION].sort());
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
      sessionId: SESSION,
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
    expect(score.sessionId).toBe(SESSION);
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
      expect(recorded).toHaveLength(2);
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
      ];
      await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const run = Bun.spawnSync(
        ["bun", path.join(EXAMPLES, "voice-qualify.ts"), "--score", file, "--environment", ENV],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(run.exitCode).toBe(0);
      const report = JSON.parse(run.stdout.toString()) as ReturnType<typeof recordingReport>;
      expect(report.score).toMatchObject({ sessionId: SESSION, targetedCalls: 2 });
      expect(report.score.handleCopyErrors).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("--expect-approval passes only when an approval is confirmed and answered", async () => {
    const run = async (kind: "command-approval" | "question") => {
      const directory = await mkdtemp(path.join(tmpdir(), "voice-approval-"));
      const answers: Array<Record<string, unknown>> = [];
      let resolved = false;
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
                      state: "running",
                      execution: resolved
                        ? { state: "completed", interactions: [] }
                        : {
                            state: "waiting-for-input",
                            interactions: [{ id: "int-1", revision: 2 }],
                          },
                    },
                  },
                ),
              );
            case "run_action":
              return Response.json(
                envelope("session.interactions", {
                  items: [
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
        return { exitCode, report: JSON.parse(stdout), answers, recording };
      } finally {
        server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    };

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
      sessionId: SESSION,
      misresolvedTargets: [],
      handleCopyErrors: [],
    });
    expect(approval.recording.trim().split("\n").length).toBeGreaterThan(4);

    const question = await run("question");
    expect(question.exitCode).toBe(1);
    expect(question.report.approval).toBe("not raised or refused");
  });
});
