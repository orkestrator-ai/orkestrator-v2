import { describe, expect, test } from "bun:test";
import {
  bellCases,
  bellPlatforms,
  bridgeProcess,
  descendantsOf,
  expectedUnread,
  loggedBridgePid,
  parseProcessRows,
} from "./failed-turn-bell-support";

const ROOT = "/work/orkestrator";
const PS = [
  "  100     1 bun /work/orkestrator/apps/backend/src/main.ts --data-dir /p/data",
  "  200   100 /bin/sh -c c= stop= trap 'stop=1' HUP INT TERM exec 3<&0 \"$@\" sh bun /work/orkestrator/bridges/claude-bridge/dist/index.js",
  "  201   200 bun /work/orkestrator/bridges/claude-bridge/dist/index.js",
  "  300   100 /bin/sh -c wrapper sh bun /work/orkestrator/bridges/codex-bridge/dist/index.js",
  "  301   300 bun /work/orkestrator/bridges/codex-bridge/dist/index.js",
  "  302   301 /p/toolchains/codex app-server --stdio",
  "  400   100 /p/toolchains/opencode2 serve --port 41234",
  "  500     1 bun /other/checkout/bridges/pi-bridge/dist/index.js",
  "  600   999 bun /work/orkestrator/bridges/pi-bridge/dist/index.js",
  "garbage line",
].join("\n");

describe("failed-turn bell selection", () => {
  test("defaults to every platform and case, in the documented order", () => {
    expect(bellPlatforms(undefined)).toEqual(["claude", "codex", "pi", "opencode"]);
    expect(bellCases("")).toEqual(["refused", "stop", "bridge-kill", "restart"]);
    expect(bellCases("restart, refused")).toEqual(["refused", "restart"]);
    expect(bellPlatforms("pi")).toEqual(["pi"]);
  });

  test("refuses a name it does not know", () => {
    expect(() => bellPlatforms("claude,gemini")).toThrow("unknown platform: gemini");
    expect(() => bellCases("crash")).toThrow("unknown case: crash");
  });

  test("only a stop expects a finished bell; every other case a failed one", () => {
    expect(expectedUnread("stop")).toBe("agent_finished");
    expect(expectedUnread("refused")).toBe("agent_failed");
    expect(expectedUnread("bridge-kill")).toBe("agent_failed");
    expect(expectedUnread("restart")).toBe("agent_failed");
  });
});

describe("finding a platform's bridge under the profile's backend", () => {
  const rows = parseProcessRows(PS);

  test("parses rows and skips lines that are not rows", () => {
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({
      pid: 100,
      ppid: 1,
      command: "bun /work/orkestrator/apps/backend/src/main.ts --data-dir /p/data",
    });
  });

  test("walks the whole tree below the backend", () => {
    expect(descendantsOf(rows, 100).map((row) => row.pid)).toEqual([200, 300, 400, 201, 301, 302]);
  });

  test("accepts the bridge itself, never its shell wrapper", () => {
    expect(bridgeProcess(rows, 100, "claude", ROOT, 201)?.pid).toBe(201);
    expect(bridgeProcess(rows, 100, "claude", ROOT, 200)).toBeUndefined();
    expect(bridgeProcess(rows, 100, "codex", ROOT, 301)?.pid).toBe(301);
    expect(bridgeProcess(rows, 100, "codex", ROOT, 201)).toBeUndefined();
  });

  test("OpenCode's stand-in is its serve process", () => {
    expect(bridgeProcess(rows, 100, "opencode", ROOT, 400)?.pid).toBe(400);
    expect(bridgeProcess(rows, 100, "opencode", ROOT, 302)).toBeUndefined();
  });

  test("never a process outside this backend's tree or this checkout", () => {
    expect(bridgeProcess(rows, 100, "pi", ROOT, 600)).toBeUndefined();
    expect(bridgeProcess(rows, 100, "pi", ROOT, 500)).toBeUndefined();
    expect(bridgeProcess(rows, 999, "pi", "/other/checkout", 600)).toBeUndefined();
  });

  test("the environment's own bridge comes from the backend's log, latest first", () => {
    const log = [
      "[local-server] bridge.started key=claude:env-a pid=201",
      "[local-server] bridge.started key=claude:env-b pid=777",
      "[local-server] bridge.started key=codex:env-a pid=301",
      "[local-server] bridge.started key=claude:env-a pid=205",
    ].join("\n");
    expect(loggedBridgePid(log, "claude", "env-a")).toBe(205);
    expect(loggedBridgePid(log, "codex", "env-a")).toBe(301);
    expect(loggedBridgePid(log, "pi", "env-a")).toBeUndefined();
    expect(loggedBridgePid(log, "claude", "env")).toBeUndefined();
  });
});
