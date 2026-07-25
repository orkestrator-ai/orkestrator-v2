import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import { NativeStructuredReviewResult } from "./NativeStructuredReviewResult";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const validResult: StructuredOutputResult<unknown> = {
  ok: true,
  provider: "codex",
  value: TEST_STRUCTURED_REVIEW_REPORT,
};

describe("NativeStructuredReviewResult", () => {
  test("shows a loading state without reading the result channel", () => {
    const loadResult = mock(async () => validResult);
    render(
      <NativeStructuredReviewResult
        enabled
        sessionId="session-1"
        isLoading
        loadResult={loadResult}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Waiting for validated structured review",
    );
    expect(loadResult).not.toHaveBeenCalled();
  });

  test("surfaces a malformed successful payload as a retryable validation error", async () => {
    const loadResult = mock(async (): Promise<StructuredOutputResult<unknown>> => ({
      ok: true,
      provider: "claude",
      value: { issues: [] },
    }));
    render(
      <NativeStructuredReviewResult
        enabled
        sessionId="session-1"
        isLoading={false}
        loadResult={loadResult}
        onRetry={() => {}}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Structured review failed");
    expect(alert.textContent).toContain("reviewScope");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("waits for retry dispatch before loading the replacement result", async () => {
    const retryDispatch = deferred<void>();
    const loadResult = mock(async (): Promise<StructuredOutputResult<unknown>> => {
      if (loadResult.mock.calls.length === 1) {
        return {
          ok: false,
          provider: "opencode",
          error: {
            code: "schema_retry_exhausted",
            message: "Schema retries exhausted",
            provider: "opencode",
            retryable: true,
          },
        };
      }
      return validResult;
    });
    const onRetry = mock(() => retryDispatch.promise);
    render(
      <NativeStructuredReviewResult
        enabled
        sessionId="session-1"
        isLoading={false}
        loadResult={loadResult}
        onRetry={onRetry}
      />,
    );

    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(loadResult).toHaveBeenCalledTimes(1);

    retryDispatch.resolve();
    await waitFor(() => {
      expect(loadResult).toHaveBeenCalledTimes(2);
      expect(
        screen.getByRole("heading", { name: "Structured review report" }),
      ).toBeTruthy();
    });
  });

  test("ignores a stale request result in the same session and renders only the replacement", async () => {
    const stale = deferred<StructuredOutputResult<unknown> | null>();
    const replacement = deferred<StructuredOutputResult<unknown> | null>();
    const loadResult = mock(() =>
      loadResult.mock.calls.length === 1 ? stale.promise : replacement.promise
    );
    const view = render(
      <NativeStructuredReviewResult
        enabled
        sessionId="session-1"
        resultKey="request-old"
        isLoading={false}
        loadResult={loadResult}
        onRetry={() => {}}
      />,
    );
    await waitFor(() => expect(loadResult).toHaveBeenCalledTimes(1));

    view.rerender(
      <NativeStructuredReviewResult
        enabled
        sessionId="session-1"
        resultKey="request-new"
        isLoading={false}
        loadResult={loadResult}
        onRetry={() => {}}
      />,
    );
    await waitFor(() => expect(loadResult).toHaveBeenCalledTimes(2));

    stale.resolve({
      ok: false,
      provider: "claude",
      error: {
        code: "malformed_output",
        message: "stale malformed result",
        provider: "claude",
        retryable: true,
      },
    });
    replacement.resolve(validResult);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Structured review report" }),
      ).toBeTruthy();
    });
    expect(screen.queryByText("stale malformed result")).toBeNull();
  });
});
