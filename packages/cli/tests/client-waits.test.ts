import { afterEach, describe, expect, test } from "bun:test";
import {
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicReceipt,
  type PublicErrorCode,
} from "@orkestrator/protocol/public-api";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  captureIo,
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

import { runClient } from "../src/client/main.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const OPERATION = "op-1790000000000-0a1b2c3d-000000000000000001";

function receipt(overrides: Partial<PublicReceipt>): PublicReceipt {
  return {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    operationId: OPERATION,
    ...overrides,
  };
}

async function fixture(
  receipts: PublicReceipt[],
  extra: Record<string, (call: number) => unknown> = {},
): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  let call = 0;
  const counters: Record<string, number> = {};
  const gateway = await startFakeGateway((request) => {
    const action = String(request.body.args.action);
    if (action === "run.get") {
      const next = receipts[Math.min(call, receipts.length - 1)]!;
      call += 1;
      return envelope(publicSuccessEnvelope("run.get", null, next));
    }
    if (extra[action]) {
      counters[action] = (counters[action] ?? 0) + 1;
      return envelope(publicSuccessEnvelope(action, extra[action]!(counters[action]!)));
    }
    return defaultResponder()(request);
  });
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return { box, gateway };
}

describe("run wait exit mapping", () => {
  test("raw run output uses base64 bytes even when text is lossy", async () => {
    const { box } = await fixture([receipt({})], {
      "run.output": () => ({
        stream: "stdout",
        text: "��",
        base64: "//4=",
        offset: 0,
        totalBytes: 2,
        complete: true,
      }),
    });
    const result = await box.run(["run", "output", OPERATION, "--raw"]);
    expect(result.code).toBe(0);
    expect(Buffer.from(result.out, "binary")).toEqual(Buffer.from([0xff, 0xfe]));
  });
  test("invalid session wait options never submit a mutation", async () => {
    const { box, gateway } = await fixture([receipt({})]);
    for (const argv of [
      [
        "session",
        "start",
        "--environment",
        "env",
        "--agent",
        "codex",
        "--prompt",
        "hello",
        "--timeout",
        "5m",
      ],
      ["session", "prompt", "session-id", "--prompt", "hello", "--wait", "--timeout", "25h"],
    ]) {
      const result = await box.run(["--json", ...argv]);
      expect(result.code).toBe(2);
    }
    expect(gateway.requests).toHaveLength(0);
  });
  test("0 only after the run succeeds", async () => {
    const running = receipt({
      state: "running",
      stage: "executing",
      execution: { state: "running" },
      completedAt: undefined,
    });
    const { box } = await fixture([running, running, receipt({})]);
    const result = await box.run(["--json", "run", "wait", OPERATION, "--timeout", "10s"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).receipt.state).toBe("succeeded");
  });

  test("6 when an interaction needs an answer, unless told to keep waiting", async () => {
    const waiting = PUBLIC_API_FIXTURES.runWaitingForInput.receipt!;
    const { box } = await fixture([{ ...waiting, operationId: OPERATION }]);
    const result = await box.run(["--json", "run", "wait", OPERATION, "--timeout", "10s"]);
    expect(result.code).toBe(6);
    expect(JSON.parse(result.out).error.details.interactions[0].id).toBe("q-1");
    const keepWaiting = await box.run([
      "--json",
      "run",
      "wait",
      OPERATION,
      "--timeout",
      "600ms",
      "--continue-on-interaction",
    ]);
    expect(keepWaiting.code).toBe(5);
  });

  test("7 for an unknown dispatch, 1 for failures, 5 at the deadline with the receipt kept", async () => {
    const unknown = PUBLIC_API_FIXTURES.promptUnknown.receipt!;
    const first = await fixture([{ ...unknown, operationId: OPERATION }]);
    expect((await first.box.run(["--json", "run", "wait", OPERATION])).code).toBe(7);

    const failed = await fixture([
      receipt({
        state: "failed",
        error: { code: "run-failed", message: "boom" },
        execution: { state: "failed" },
      }),
    ]);
    const failedResult = await failed.box.run(["--json", "run", "wait", OPERATION]);
    expect(failedResult.code).toBe(1);
    expect(JSON.parse(failedResult.out).error.code).toBe("run-failed");

    const running = receipt({
      state: "running",
      execution: { state: "running" },
      completedAt: undefined,
    });
    const slow = await fixture([running]);
    const deadline = await slow.box.run(["--json", "run", "wait", OPERATION, "--timeout", "500ms"]);
    expect(deadline.code).toBe(5);
    const body = JSON.parse(deadline.out);
    expect(body.error.code).toBe("deadline-exceeded");
    expect(body.receipt.operationId).toBe(OPERATION);
  });
});

describe("waiting through a lost submission response", () => {
  const START = [
    "--json",
    "session",
    "start",
    "--environment",
    "env",
    "--agent",
    "codex",
    "--prompt",
    "hello",
    "--request-id",
    "slow-start",
  ];

  /** `session.start` admits but its response is lost; `run.get` finds it later. */
  async function lostStart(
    byKey: Array<PublicReceipt | null>,
    byId: PublicReceipt[],
    options: {
      action?: "session.start" | "session.prompt";
      mutationDelay?: number;
      lookupError?: PublicErrorCode;
      lookupDelay?: number;
      lookupFailures?: number;
      successfulSubmission?: boolean;
      onLookup?: () => void;
    } = {},
  ) {
    const box = await createSandbox();
    const lookups: Array<Record<string, unknown>> = [];
    let starts = 0;
    const gateway = await startFakeGateway(async (request) => {
      const action = String(request.body.args.action);
      const input = request.body.args.input as Record<string, unknown>;
      if (action === (options.action ?? "session.start")) {
        starts += 1;
        if (options.mutationDelay) await Bun.sleep(options.mutationDelay);
        if (options.successfulSubmission)
          return envelope(
            publicSuccessEnvelope(action, { sessionId: "ses_slow", runId: OPERATION }, byId[0]),
          );
        return new Response("upstream timeout", { status: 504 });
      }
      if (action === "run.get" && input.requestId !== undefined) {
        lookups.push(input);
        options.onLookup?.();
        if (options.lookupDelay) await Bun.sleep(options.lookupDelay);
        if (options.lookupFailures && lookups.length <= options.lookupFailures)
          return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
        if (options.lookupError)
          return envelope(
            publicErrorEnvelope("run.get", {
              code: options.lookupError,
              message: "lookup refused",
            }),
          );
        const next = byKey.shift();
        return next
          ? envelope(publicSuccessEnvelope("run.get", null, next))
          : envelope(
              publicErrorEnvelope("run.get", { code: "not-found", message: "not admitted yet" }),
            );
      }
      if (action === "run.get") {
        const next = byId.length > 1 ? byId.shift()! : byId[0]!;
        return envelope(publicSuccessEnvelope("run.get", null, next));
      }
      return defaultResponder()(request);
    });
    cleanups.push(
      () => box.cleanup(),
      () => gateway.stop(),
    );
    const dataDir = await box.publishDescriptor(gateway);
    await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
    return { box, lookups, starts: () => starts };
  }

  const admitted = receipt({
    action: "session.start",
    requestId: "slow-start",
    state: "running",
    stage: "admitted",
    resources: { environmentId: "env" },
    execution: undefined,
    completedAt: undefined,
  });
  const dispatched = receipt({
    action: "session.start",
    requestId: "slow-start",
    state: "running",
    stage: "dispatching",
    resources: { environmentId: "env", sessionId: "ses_slow", tabId: "agent-job-slow" },
    execution: { state: "running" },
    completedAt: undefined,
  });
  const finished = receipt({
    action: "session.start",
    requestId: "slow-start",
    resources: { environmentId: "env", sessionId: "ses_slow", tabId: "agent-job-slow" },
  });

  test("--wait finds the run by its request key and observes it to the end", async () => {
    const { box, lookups, starts } = await lostStart([null, admitted], [dispatched, finished]);
    const result = await box.run([...START, "--wait", "--timeout", "30s"]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out);
    expect(output.receipt.state).toBe("succeeded");
    expect(output.result).toMatchObject({ sessionId: "ses_slow", runId: OPERATION });
    expect(output.warnings.join("\n")).toContain("request key");
    // Looked up under the saved key and namespace; never resubmitted.
    expect(lookups).toHaveLength(2);
    expect(lookups[0]).toMatchObject({ requestId: "slow-start", action: "session.start" });
    expect(typeof lookups[0]!.namespace).toBe("string");
    expect(lookups[0]!.submittedInput).toEqual({
      environmentId: "env",
      agent: "codex",
      prompt: "hello",
    });
    expect(starts()).toBe(1);
  });

  test("the original error stands if the key never appears within the wait", async () => {
    const { box, starts } = await lostStart([], [finished]);
    const result = await box.run([...START, "--wait", "--timeout", "600ms"]);
    expect(result.code).toBe(4);
    const error = JSON.parse(result.out).error;
    expect(error.code).toBe("transport-uncertain");
    expect(error.details).toMatchObject({ requestId: "slow-start" });
    expect(starts()).toBe(1);
  });

  test.each(["history-expired", "auth-failed", "identity-mismatch", "request-conflict"] as const)(
    "preserves definitive %s lookup errors and recovery details",
    async (code) => {
      const { box } = await lostStart([], [], { lookupError: code });
      const result = await box.run([...START, "--wait", "--timeout", "10s"]);
      expect(JSON.parse(result.out).error).toMatchObject({
        code,
        details: { requestId: "slow-start", namespace: expect.any(String) },
      });
    },
  );

  test("signal interruption during recovery retains the key and interruption error", async () => {
    const controller = new AbortController();
    const { box } = await lostStart([], [], { onLookup: () => controller.abort("SIGTERM") });
    const io = captureIo(box.env);
    const code = await runClient([...START, "--wait"], {
      io,
      version: "test",
      signal: controller.signal,
    });
    expect(code).toBe(143);
    expect(JSON.parse(io.out.join("")).error).toMatchObject({
      code: "observation-interrupted",
      details: { requestId: "slow-start" },
    });
  });

  test("connection failures are retried without another submission", async () => {
    const { box, starts, lookups } = await lostStart([finished], [finished], { lookupFailures: 1 });
    expect((await box.run([...START, "--wait", "--timeout", "10s"])).code).toBe(0);
    expect(lookups).toHaveLength(2);
    expect(starts()).toBe(1);
  });

  test("prompt recovery reconstructs the run ID from its receipt", async () => {
    const final = { ...finished, action: "session.prompt" as const };
    const { box, lookups } = await lostStart([final], [final], { action: "session.prompt" });
    const result = await box.run([
      "--json",
      "session",
      "prompt",
      "ses_slow",
      "--prompt",
      "hello",
      "--wait",
      "--request-id",
      "slow-start",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).result.runId).toBe(OPERATION);
    expect(lookups[0]!.submittedInput).toEqual({ sessionId: "ses_slow", prompt: "hello" });
  });

  test("submission and an absent-key lookup share one deadline", async () => {
    const { box, lookups } = await lostStart([], [], { mutationDelay: 180 });
    const started = Date.now();
    const result = await box.run([...START, "--wait", "--timeout", "300ms"]);
    expect(JSON.parse(result.out).error.code).toBe("transport-uncertain");
    expect(lookups).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(450);
  });

  test("a stalled lookup is bounded by the remaining deadline", async () => {
    const { box } = await lostStart([], [], { mutationDelay: 120, lookupDelay: 600 });
    const started = Date.now();
    const result = await box.run([...START, "--wait", "--timeout", "250ms"]);
    expect(JSON.parse(result.out).error.code).toBe("transport-uncertain");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("recovery and final observation share the remaining deadline", async () => {
    const { box } = await lostStart([admitted], [dispatched], { mutationDelay: 160 });
    const started = Date.now();
    const result = await box.run([...START, "--wait", "--timeout", "300ms"]);
    expect(JSON.parse(result.out).error.code).toBe("deadline-exceeded");
    expect(Date.now() - started).toBeLessThan(450);
  });

  test("ordinary admission retains the full observation duration", async () => {
    const { box } = await lostStart([], [dispatched, finished], {
      mutationDelay: 300,
      successfulSubmission: true,
    });
    const result = await box.run([...START, "--wait", "--timeout", "400ms"]);
    expect(result.code).toBe(0);
  });

  test.each(["--prompt", "--environment"])(
    "locally known changed %s is refused before sending and preserves its saved digest",
    async (field) => {
      const { box, starts } = await lostStart([finished, finished], [finished]);
      expect((await box.run([...START, "--wait"])).code).toBe(0);
      const changed = [...START];
      changed[changed.indexOf(field) + 1] = "changed";
      const result = await box.run([...changed, "--wait"]);
      expect(JSON.parse(result.out).error.code).toBe("request-conflict");
      expect(starts()).toBe(1);
      expect((await box.run([...START, "--wait"])).code).toBe(0);
      expect(starts()).toBe(2);
    },
  );

  test("without --wait a lost response is reported, not looked up", async () => {
    const { box, lookups } = await lostStart([finished], [finished]);
    const result = await box.run(START);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.code).toBe("transport-uncertain");
    expect(lookups).toHaveLength(0);
  });
});

describe("transcript following", () => {
  test("streams each new message once as JSONL and flags gaps", async () => {
    const page = (ids: string[], token: string) => ({
      sessionId: "ses_eA",
      order: "oldest-first",
      messages: ids.map((id) => ({
        id,
        role: "assistant",
        createdAt: null,
        text: `text ${id}`,
        textTruncated: false,
        parts: [],
      })),
      complete: true,
      truncated: false,
      token,
      historyEpoch: "e",
      freshness: "current",
    });
    const pages = [
      page(["a", "b"], "t1"),
      page(["a", "b"], "t1"),
      page(["a", "b", "c"], "t2"),
      page(["x", "y"], "t3"),
    ];
    const { box } = await fixture([], {
      "session.transcript": (call) => pages[Math.min(call - 1, pages.length - 1)],
    });
    const result = await box.run([
      "--jsonl",
      "session",
      "transcript",
      "ses_eA",
      "--follow",
      "--timeout",
      "3s",
    ]);
    expect(result.code).toBe(0);
    const records = result.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const messages = records
      .filter((record) => record.type === "message")
      .map((record) => record.message.id);
    expect(messages).toEqual(["a", "b", "c", "x", "y"]);
    expect(records.some((record) => record.type === "gap")).toBe(true);
    expect(records.at(-1)).toMatchObject({ ok: true, action: "session.transcript" });
  });
});
