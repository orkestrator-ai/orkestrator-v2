import { expect, test } from "bun:test";
import { newSessionState } from "./agent-session.js";
import { followRun } from "./prompt.js";
import { ABANDONED_COMPACTION_NOTE, applyInteractionUpdate } from "./translate.js";
import { fakeAgent } from "./testing/fake-agent.js";
import { deferred, waitFor } from "./testing/router-harness.js";

test("a compaction timeout cancels the run and fails its boundary after acknowledgement", async () => {
  const state = newSessionState();
  state.status = "running";
  state.promptSequence = 1;
  applyInteractionUpdate(state, { type: "summary-started" });
  const gate = deferred<void>();
  const agent = fakeAgent({ hold: gate.promise, result: "discard this unfinished summary" });
  const run = await agent.summarize();
  const completion = followRun(
    state,
    run,
    state.promptSequence,
    { prompt: "", images: [], compaction: true },
    5,
  );
  try {
    await waitFor(() => agent.cancels === 1);
    expect(state.status).toBe("running");
    expect(state.error).toContain("time budget");
    expect(state.messages.flatMap((row) => row.parts)).toMatchObject([
      { type: "compaction", toolState: "pending" },
    ]);
    gate.resolve();
    await completion;
    expect(state.status).toBe("idle");
    expect(state.messages.flatMap((row) => row.parts)).toMatchObject([
      { type: "compaction", toolState: "failure", content: ABANDONED_COMPACTION_NOTE },
    ]);
    expect(state.messages.every((row) => row.content === "")).toBe(true);
  } finally {
    gate.resolve();
    await completion;
  }
});
