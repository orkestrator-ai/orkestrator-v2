import { afterEach, expect, test } from "bun:test";
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
  type RecordedRequest,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(respond?: (request: RecordedRequest) => Response | undefined) {
  const box = await createSandbox({ virtualClock: true });
  const gateway = await startFakeGateway((request) => {
    const override = respond?.(request);
    if (override) return override;
    const action = String(request.body.args.action);
    if (action === "session.branches")
      return envelope(
        publicSuccessEnvelope(action, {
          activeEntryId: "current",
          items: [
            { id: "old-leaf", prompt: "Earlier prompt", entries: 4, updatedAt: "2026-11-09" },
          ],
          truncated: false,
        }),
      );
    const input = request.body.args.input as { summarize?: unknown } | undefined;
    if (action === "session.branch" && input?.summarize === true)
      return envelope(publicSuccessEnvelope(action, { sessionId: "s", summarized: true }));
    if (action === "session.rewind" || action === "session.branch")
      return envelope(publicSuccessEnvelope(action, { sessionId: "s" }));
    return defaultResponder()(request);
  });
  cleanups.push(
    () => gateway.stop(),
    () => box.cleanup(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return { box, gateway };
}

test("rewind requires --message and forwards its ID and request key", async () => {
  const { box, gateway } = await fixture();
  const before = gateway.requests.length;
  expect((await box.run(["session", "rewind", "s"])).code).toBe(2);
  expect(gateway.requests).toHaveLength(before);
  expect(
    (
      await box.run([
        "session",
        "rewind",
        "s",
        "--message",
        "prompt-id",
        "--request-id",
        "rewind-key",
      ])
    ).code,
  ).toBe(0);
  const writes = gateway.requests.filter((r) => r.body.args.action === "session.rewind");
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body.args.input).toEqual({ sessionId: "s", messageId: "prompt-id" });
  expect(writes[0]!.body.args.request).toMatchObject({ requestId: "rewind-key" });
});

test("branch forwards the entry positional argument as entryId", async () => {
  const { box, gateway } = await fixture();
  expect(
    (await box.run(["session", "branch", "s", "old-leaf", "--request-id", "branch-key"])).code,
  ).toBe(0);
  const writes = gateway.requests.filter((r) => r.body.args.action === "session.branch");
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body.args.input).toEqual({ sessionId: "s", entryId: "old-leaf" });
});

test("branch --summarize asks for a summary and says one was kept", async () => {
  const { box, gateway } = await fixture();
  const run = await box.run(["session", "branch", "s", "old-leaf", "--summarize"]);
  expect(run.code).toBe(0);
  expect(run.out).toContain("keeping a summary of the branch left");
  const writes = gateway.requests.filter((r) => r.body.args.action === "session.branch");
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body.args.input).toEqual({
    sessionId: "s",
    entryId: "old-leaf",
    summarize: true,
  });
});

test.each([false, true])("observes a summary beyond 60 seconds (routed=%s)", async (routed) => {
  const leaf = "bk_studio";
  const result = { sessionId: "s", entryId: "old-leaf", summarized: true };
  const running: PublicReceipt = {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    action: "session.branch",
    state: "running",
    stage: "switching",
    result: {},
  };
  let elapsed = () => 0;
  const { box, gateway } = await fixture(({ body: { args } }) => {
    if (args.action === "session.branch") {
      if (routed) {
        return envelope({
          ...publicErrorEnvelope("session.branch", {
            code: "node-outcome-unknown",
            message: "Leaf reply lost",
            details: { nodeId: leaf },
          }),
          node: { nodeId: leaf, name: "Studio" },
        });
      }
      return envelope(publicSuccessEnvelope("session.branch", {}, running));
    }
    if (args.action === "run.get") {
      const receipt: PublicReceipt =
        elapsed() > 60_000 ? { ...running, state: "succeeded", result } : running;
      return envelope(publicSuccessEnvelope("run.get", receipt.result, receipt));
    }
    return undefined;
  });
  elapsed = () => box.sleeps.reduce((total, ms) => total + ms, 0);
  const run = await box.run([
    ...(routed ? ["--node", leaf] : []),
    "session",
    "branch",
    "s",
    "old-leaf",
    "--summarize",
    "--request-id",
    "slow-branch",
  ]);
  expect(run.code).toBe(0);
  expect(run.out).toContain("keeping a summary of the branch left");
  expect(elapsed()).toBeGreaterThan(60_000);
  expect(
    gateway.requests.filter((request) => request.body.args.action === "session.branch"),
  ).toHaveLength(1);
  const polls = gateway.requests.filter((request) => request.body.args.action === "run.get");
  if (routed) {
    expect(polls[0]?.body.args).toMatchObject({
      node: leaf,
      input: {
        requestId: "slow-branch",
        action: "session.branch",
      },
    });
    expect(polls.every((request) => request.body.args.node === leaf)).toBe(true);
  }
  expect(polls.at(-1)?.body.args.input).toEqual({ operationId: running.operationId });
});

test("a failed summary recovered by request key is reported as a failure", async () => {
  const leaf = "bk_studio";
  const error = { code: "operation-failed" as const, message: "The branch stayed where it was" };
  const receipt: PublicReceipt = {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    action: "session.branch",
    state: "failed",
    error,
  };
  const { box, gateway } = await fixture(({ body: { args } }) => {
    if (args.action === "session.branch") {
      return envelope(
        publicErrorEnvelope("session.branch", {
          code: "node-outcome-unknown",
          message: "Leaf reply lost",
          details: { nodeId: leaf },
        }),
      );
    }
    if (args.action === "run.get") {
      return envelope(publicSuccessEnvelope("run.get", null, receipt));
    }
    return undefined;
  });
  const run = await box.run(["--node", leaf, "session", "branch", "s", "old-leaf", "--summarize"]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(error.message);
  expect(gateway.requests.filter((request) => request.body.args.action === "run.get")).toHaveLength(
    1,
  );
});

test("branches prints a table or entry IDs", async () => {
  const { box } = await fixture();
  const human = await box.run(["session", "branches", "s"]);
  expect(human.code).toBe(0);
  for (const text of [
    "ENTRY ID",
    "PROMPT",
    "ENTRIES",
    "UPDATED",
    "old-leaf",
    "Earlier prompt",
    "4",
    "2026-11-09",
  ])
    expect(human.out).toContain(text);
  const ids = await box.run(["session", "branches", "s", "--output", "id"]);
  expect(ids.code).toBe(0);
  expect(ids.out.trim()).toBe("old-leaf");
});
