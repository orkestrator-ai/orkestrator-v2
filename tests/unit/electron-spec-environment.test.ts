import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync, visitorKeys, type Node } from "oxc-parser";

import {
  HOST_REACHABILITY_CHECK_ENV,
  electronSpecEnvironment,
  startElectronSpecBackend,
} from "../../e2e/agent-testing/electron-spec-environment";
import { packagedLaunchEnvironment } from "../../e2e/agent-testing/packaged-electron-app";

const agentTesting = path.resolve(import.meta.dir, "../../e2e/agent-testing");

/** Parse calls structurally, so aliases, templates and nested objects retain their boundaries. */
function launchOptions(source: string): { line: number; text: string }[] {
  const { program, errors } = parseSync("fixture.ts", source);
  if (errors.length) throw new Error(errors[0]!.message);
  const options: { line: number; text: string }[] = [];
  const spawners = new Set(["spawn"]);
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration" || !node.source.value.endsWith("child_process")) continue;
    for (const specifier of node.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === "spawn"
      )
        spawners.add(specifier.local.name);
    }
  }
  function visit(node: Node) {
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const member =
        callee.type === "MemberExpression" && callee.property.type === "Identifier"
          ? callee.property.name
          : null;
      const launch =
        member === "launch" &&
        !(
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          ["chromium", "firefox", "webkit"].includes(callee.object.name)
        );
      const spawn =
        member === "spawn" || (callee.type === "Identifier" && spawners.has(callee.name));
      const executable = node.arguments[0];
      // Literal Bun/server processes are unrelated to Electron launches.
      if (launch || (spawn && executable?.type !== "Literal")) {
        const arg = node.arguments[launch ? 0 : 2];
        options.push({
          line: source.slice(0, node.start).split("\n").length,
          text: arg ? source.slice(arg.start, arg.end) : "",
        });
      }
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item) visit(item as Node);
      } else if (child) visit(child as Node);
    }
  }
  visit(program);
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

  test("direct backend initial start and restart capture off and restore the runner", async () => {
    const original = process.env[HOST_REACHABILITY_CHECK_ENV];
    const captured: (string | undefined)[] = [];
    try {
      process.env[HOST_REACHABILITY_CHECK_ENV] = "on";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const pending = startElectronSpecBackend(() => {
          captured.push(process.env[HOST_REACHABILITY_CHECK_ENV]);
          return Promise.resolve();
        });
        expect(process.env[HOST_REACHABILITY_CHECK_ENV]).toBe("on");
        await pending;
      }
      expect(captured).toEqual(["off", "off"]);
      expect(() =>
        startElectronSpecBackend(() => {
          throw new Error("spawn failed");
        }),
      ).toThrow("spawn failed");
      expect(process.env[HOST_REACHABILITY_CHECK_ENV]).toBe("on");
      delete process.env[HOST_REACHABILITY_CHECK_ENV];
      startElectronSpecBackend(() => undefined);
      expect(process.env[HOST_REACHABILITY_CHECK_ENV]).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env[HOST_REACHABILITY_CHECK_ENV];
      else process.env[HOST_REACHABILITY_CHECK_ENV] = original;
    }
  });

  test("direct disposable Electron backends explicitly disable the probe", () => {
    for (const file of readdirSync(agentTesting)) {
      if (!file.includes("electron") || !file.endsWith(".spec.ts")) continue;
      const source = readFileSync(path.join(agentTesting, file), "utf8");
      for (const match of source.matchAll(/const (\w+) = new BackendProcess\(\)/g)) {
        const name = match[1]!;
        expect(
          source.replace(/\s+/g, "").includes(`startElectronSpecBackend(()=>${name}.start(`) ||
            (source.includes("await withEnvironment(") &&
              source.includes('ORKESTRATOR_HOST_REACHABILITY_CHECK: "off"')),
        ).toBe(true);
      }
    }
  });

  test("the guard finds every launch's options", () => {
    const source = [
      "a(); await electron.launch({ args: [], env: { a: { b: 1 } } });",
      "desktop.launch({ env });",
      "childProcess.spawn(otherBinary, [...SWITCHES, main], { cwd, env: x });",
      "import { spawn as runDesktop } from 'node:child_process'; runDesktop(binary, [`${port}`], { env });",
    ].join("\n");
    expect(launchOptions(source)).toEqual([
      { line: 1, text: "{ args: [], env: { a: { b: 1 } } }" },
      { line: 2, text: "{ env }" },
      { line: 3, text: "{ cwd, env: x }" },
      { line: 4, text: "{ env }" },
    ]);
  });

  test("every Electron launch under e2e/agent-testing builds its env through it", () => {
    // A launch without `env` inherits the runner's environment, probe and all.
    const offenders: string[] = [];
    let launches = 0;
    for (const file of readdirSync(agentTesting)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(path.join(agentTesting, file), "utf8");
      if (!/_electron|electronExecutable|packagedLaunchEnvironment/.test(source)) continue;
      for (const { line, text } of launchOptions(source)) {
        launches += 1;
        if (
          !/\benv:\s*(?:\{\s*\.\.\.)?(electronSpecEnvironment|packagedLaunchEnvironment)\(/.test(
            text,
          )
        ) {
          offenders.push(`${file}:${line}`);
        }
      }
    }
    // A pattern that stops matching must not pass by finding nothing.
    expect(launches).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
