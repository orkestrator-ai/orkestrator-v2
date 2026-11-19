// The state revision's harness (to-do 8102 task 2, design D7): every mutation
// path these tests drive must move the revision the observe stream carries
// whenever it changes what the backend's state read returns (`/status`,
// `/config`, `/approvals`, `/interactions`). Driven through the real runtime
// with the scripted app-server.
import { describe, expect, test } from "bun:test";
import {
  BridgeStateRevisions,
  expectStateRevisionMoves,
} from "@orkestrator/protocol/node/bridge-state-revision";
import { harness, threadPayload } from "./app-server-runtime-test-harness.js";
import { codexStateRevisionContent, noteEmittedEvent } from "./state-revision.js";

async function revisionHarness() {
  const revisions = new BridgeStateRevisions({ generation: "test" });
  const h = await harness(
    {
      "thread/start": () => ({ thread: threadPayload("thread-1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    },
    { onEmit: (event) => noteEmittedEvent(event, revisions) },
  );
  const { sessionId } = h.runtime.createSession({ mode: "build" });
  /** What the backend's state read gets, as the status route digests it (no touch). */
  const read = () => {
    const status = h.runtime.getStatus(sessionId, false);
    return status ? codexStateRevisionContent(h.runtime, sessionId, status) : null;
  };
  const changed: string[] = [];
  const check = async (label: string, mutate: () => unknown | Promise<unknown>) => {
    const outcome = await expectStateRevisionMoves({
      label,
      read,
      peek: () => revisions.peek(sessionId),
      mutate: async () => {
        await mutate();
        await h.drain();
      },
    });
    if (outcome.changed) changed.push(label);
    return outcome;
  };
  return { h, sessionId, revisions, check, changed, read };
}

describe("Codex state revision", () => {
  test("every driven mutation that changes the state read moves the revision", async () => {
    const { h, sessionId, check, changed } = await revisionHarness();

    await check("prompt start", () =>
      h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] }),
    );
    const streamed = await check("streamed delta", () =>
      h.child().notify("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "Hello",
      }),
    );
    // A delta is the transcript's: the state read does not see it.
    expect(streamed.changed).toBe(false);

    await check("approval requested", () =>
      h.child().stdout.pushMessage({
        jsonrpc: "2.0",
        id: 9001,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: 1,
          command: "rm -rf build",
          cwd: "/tmp/ws",
        },
      }),
    );
    const [approval] = h.runtime.listApprovals(sessionId);
    expect(approval).toBeDefined();
    await check("approval held", () =>
      h.runtime.holdApproval(sessionId, approval!.approvalId, true),
    );
    await check("approval answered", () =>
      h.runtime.respondToApproval(sessionId, approval!.approvalId, "deny"),
    );

    await check("turn completed", () =>
      h.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      }),
    );
    await check("mode changed", () => h.runtime.updateConfig(sessionId, { mode: "plan" }));
    await check("title", () => h.runtime.setSessionTitle(sessionId, "Renamed"));

    expect(changed).toEqual(
      expect.arrayContaining([
        "prompt start",
        "approval requested",
        "approval held",
        "approval answered",
        "turn completed",
        "mode changed",
      ]),
    );
  });
});
