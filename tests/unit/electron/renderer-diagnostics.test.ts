import { describe, expect, mock, test } from "bun:test";
import { installRendererDiagnostics } from "../../../apps/desktop/electron/renderer-diagnostics";

function harness() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const log = mock((_message: string) => {});
  installRendererDiagnostics(
    {
      on: (name: string, callback: (...args: any[]) => void) => {
        handlers.set(name, callback);
      },
    } as never,
    log,
  );
  return { log, emit: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args) };
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

  test("accepts only exact diagnostic messages and deduplicates until the next main navigation", () => {
    const { emit, log } = harness();
    emit("console-message", { message: "prompt or terminal contents" });
    emit("console-message", { message: "[DesktopStartup] ready secret-token" });
    emit("console-message", { message: "[DesktopStartup] backend-unavailable" });
    emit("console-message", { message: "[DesktopStartup] backend-unavailable" });
    expect(log).toHaveBeenCalledTimes(1);
    emit("did-start-navigation", {}, "private-url", false, false);
    emit("console-message", { message: "[DesktopStartup] backend-unavailable" });
    expect(log).toHaveBeenCalledTimes(1);
    emit("did-start-navigation", {}, "private-url", false, true);
    emit("console-message", { message: "[DesktopStartup] ready" });
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("captures failed page loads and renderer crashes with bounded metadata", () => {
    const { emit, log } = harness();
    emit("did-fail-load", {}, -6, "private description", "private-url", false);
    expect(log).not.toHaveBeenCalled();
    emit("did-fail-load", {}, -6, "private description", "private-url", true);
    emit("render-process-gone", {}, { reason: "oom", exitCode: 9 });
    expect(log.mock.calls).toEqual([
      ["[DesktopStartup] page-load-failed code=-6"],
      ["[DesktopStartup] renderer-gone reason=oom"],
    ]);
    for (let code = 0; code < 100; code++) emit("did-fail-load", {}, code, "", "", true);
    expect(log).toHaveBeenCalledTimes(32);
  });
});
