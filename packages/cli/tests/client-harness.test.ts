import { afterEach, expect, test } from "bun:test";
import { startFakeGateway, type FakeGateway } from "./support/client-harness";

let gateway: FakeGateway | undefined;
afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
});

// A port the OS hands back can still be remembered by another suite's client.
// The fake gateway must refuse that client's request instead of throwing on
// it, which Bun reports as a failure of whichever test is running.
test("the fake gateway refuses a stray request without recording or throwing", async () => {
  gateway = await startFakeGateway();
  const stray = await fetch(`${gateway.url}/api/event`);
  expect(stray.status).toBe(404);
  const wrongMethod = await fetch(`${gateway.url}/__orkestrator/invoke`);
  expect(wrongMethod.status).toBe(404);
  expect(gateway.requests).toEqual([]);
});
