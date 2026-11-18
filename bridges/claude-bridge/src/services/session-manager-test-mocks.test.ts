import { describe, expect, test } from "bun:test";
import { mockQuery, nextQueryCall, queryControlOverrides } from "./session-manager-test-harness.js";

describe("mock query consumption", () => {
  test("settles consumption on failure with unread frames", async () => {
    const query = mockQuery({ prompt: "test", options: {} });
    const call = await nextQueryCall();
    const failure = new Error("stream failed");
    call.push({ type: "assistant" });
    const consumed = call.consumed();
    call.fail(failure);

    await expect(query.next()).rejects.toThrow(failure);
    await consumed;
    await call.consumed();
  });

  test("settles consumption when the consumer returns with unread frames", async () => {
    const query = mockQuery({ prompt: "test", options: {} });
    const call = await nextQueryCall();
    call.push({ type: "assistant" });
    call.push({ type: "result" });
    expect((await query.next()).done).toBe(false);
    const consumed = call.consumed();

    await query.return(undefined);
    await consumed;
    await call.consumed();
  });

  test("settles consumption when a parked consumer receives a failure", async () => {
    const query = mockQuery({ prompt: "test", options: {} });
    const call = await nextQueryCall();
    const next = query.next();
    await call.consumed();

    call.fail(new Error("stream failed"));
    const consumed = call.consumed();
    await expect(next).rejects.toThrow("stream failed");
    await consumed;
    await call.consumed();
  });

  for (const end of ["finish", "abort"] as const) {
    test(`waits for a parked consumer to observe ${end}`, async () => {
      const abortController = new AbortController();
      const finalizing = Promise.withResolvers<void>();
      const allowExit = Promise.withResolvers<void>();
      queryControlOverrides.beforeExit = () => {
        finalizing.resolve();
        return allowExit.promise;
      };
      const query = mockQuery({ prompt: "test", options: { abortController } });
      const call = await nextQueryCall();
      const next = query.next();
      await call.consumed();

      if (end === "finish") call.finish();
      else abortController.abort();
      let settled = false;
      const consumed = call.consumed().then(() => {
        settled = true;
      });
      try {
        await finalizing.promise;
        expect(settled).toBe(false);
      } finally {
        allowExit.resolve();
        await next;
      }
      await consumed;
      expect((await next).done).toBe(true);
      await call.consumed();
    });
  }
});
