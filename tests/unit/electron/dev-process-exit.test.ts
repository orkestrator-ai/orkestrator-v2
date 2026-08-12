import { describe, expect, mock, test } from "bun:test";
import { handleElectronExit } from "../../../apps/desktop/electron/dev-process-exit";

function harness() {
  return {
    logError: mock((_message: string) => undefined),
    shutdown: mock((_code: number) => undefined),
  };
}

describe("handleElectronExit", () => {
  test("shuts down successfully without logging after a clean exit", () => {
    const handlers = harness();

    handleElectronExit(0, null, handlers);

    expect(handlers.logError).not.toHaveBeenCalled();
    expect(handlers.shutdown).toHaveBeenCalledWith(0);
  });

  test("reports and preserves a nonzero exit code", () => {
    const handlers = harness();

    handleElectronExit(23, null, handlers);

    expect(handlers.logError).toHaveBeenCalledWith("Electron exited with code 23");
    expect(handlers.shutdown).toHaveBeenCalledWith(23);
  });

  test("reports a signal and maps it to failure", () => {
    const handlers = harness();

    handleElectronExit(null, "SIGTERM", handlers);

    expect(handlers.logError).toHaveBeenCalledWith("Electron exited with signal SIGTERM");
    expect(handlers.shutdown).toHaveBeenCalledWith(1);
  });
});
