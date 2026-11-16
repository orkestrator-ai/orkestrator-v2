import { expect, test } from "bun:test";
import { captureUntilObserving } from "../scenarios/harness.js";

/**
 * The scenario `client-exit` interrupts a `--wait` client only once it says it
 * is observing (flake 9869), never on a timer.
 */

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test("signals once when the observing record arrives, even split across chunks", async () => {
  let signals = 0;
  const record = JSON.stringify({
    type: "observing",
    action: "environment.start",
    operationId: "op-1",
  });
  const captured = await captureUntilObserving(
    streamOf(["warning: slow\n", record.slice(0, 10), `${record.slice(10)}\n`, `${record}\n`]),
    () => {
      signals += 1;
    },
  );
  expect(signals).toBe(1);
  expect(captured).toBe(`warning: slow\n${record}\n${record}\n`);
});

test("never signals when the client exits before observing", async () => {
  let signals = 0;
  const captured = await captureUntilObserving(
    streamOf(['{"type":"other"}\n', "{not json\n", "error [busy]: try later\n"]),
    () => {
      signals += 1;
    },
  );
  expect(signals).toBe(0);
  expect(captured).toContain("error [busy]");
});
