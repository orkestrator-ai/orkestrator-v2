import { describe, expect, mock, test } from "bun:test";
import { installRendererDiagnostics } from "../../../apps/desktop/electron/renderer-diagnostics";

function harness() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const log = mock((_message: string) => {});
  const mainFrame = { name: "main" };
  installRendererDiagnostics(
    {
      mainFrame,
      on: (name: string, callback: (...args: any[]) => void) => {
        handlers.set(name, callback);
      },
    } as never,
    log,
  );
  return {
    log,
    mainFrame,
    emit: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
  };
}

describe("renderer startup diagnostics", () => {
  test("records preload failures without persisting private error data", () => {
    const { emit, log } = harness();
    const error = Object.assign(new Error("secret file contents /private/path"), {
      code: "ERR_REQUIRE_ESM",
    });
    emit("preload-error", {}, "/private/preload.js", error);
    expect(log).toHaveBeenCalledWith("[DesktopStartup] preload-failed reason=module-format");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  test.each([
    ["ENOENT", "Error", "module-missing"],
    ["MODULE_NOT_FOUND", "Error", "module-missing"],
    ["ERR_MODULE_NOT_FOUND", "Error", "module-missing"],
    ["EACCES", "Error", "permission-denied"],
    ["EPERM", "Error", "permission-denied"],
    [undefined, "SyntaxError", "syntax-error"],
    ["SOMETHING_ELSE", "Error", "unknown"],
  ])("classifies preload code %s and name %s as %s", (code, name, reason) => {
    const { emit, log } = harness();
    const error = Object.assign(new Error("private detail"), { code, name });
    emit("preload-error", {}, "/private/preload.js", error);
    expect(log).toHaveBeenCalledWith(`[DesktopStartup] preload-failed reason=${reason}`);
  });

  test("accepts only exact diagnostic messages and deduplicates until the next main navigation", () => {
    const { emit, log, mainFrame } = harness();
    emit("console-message", { frame: mainFrame, message: "prompt or terminal contents" });
    emit("console-message", { frame: mainFrame, message: "[DesktopStartup] ready secret-token" });
    emit("console-message", { frame: mainFrame, message: "[DesktopStartup] backend-unavailable" });
    emit("console-message", { frame: mainFrame, message: "[DesktopStartup] backend-unavailable" });
    expect(log).toHaveBeenCalledTimes(1);
    emit("did-start-navigation", {}, "private-url", false, false);
    emit("console-message", { frame: mainFrame, message: "[DesktopStartup] backend-unavailable" });
    expect(log).toHaveBeenCalledTimes(1);
    emit("did-start-navigation", {}, "private-url", false, true);
    emit("console-message", { frame: mainFrame, message: "[DesktopStartup] ready" });
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("ignores allowlisted markers logged by an untrusted subframe", () => {
    const { emit, log, mainFrame } = harness();
    emit("console-message", {
      frame: { parent: mainFrame },
      message: "[DesktopStartup] ready",
    });
    expect(log).not.toHaveBeenCalled();
    emit("console-message", { frame: mainFrame, message: "[DesktopStartup] ready" });
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("captures failed page loads and renderer crashes with bounded metadata", () => {
    const { emit, log } = harness();
    emit("did-fail-load", {}, -6, "private description", "private-url", false);
    expect(log).not.toHaveBeenCalled();
    emit("did-fail-load", {}, -6, "private description", "private-url", true);
    emit("render-process-gone", {}, { reason: "oom", exitCode: 9 });
    emit("render-process-gone", {}, { reason: "not-an-electron-reason", exitCode: 10 });
    expect(log.mock.calls).toEqual([
      ["[DesktopStartup] page-load-failed code=-6"],
      ["[DesktopStartup] renderer-gone reason=oom"],
      ["[DesktopStartup] renderer-gone reason=unknown"],
    ]);
    for (let code = 0; code < 100; code++) emit("did-fail-load", {}, code, "", "", true);
    expect(log).toHaveBeenCalledTimes(32);
  });
});
