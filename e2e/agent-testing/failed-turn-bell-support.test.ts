import { describe, expect, test } from "bun:test";
import {
  bellCases,
  bellEnvironment,
  bellPlatforms,
  bellSelection,
  bridgeProcess,
  descendantsOf,
  expectedUnread,
  loggedBridgePid,
  onboardedClaudeState,
  parseProcessRows,
  refusedLoginTmuxSettings,
  removeEnvironments,
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

  test("a container run defaults to Claude's restart case and refuses what it cannot run", () => {
    expect(bellEnvironment(undefined)).toBe("local");
    expect(bellEnvironment(" container ")).toBe("container");
    expect(() => bellEnvironment("remote")).toThrow("unknown bell environment: remote");
    expect(bellSelection("local", undefined, undefined)).toEqual({
      platforms: ["claude", "codex", "pi", "opencode"],
      cases: ["refused", "stop", "bridge-kill", "restart"],
    });
    expect(bellSelection("container", undefined, "")).toEqual({
      platforms: ["claude"],
      cases: ["restart"],
    });
    expect(bellSelection("container", "claude", "restart,refused,stop")).toEqual({
      platforms: ["claude"],
      cases: ["refused", "stop", "restart"],
    });
    expect(() => bellSelection("container", "codex", undefined)).toThrow(
      "a container bell run cannot cover: codex",
    );
    expect(() => bellSelection("container", undefined, "bridge-kill")).toThrow(
      "a container bell run cannot run: bridge-kill",
    );
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

describe("claude-tmux refused-login fixture files", () => {
  test("settings point at the model with a token, drop an API key and keep other keys", () => {
    const settings = refusedLoginTmuxSettings(
      {
        hooks: { Stop: [{ hooks: [] }] },
        env: { ANTHROPIC_API_KEY: "fixture-only-not-a-key", KEEP: "1" },
      },
      "http://127.0.0.1:4321",
    );
    expect(settings.hooks).toEqual({ Stop: [{ hooks: [] }] });
    expect(settings.env).toEqual({
      KEEP: "1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
      ANTHROPIC_AUTH_TOKEN: "fixture-only-not-a-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(refusedLoginTmuxSettings("not an object", "http://x").env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://x",
    });
  });

  test("state answers the first-run screens for the worktree and keeps other projects", () => {
    const state = onboardedClaudeState(
      { userID: "u", projects: { "/other": { a: 1 }, "/w": { allowedTools: [] } } },
      "/w",
    );
    expect(state).toEqual({
      userID: "u",
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: { "/other": { a: 1 }, "/w": { allowedTools: [], hasTrustDialogAccepted: true } },
    });
    expect(onboardedClaudeState(null, "/w").projects).toEqual({
      "/w": { hasTrustDialogAccepted: true },
    });
  });
});

describe("removing a run's environments", () => {
  const busy = new Error(
    "container-lifecycle: Another Orkestrator backend is managing this data directory's containers.",
  );
  const noSleep = async () => {};

  test("retries a delete the writer lease refuses until it succeeds", async () => {
    const calls: string[] = [];
    let refusals = 2;
    const failures = await removeEnvironments(
      async (command, args) => {
        calls.push(`${command}:${String(args.environmentId)}`);
        if (command === "delete_environment" && args.environmentId === "ctr" && refusals > 0) {
          refusals -= 1;
          throw busy;
        }
      },
      ["park", "ctr"],
      { sleep: noSleep },
    );
    expect(failures).toEqual([]);
    expect(calls.filter((call) => call === "delete_environment:ctr")).toHaveLength(3);
    expect(calls[0]).toBe("stop_environment:park");
  });

  test("reports what it could not delete instead of throwing", async () => {
    const failures = await removeEnvironments(
      async (command, args) => {
        if (command !== "delete_environment") return;
        if (args.environmentId === "busy") throw busy;
        if (args.environmentId === "broken") throw new Error("no such environment");
      },
      ["busy", "broken", "fine"],
      { sleep: noSleep, timeoutMs: 10_000, retryMs: 5_000 },
    );
    expect(failures.map((failure) => failure.environmentId)).toEqual(["busy", "broken"]);
    expect(failures[1]!.error).toBe("no such environment");
  });

  test("a failed stop does not prevent the delete", async () => {
    const deleted: string[] = [];
    const failures = await removeEnvironments(
      async (command, args) => {
        if (command === "stop_environment") throw new Error("already stopped");
        deleted.push(String(args.environmentId));
      },
      ["a"],
      { sleep: noSleep },
    );
    expect(failures).toEqual([]);
    expect(deleted).toEqual(["a"]);
  });
});
