import { afterAll, describe, expect, jest, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPublicActionResponse } from "@orkestrator/protocol/public-api";
import { SCENARIOS } from "../scenarios/cases.js";
import {
  CliDriver,
  newScenarioRoot,
  removeTree,
  RunManifest,
  startIsolatedBackend,
  type ScenarioContext,
} from "../scenarios/harness.js";

/**
 * The distributed executable, exercised as a subprocess. These prove the
 * packaged launcher takes the right branch — client commands never start or
 * initialise a backend — and that the packaged client drives a real backend.
 */

jest.setTimeout(120_000);

const packageRoot = path.resolve(import.meta.dir, "..");
const bin = path.join(packageRoot, "bin", "orkestrator.js");
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-cli-client-proc-"));
  directories.push(directory);
  return directory;
}

async function runBin(argv: string[], env: Record<string, string>, timeoutMs = 20_000) {
  const child = Bun.spawn([process.execPath, bin, ...argv], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, code };
}

describe("packaged client entrypoint", () => {
  test("toolchain dry runs parse repeated and comma-separated tools and reject empty selections", async () => {
    const root = await scratch();
    const env = {
      ORKESTRATOR_DATA_DIR: path.join(root, "from-env"),
      XDG_CONFIG_HOME: path.join(root, "xdg"),
      HOME: root,
    };
    // Each invocation is an independent dry run or refusal, so start them together.
    const [named, fromEnv, fromDefault, ...invalidRuns] = await Promise.all([
      runBin(
        [
          "toolchain",
          "install",
          "--dry-run",
          "--json",
          "--tool",
          "claude,codex",
          "--tool",
          "pi",
          "--data-dir",
          path.join(root, "from-flag"),
        ],
        env,
      ),
      runBin(["toolchain", "install", "--dry-run", "--json"], env),
      runBin(["toolchain", "install", "--dry-run", "--json"], {
        XDG_CONFIG_HOME: path.join(root, "xdg"),
        HOME: root,
      }),
      ...[",", ",,", "unknown"].map((value) =>
        runBin(["toolchain", "install", "--json", "--tool", value], env),
      ),
    ]);
    expect(named.code).toBe(0);
    expect(JSON.parse(named.stdout).result).toMatchObject({
      dryRun: true,
      dataDir: path.join(root, "from-flag"),
      source: "explicit",
    });
    expect(
      JSON.parse(named.stdout)
        .result.tools.map((tool: { tool: string }) => tool.tool)
        .sort(),
    ).toEqual(["claude", "codex", "gh", "pi"]);
    expect(JSON.parse(fromEnv.stdout).result.dataDir).toBe(path.join(root, "from-env"));
    expect(JSON.parse(fromDefault.stdout).result.dataDir).toBe(
      process.platform === "darwin"
        ? path.join(root, "Library", "Application Support", "orkestrator-v2")
        : path.join(root, "xdg", "orkestrator-v2"),
    );
    for (const invalid of invalidRuns) {
      expect(invalid.code).toBe(2);
      expect(JSON.parse(invalid.stdout).error.code).toBe("invalid-input");
    }
    await expect(stat(path.join(root, "from-flag"))).rejects.toThrow();
    await expect(stat(path.join(root, "from-env"))).rejects.toThrow();
  });

  test("help, version and client errors never initialise a backend", async () => {
    const root = await scratch();
    const dataDir = path.join(root, "would-be-data");
    const env = {
      ORKESTRATOR_DATA_DIR: dataDir,
      ORKESTRATOR_CLI_CONFIG_DIR: path.join(root, "cli"),
      XDG_CONFIG_HOME: path.join(root, "xdg"),
      HOME: root,
    };
    const argvs = [
      ["--help"],
      ["help", "environment", "start"],
      ["version"],
      ["--version", "--json"],
      ["serve", "--help"],
    ];
    const [list, ...results] = await Promise.all([
      runBin(["--json", "project", "list"], env),
      ...argvs.map((argv) => runBin(argv, env)),
    ]);
    for (const [index, result] of results.entries()) {
      const argv = argvs[index];
      expect({ argv, code: result.code }).toEqual({ argv, code: 0 });
      expect(result.stdout).not.toContain("orkestrator-backend-ready");
    }
    expect(list.code).toBe(4);
    expect(isPublicActionResponse(JSON.parse(list.stdout))).toBe(true);
    // No data directory, no XDG config, no listener output: nothing started.
    await expect(stat(dataDir)).rejects.toThrow();
    await expect(stat(path.join(root, "xdg"))).rejects.toThrow();
    expect(list.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("unknown commands and typoed service flags are refused without echoing values", async () => {
    const root = await scratch();
    const env = { ORKESTRATOR_DATA_DIR: path.join(root, "data"), HOME: root };
    const [typo, prompt, mixed] = await Promise.all([
      runBin(["--prot", "34121"], env),
      runBin(["implement the secret feature"], env),
      runBin(["--data-dir", path.join(root, "data"), "--json"], env),
    ]);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain("--prot");
    expect(prompt.code).toBe(2);
    expect(prompt.stderr).not.toContain("secret feature");
    expect(mixed.code).toBe(2);
    expect(JSON.parse(mixed.stdout).error.code).toBe("invalid-input");
    await expect(stat(path.join(root, "data"))).rejects.toThrow();
  });
});

describe("packaged client against a real backend", () => {
  test("publishes a private instance descriptor without the credential and removes it on shutdown", async () => {
    const root = await newScenarioRoot("descriptor");
    directories.push(root);
    const backend = await startIsolatedBackend({ root });
    try {
      const file = path.join(backend.dataDir, "backend-instance.json");
      const mode = (await stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
      const text = await readFile(file, "utf8");
      const token = JSON.parse(await readFile(backend.descriptor.authFile, "utf8")).token as string;
      expect(text).not.toContain(token);
      expect(backend.descriptor.pid).toBe(backend.process.pid);
    } finally {
      expect(await backend.stop()).toBe(0);
    }
    await expect(stat(path.join(backend.dataDir, "backend-instance.json"))).rejects.toThrow();
  });

  for (const name of ["read-only", "local-lifecycle", "retry-and-retention", "setup-failure"]) {
    test(`scenario: ${name}`, async () => {
      const definition = SCENARIOS.find((scenario) => scenario.name === name)!;
      const root = await newScenarioRoot(name);
      const backend = await startIsolatedBackend({ root });
      const manifest = new RunManifest(null);
      const context: ScenarioContext = {
        name,
        root,
        backend,
        cli: new CliDriver(
          name,
          {
            ORKESTRATOR_CLI_CONFIG_DIR: path.join(root, "cli-config"),
            ORKESTRATOR_DEV_ROOT: path.join(root, "dev-root"),
            ORKESTRATOR_SCENARIO_CWD: root,
          },
          manifest,
        ),
        manifest,
        cleanup: [],
        environmentType: "local",
      };
      try {
        await definition.run(context);
      } finally {
        for (const step of context.cleanup) await step.run().catch(() => undefined);
        expect(await backend.stop()).toBe(0);
        expect(await readdir(backend.worktreeDir).catch(() => [])).toEqual([]);
        await removeTree(root);
      }
    });
  }
});

test("packaged scenario backend receives the sanitized isolated environment", async () => {
  const root = await scratch();
  const shell = path.join(root, "fixture-shell");
  const capture = path.join(root, "startup-env.json");
  // The login shell is the first child. Write only fixture paths and presence
  // bits, never inherited credential contents.
  await Bun.write(
    shell,
    `#!/bin/sh
exec "$ORKESTRATOR_SCENARIO_BUN" -e '
  await Bun.write(process.env.ORKESTRATOR_SCENARIO_CAPTURE, JSON.stringify({
    credentialSource: Object.hasOwn(process.env, "ORKESTRATOR_CREDENTIAL_SOURCE"),
    hostHome: Object.hasOwn(process.env, "ORKESTRATOR_AGENT_TEST_HOST_HOME"),
    hostClaude: Object.hasOwn(process.env, "ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR"),
    hostPi: Object.hasOwn(process.env, "ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR"),
    claude: process.env.CLAUDE_CONFIG_DIR,
    codex: process.env.CODEX_HOME,
    xdg: process.env.XDG_DATA_HOME,
    mcpUrl: Object.hasOwn(process.env, "ORKESTRATOR_AGENT_MCP_URL"),
    mcpToken: Object.hasOwn(process.env, "ORKESTRATOR_AGENT_MCP_TOKEN"),
  }));
  process.stdout.write(process.env.PATH);
'
`,
  );
  const { chmod } = await import("node:fs/promises");
  await chmod(shell, 0o700);
  const backend = await startIsolatedBackend({
    root,
    env: {
      SHELL: shell,
      ORKESTRATOR_SCENARIO_BUN: process.execPath,
      ORKESTRATOR_SCENARIO_CAPTURE: capture,
      ORKESTRATOR_CREDENTIAL_SOURCE: "claude",
      ORKESTRATOR_AGENT_TEST_HOST_HOME: "host-home-must-not-survive",
      ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR: "host-claude-must-not-survive",
      ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR: "host-pi-must-not-survive",
      CLAUDE_CONFIG_DIR: "host-claude",
      CODEX_HOME: "host-codex",
      XDG_DATA_HOME: "host-data",
      ORKESTRATOR_AGENT_MCP_URL: "parent-url",
      ORKESTRATOR_AGENT_MCP_TOKEN: "parent-token",
    },
  });
  try {
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({
      credentialSource: false,
      hostHome: false,
      hostClaude: false,
      hostPi: false,
      claude: path.join(root, "provider-homes", "claude"),
      codex: path.join(root, "provider-homes", "codex"),
      xdg: path.join(root, "provider-homes", "xdg-data"),
      mcpUrl: false,
      mcpToken: false,
    });
  } finally {
    expect(await backend.stop()).toBe(0);
  }
});
