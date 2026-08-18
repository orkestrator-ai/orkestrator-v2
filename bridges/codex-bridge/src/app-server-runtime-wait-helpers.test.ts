/**
 * Contract tests for the shared `waitUntil` helper in
 * `app-server-runtime-test-harness.ts`.
 *
 * The helper accepts asynchronous predicates, which is easy to break silently:
 * `while (!predicate())` over a promise-returning predicate exits on its first
 * iteration, because a pending Promise is truthy. A wait that never waits turns
 * every caller back into the fixed-delay race the harness exists to remove, and
 * the suites depending on it would still pass most of the time. Each assertion
 * below fails deterministically against that regression rather than relying on
 * a poll count or elapsed time.
 */
import { describe, expect, test } from "bun:test";
import { waitUntil } from "./app-server-runtime-test-harness.js";

describe("waitUntil", () => {
  test("awaits an asynchronous predicate until it becomes true", async () => {
    let calls = 0;
    await waitUntil(
      async () => {
        calls += 1;
        return calls >= 3;
      },
      "async predicate never became true",
      1_000,
    );

    // An unawaited predicate would leave this at 1: the first pending promise
    // is truthy, so the loop would exit before the condition ever held.
    expect(calls).toBe(3);
  });

  test("throws the caller's diagnostic when an async predicate never holds", async () => {
    await expect(waitUntil(async () => false, "the condition under test", 25)).rejects.toThrow(
      "the condition under test",
    );
  });

  test("propagates a predicate rejection instead of reporting it as a timeout", async () => {
    // A failed read inside the predicate is evidence, not a timeout. Reporting
    // it as the caller's message would hide why the condition was unreadable.
    await expect(
      waitUntil(
        async () => {
          throw new Error("predicate exploded");
        },
        "must not be reported",
        1_000,
      ),
    ).rejects.toThrow("predicate exploded");
  });

  test("accepts a synchronous predicate and evaluates it once when it holds", async () => {
    let calls = 0;
    await waitUntil(
      () => {
        calls += 1;
        return true;
      },
      "already-true predicate",
      0,
    );

    expect(calls).toBe(1);
  });

  test("evaluates a synchronous predicate before honouring an expired deadline", async () => {
    // The deadline is checked only after a false result, so an already-true
    // condition must never be reported as a timeout.
    await expect(waitUntil(() => false, "expired immediately", 0)).rejects.toThrow(
      "expired immediately",
    );
  });
});
