import { expect, test } from "bun:test";
import { terminalFlood } from "../scripts/gateway-frame-costs";

test("a real stalled TCP peer resumes ordered output without desyncing the quiet channel", async () => {
  const result = await terminalFlood();
  expect(result.socketClosed).toBe(false);
  expect(result.quietDesyncs).toBe(0);
  expect(result.noisyDesyncs).toBe(1);
  expect(result.quietFramesDelivered).toBe(result.quietFramesEmitted);
  expect(result.quietFramesDelivered).toBe(32);
  expect(result.noisyFramesDelivered).toBeGreaterThan(0);
  expect(result.noisyInOrder).toBe(true);
  expect(result.quietInOrder).toBe(true);
  expect(result.peakQueuedBytes).toBeLessThan(1024 * 1024);
}, 15_000);
