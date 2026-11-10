import { afterEach, expect, test } from "bun:test";
import { publicSuccessEnvelope } from "@orkestrator/protocol/public-api";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const box = await createSandbox();
  const gateway = await startFakeGateway((request) => {
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
