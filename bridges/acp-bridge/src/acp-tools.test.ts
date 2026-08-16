import { describe, expect, test } from "bun:test";

import {
  MAX_WAIT_DIAGNOSTIC_BYTES,
  codedError,
  isRetryableWaitError,
  nativeFetch,
  unusedPort,
  waitFor,
} from "./acp-test-harness.js";


describe("waitFor", () => {
  test("retries ConnectionRefused until the read succeeds", async () => {
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts < 3) throw codedError("ConnectionRefused");
      return { ready: true };
    }, (current) => current.ready);
    expect(value).toEqual({ ready: true });
    expect(attempts).toBe(3);
  });

  test("retries ECONNREFUSED until the read succeeds", async () => {
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts < 2) throw codedError("ECONNREFUSED");
      return "up";
    }, (current) => current === "up");
    expect(value).toBe("up");
    expect(attempts).toBe(2);
  });

  test("retries a real Bun fetch connection failure until the read succeeds", async () => {
    const port = await unusedPort();
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts >= 3) return "recovered";
      // `unusedPort` releases the port before returning, so a parallel worker
      // could in principle bind it between then and now. Convert that into an
      // explicit non-retryable error, which `waitFor` rethrows on the spot and
      // names, instead of letting it surface as a bare `expect(1).toBe(3)`.
      // Reaching attempt 3 therefore also proves Bun's own error shape is what
      // `isRetryableWaitError` classifies as retryable.
      throw await nativeFetch(`http://127.0.0.1:${port}/health`).then(
        () => new Error(`Expected 127.0.0.1:${port} to refuse the connection, but it answered`),
        (reason: unknown) => reason,
      );
    }, (current) => current === "recovered");
    expect(value).toBe("recovered");
    expect(attempts).toBe(3);
  });

  test("polls until accept is satisfied and returns the accepted value", async () => {
    let reads = 0;
    const value = await waitFor(async () => {
      reads += 1;
      return { status: reads < 3 ? "running" : "idle" };
    }, (current) => current.status === "idle");
    expect(value).toEqual({ status: "idle" });
    expect(reads).toBe(3);
  });

  test("rethrows a non-retryable coded error on the first attempt", async () => {
    const error = codedError("EPERM");
    let attempts = 0;
    await expect(waitFor(async () => {
      attempts += 1;
      throw error;
    }, () => true)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("rethrows errors that have no code on the first attempt", async () => {
    const error = new Error("parse failed");
    let attempts = 0;
    await expect(waitFor(async () => {
      attempts += 1;
      throw error;
    }, () => true)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("rethrows non-object rejections on the first attempt", async () => {
    // `isRetryableWaitError` reads `error.code`, so a bare string that merely
    // *names* a retryable code — and a nullish rejection — must fail fast
    // rather than spin until the deadline.
    for (const rejection of ["ConnectionRefused", null]) {
      let attempts = 0;
      await expect(waitFor(async () => {
        attempts += 1;
        throw rejection;
      }, () => true)).rejects.toBe(rejection);
      expect(attempts).toBe(1);
    }
  });

  test("times out when ConnectionRefused never recovers and names the code", async () => {
    let attempts = 0;
    // 400 ms rather than a value just above the 20 ms poll interval: the
    // assertion below is about retrying, and one scheduler stall on a loaded
    // parallel run must not be able to consume the budget before attempt two.
    await expect(waitFor(async () => {
      attempts += 1;
      throw codedError("ConnectionRefused");
    }, () => true, 400)).rejects.toThrow(
      "Timed out waiting for ACP state: undefined (last error: ConnectionRefused)",
    );
    expect(attempts).toBeGreaterThan(1);
  });

  test("reports the last read value when accept is never satisfied", async () => {
    await expect(waitFor(
      async () => ({ status: "running" }),
      (current) => current.status === "idle",
      200,
    )).rejects.toThrow('Timed out waiting for ACP state: {"status":"running"}');
  });

  test("truncates an oversized diagnostic instead of logging the whole snapshot", async () => {
    const oversized = "x".repeat(MAX_WAIT_DIAGNOSTIC_BYTES * 2);
    const rejection = await waitFor(async () => oversized, () => false, 200)
      .then(() => null, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    const { message } = rejection as Error;
    expect(message).toContain("chars, truncated)");
    expect(message.length).toBeLessThan(oversized.length);
  });
});
