import { afterEach, describe, expect, test } from "bun:test";
import {
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

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
  async function lostStart(byKey: Array<PublicReceipt | null>, byId: PublicReceipt[]) {
    const box = await createSandbox();
    const lookups: Array<Record<string, unknown>> = [];
    let starts = 0;
    const gateway = await startFakeGateway((request) => {
      const action = String(request.body.args.action);
      const input = request.body.args.input as Record<string, unknown>;
      if (action === "session.start") {
        starts += 1;
        return new Response("upstream timeout", { status: 504 });
      }
      if (action === "run.get" && input.requestId !== undefined) {
        lookups.push(input);
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
