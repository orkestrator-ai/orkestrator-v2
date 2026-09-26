import { afterEach, describe, expect, test } from "bun:test";
import { publicSuccessEnvelope, type PublicReceipt } from "@orkestrator/protocol/public-api";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/public-api-fixtures";
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
