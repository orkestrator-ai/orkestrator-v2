import { afterEach, describe, expect, mock, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { createReactRootErrorOptions } from "./react-root-errors";
import { rendererErrorRing } from "./renderer-error-ring";

describe("React root error diagnostics", () => {
  let logs: LogCapture | undefined;
  afterEach(() => logs?.restore());

  test("does not classify an error React recovered from as a startup failure", () => {
    logs = captureLogs();
    const reportStartupError = mock(() => undefined);
    const options = createReactRootErrorOptions({ reportStartupError });

    options.onRecoverableError?.(new Error("recovered"), { componentStack: "\n  at Panel" });

    expect(reportStartupError).not.toHaveBeenCalled();
    const [record] = logs.records();
    expect(record).toMatchObject({
      level: "error",
      area: "web.react",
      event: "root.recoverable-error",
      fields: { error: { message: "recovered" }, componentStack: "\n  at Panel" },
    });
  });

  test("reports caught and uncaught root failures while startup is active", () => {
    logs = captureLogs();
    const reportStartupError = mock(() => undefined);
    const options = createReactRootErrorOptions({ reportStartupError });

    options.onCaughtError?.(new Error("caught"), { componentStack: "" });
    options.onUncaughtError?.(new Error("uncaught"), { componentStack: "" });

    expect(reportStartupError).toHaveBeenCalledTimes(2);
    expect(logs.records().map(({ event }) => event)).toEqual([
      "root.caught-error",
      "root.uncaught-error",
    ]);
  });

  test("puts every caught failure in the error ring under the boundary that caught it", () => {
    logs = captureLogs();
    const options = createReactRootErrorOptions();
    rendererErrorRing.takeUnsent(Number.MAX_SAFE_INTEGER);
    class Boundary {
      static readonly diagnosticBoundary = "message-row";
    }

    options.onCaughtError?.(new TypeError("transcript text"), {
      componentStack: "\n    at Row (/Users/someone/Row.tsx:1:1)",
      errorBoundary: new Boundary() as never,
    });
    options.onUncaughtError?.(new Error("uncaught"), { componentStack: "" });
    options.onRecoverableError?.(new Error("recovered"), { componentStack: "" });

    const recorded = rendererErrorRing.takeUnsent(Number.MAX_SAFE_INTEGER);
    expect(recorded.map(({ boundary }) => boundary)).toEqual([
      "message-row",
      "root",
      "recoverable",
    ]);
    expect(JSON.stringify(recorded)).not.toContain("transcript");
    expect(JSON.stringify(recorded)).not.toContain("someone");
  });
});
