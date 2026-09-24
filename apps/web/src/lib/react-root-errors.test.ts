import { describe, expect, mock, test } from "bun:test";
import { createReactRootErrorOptions } from "./react-root-errors";

describe("React root error diagnostics", () => {
  test("does not classify an error React recovered from as a startup failure", () => {
    const reportStartupError = mock(() => undefined);
    const logError = mock((..._values: unknown[]) => undefined);
    const options = createReactRootErrorOptions({ reportStartupError, logError });

    options.onRecoverableError?.(new Error("recovered"), { componentStack: "" });

    expect(reportStartupError).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "[ReactRoot] Recoverable error",
      expect.objectContaining({ message: "recovered" }),
    );
  });

  test("reports caught and uncaught root failures while startup is active", () => {
    const reportStartupError = mock(() => undefined);
    const options = createReactRootErrorOptions({
      reportStartupError,
      logError: mock(() => undefined),
    });

    options.onCaughtError?.(new Error("caught"), { componentStack: "" });
    options.onUncaughtError?.(new Error("uncaught"), { componentStack: "" });

    expect(reportStartupError).toHaveBeenCalledTimes(2);
  });
});
