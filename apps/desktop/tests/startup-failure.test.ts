import { describe, expect, mock, test } from "bun:test";
import { createStartupFailureReporter } from "../electron/startup-failure";
import { handleStartupFailure } from "../electron/quit-policy";

function harness(agentTest: boolean) {
  let answer!: () => void;
  const showMessageBox = mock(
    (_source: string, _options: Electron.MessageBoxOptions) =>
      new Promise<Electron.MessageBoxReturnValue>((resolve) => {
        answer = () => resolve({ response: 0, checkboxChecked: false });
      }),
  );
  const logError = mock((_message: string, _error: unknown) => undefined);
  const quit = mock(() => undefined);
  const report = createStartupFailureReporter({
    agentTest,
    productName: "Orkestrator",
    dialogs: { showMessageBox },
    logError,
  });
  return {
    showMessageBox,
    logError,
    quit,
    answer: () => answer(),
    fail: (error: unknown) =>
      handleStartupFailure({
        error,
        isQuitting: () => false,
        report,
        quit,
      }),
  };
}

describe("startup failure reporting", () => {
  test("an agent-test profile logs and quits without waiting for a dialog", async () => {
    const run = harness(true);
    const error = new Error("Backend failed");
    run.fail(error);
    await Bun.sleep(0);
    expect(run.logError).toHaveBeenCalledWith("[Desktop] Startup failed:", error);
    expect(run.showMessageBox).not.toHaveBeenCalled();
    expect(run.quit).toHaveBeenCalledTimes(1);
  });

  test.each([new Error("Backend failed"), "Backend failed"])(
    "an interactive profile logs, shows the failure and waits for OK (%p)",
    async (error) => {
      const run = harness(false);
      run.fail(error);
      expect(run.logError).toHaveBeenCalledWith("[Desktop] Startup failed:", error);
      expect(run.showMessageBox).toHaveBeenCalledWith("startup-failure", {
        type: "error",
        title: "Orkestrator failed to start",
        message: "Orkestrator failed to start",
        detail: "Backend failed",
        buttons: ["OK"],
      });
      expect(run.quit).not.toHaveBeenCalled();
      run.answer();
      await Bun.sleep(0);
      expect(run.quit).toHaveBeenCalledTimes(1);
    },
  );
});
