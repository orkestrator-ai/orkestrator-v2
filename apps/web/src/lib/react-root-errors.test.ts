import { afterEach, describe, expect, mock, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { createReactRootErrorOptions } from "./react-root-errors";

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
});
