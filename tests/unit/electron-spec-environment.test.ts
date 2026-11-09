import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  HOST_REACHABILITY_CHECK_ENV,
  electronSpecEnvironment,
} from "../../e2e/agent-testing/electron-spec-environment";
import { packagedLaunchEnvironment } from "../../e2e/agent-testing/packaged-electron-app";

const agentTesting = path.resolve(import.meta.dir, "../../e2e/agent-testing");

/**
 * The options object of each Electron launch in `source`, with its line:
 * Playwright's `electron.launch({...})` and a bare `spawn(electronExecutable, [...], {...})`.
 */
function launchOptions(source: string): { line: number; text: string }[] {
  const options: { line: number; text: string }[] = [];
  for (const match of source.matchAll(
    /(?:electron\.launch\(\s*|spawn\(electronExecutable,[^{]*)\{/g,
  )) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        const line = source.slice(0, match.index).split("\n").length;
        options.push({ line, text: source.slice(start, index + 1) });
        break;
      }
    }
  }
  return options;
}

describe("electronSpecEnvironment", () => {
  test("turns the boot probe off and ignores the runner's own value", () => {
    const env = electronSpecEnvironment({
      PATH: "/bin",
      UNSET: undefined,
      [HOST_REACHABILITY_CHECK_ENV]: "on",
    });
    expect(env).toEqual({ PATH: "/bin", [HOST_REACHABILITY_CHECK_ENV]: "off" });
  });

  test("keeps a value the spec passes, applies overrides and removes undefined ones", () => {
    const env = electronSpecEnvironment(
      { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" },
      { ELECTRON_RUN_AS_NODE: undefined, ELECTRON_DEV: "1", [HOST_REACHABILITY_CHECK_ENV]: "on" },
    );
    expect(env).toEqual({ PATH: "/bin", ELECTRON_DEV: "1", [HOST_REACHABILITY_CHECK_ENV]: "on" });
  });

  test("the packaged app's allowlisted environment has the probe off too", () => {
    const env = packagedLaunchEnvironment(
      { PATH: "/bin", [HOST_REACHABILITY_CHECK_ENV]: "on" },
      { home: "/h", profilePath: "/p" },
    );
    expect(env[HOST_REACHABILITY_CHECK_ENV]).toBe("off");
  });

  test("the guard finds every launch's options", () => {
    const source = [
      "a(); await electron.launch({ args: [], env: { a: { b: 1 } } });",
      "_electron.launch({ env });",
      "spawn(electronExecutable, [...SWITCHES, main], { cwd, env: x });",
    ].join("\n");
    expect(launchOptions(source)).toEqual([
      { line: 1, text: "{ args: [], env: { a: { b: 1 } } }" },
      { line: 2, text: "{ env }" },
      { line: 3, text: "{ cwd, env: x }" },
    ]);
  });

  test("every Electron launch under e2e/agent-testing builds its env through it", () => {
    // A launch without `env` inherits the runner's environment, probe and all.
    const offenders: string[] = [];
    let launches = 0;
    for (const file of readdirSync(agentTesting)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(path.join(agentTesting, file), "utf8");
      for (const { line, text } of launchOptions(source)) {
        launches += 1;
        if (!/\benv:\s*(electronSpecEnvironment|packagedLaunchEnvironment)\(/.test(text)) {
          offenders.push(`${file}:${line}`);
        }
      }
    }
    // A pattern that stops matching must not pass by finding nothing.
    expect(launches).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
