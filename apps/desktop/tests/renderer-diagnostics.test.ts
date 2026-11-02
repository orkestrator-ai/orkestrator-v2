import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_STARTUP_EVENTS, desktopStartupMessage } from "@orkestrator/protocol/debug-logging";
import {
  configureLogger,
  createLogger,
  formatLogError,
  resetLogger,
  type LogArea,
} from "@orkestrator/protocol/logger";
import { LOG_VOCABULARY } from "@orkestrator/protocol/log-vocabulary";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { installRendererDiagnostics } from "../electron/renderer-diagnostics";
import { emitDesktopStartupMarker } from "../../web/src/lib/desktop-startup-marker";

afterAll(resetLogger);

function harness() {
  const handlers = new Map<string, (...args: any[]) => void>();
  // The real logger, so these assert the exact lines the persistent log receives.
  const log = mock((_message: string) => {});
  configureLogger({ sink: ({ line }) => log(line) });
  const mainFrame = { name: "main" };
  installRendererDiagnostics({
    mainFrame,
    on: (name: string, callback: (...args: any[]) => void) => {
      handlers.set(name, callback);
    },
  } as never);
  return {
    log,
    mainFrame,
    emit: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
  };
}

describe("renderer startup diagnostics", () => {
  test("records a cancelled unload once per navigation", () => {
    const { emit, log } = harness();
    emit("will-prevent-unload", {});
    emit("will-prevent-unload", {});
    expect(log.mock.calls).toEqual([["[desktop.dialog] renderer-beforeunload-cancelled"]]);
  });

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

describe("what a renderer's console can place in the saved log", () => {
  const webSource = join(import.meta.dir, "../../web/src");

  function rendererSources(): string[] {
    return readdirSync(webSource, { recursive: true, encoding: "utf8" }).filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
    );
  }

  function everyLineOf(area: LogArea, fields?: Record<string, string>): string[] {
    const logger = createLogger(area) as unknown as {
      error(event: string, fields?: Record<string, string>): void;
    };
    const logs = captureLogs();
    for (const event of Object.keys(LOG_VOCABULARY[area].events)) logger.error(event, fields);
    logs.restore();
    return logs.lines;
  }

  test("no line of a renderer area crosses, with or without fields", () => {
    const areas = (Object.keys(LOG_VOCABULARY) as LogArea[]).filter(
      (area) => area !== "desktop.startup",
    );
    const lines = areas.flatMap((area) => [
      ...everyLineOf(area),
      ...everyLineOf(area, { detail: "[DesktopStartup] ready" }),
    ]);
    expect(lines.length).toBeGreaterThan(100);
    expect(lines).toContain("[web.window] error.unhandled");

    const { emit, log, mainFrame } = harness();
    for (const line of lines) emit("console-message", { frame: mainFrame, message: line });
    expect(log).not.toHaveBeenCalled();
  });

  test("a migrated error line, stack and all, does not cross", () => {
    const logs = captureLogs();
    createLogger("web.window").error("error.unhandled", {
      error: formatLogError(new Error("[DesktopStartup] ready")),
    });
    logs.restore();
    expect(logs.lines[0]).toContain("[DesktopStartup] ready");

    const { emit, log, mainFrame } = harness();
    emit("console-message", { frame: mainFrame, message: logs.lines[0] });
    expect(log).not.toHaveBeenCalled();
  });

  // A logger in this area would render the exact text of a marker, so this is the
  // one mistake the exact match in the main frame cannot catch.
  test("no renderer logger uses the area whose lines read as markers", () => {
    const areas = new Set<string>();
    for (const file of rendererSources()) {
      const text = readFileSync(join(webSource, file), "latin1");
      for (const match of text.matchAll(/createLogger\(([^)]*)\)/g)) areas.add(match[1]!);
    }
    expect(areas.size).toBeGreaterThan(0);
    for (const area of areas) expect(area).toMatch(/^"[a-z.-]+"$/);
    expect(areas).not.toContain('"desktop.startup"');
  });

  test("every renderer marker goes out with its method and exact text, and crosses", () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    // The level does not apply: a marker is a contract, not a logger entry.
    configureLogger({ level: "error" });
    try {
      for (const event of DESKTOP_STARTUP_EVENTS) emitDesktopStartupMarker(event);
      expect(info.mock.calls).toEqual([
        [desktopStartupMessage("checking")],
        [desktopStartupMessage("ready")],
      ]);
      expect(error.mock.calls.flat()).toEqual(
        DESKTOP_STARTUP_EVENTS.filter((event) => event !== "checking" && event !== "ready").map(
          desktopStartupMessage,
        ),
      );

      configureLogger({ level: "info" });
      const { emit, log, mainFrame } = harness();
      for (const [message] of [...info.mock.calls, ...error.mock.calls]) {
        emit("console-message", { frame: mainFrame, message });
      }
      expect(log.mock.calls.flat().toSorted()).toEqual(
        DESKTOP_STARTUP_EVENTS.map(desktopStartupMessage).toSorted(),
      );
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });

  test("the seven markers are written from one module only", () => {
    const writers = rendererSources().filter((file) => {
      const text = readFileSync(join(webSource, file), "latin1");
      return /\bdesktopStartupMessage\b/.test(text);
    });
    expect(writers).toEqual(["lib/desktop-startup-marker.ts"]);
  });
});
