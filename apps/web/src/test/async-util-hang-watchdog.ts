import { afterEach, beforeEach } from "bun:test";
import { configure, getConfig } from "@testing-library/react";

/**
 * Testing Library's `waitFor` and `findBy*` give up after one second, which an
 * aggregate run starves past while the component under test is merely queued
 * behind other workers (a Radix focus hand-off, a mocked backend promise, a
 * React Flow mount). In the suites that call this, every such wait is for a
 * state the component will reach, so the deadline is a hang watchdog: far
 * beyond any loaded host, below the test budget (`tests/default-test-timeout.ts`).
 * What a test asserts is still decided by the signal it waits for, never by
 * how long the host took.
 *
 * Call it once at the top of a test file (or `describe`); the wait budget is
 * scoped to each test and restored afterwards, as `useAnnotationUiTestBudget`
 * does.
 */
export const ASYNC_UTIL_HANG_WATCHDOG_MS = 30_000;

export function useAsyncUtilHangWatchdog(timeoutMs = ASYNC_UTIL_HANG_WATCHDOG_MS) {
  let previous = getConfig().asyncUtilTimeout;
  beforeEach(() => {
    previous = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: timeoutMs });
  });
  afterEach(() => {
    configure({ asyncUtilTimeout: previous });
  });
}
