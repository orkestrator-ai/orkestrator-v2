import { expect, test } from "bun:test";
import { harness } from "./app-server-runtime-test-harness.js";

test("streamed command output invalidates the activity revision before the command completes", async () => {
  const h = await harness();
  const { sessionId } = h.runtime.createSession({ mode: "build" });
  await h.runtime.prompt(sessionId, { prompt: "run", requestId: "req-output", attachments: [] });
  h.child().notify("item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "shell-1",
      type: "commandExecution",
      command: "login",
      status: "inProgress",
      aggregatedOutput: "",
    },
  });
  await h.drain();
  let previous = h.runtime.getActivitySnapshot(sessionId).contentRevision;
  expect(typeof previous).toBe("string");
  for (const delta of ["https://github.com/login/device\n", "Press ENTER"]) {
    h.child().notify("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "shell-1",
      delta,
    });
    await h.drain();
    const snapshot = h.runtime.getActivitySnapshot(sessionId);
    expect(snapshot.activity).toBe("working");
    expect(snapshot.contentRevision).not.toBe(previous);
    expect(h.runtime.getActivitySnapshot(sessionId).contentRevision).toBe(snapshot.contentRevision);
    expect(JSON.stringify(h.runtime.humanPromptOutput(sessionId))).toContain(delta.trim());
    previous = snapshot.contentRevision;
  }
});
