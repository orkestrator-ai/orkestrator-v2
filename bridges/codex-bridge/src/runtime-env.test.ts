import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEX_BRIDGE_NO_SERVER = "1";

const { __testing } = await import("./index.js");

const originalPath = process.env.PATH;
const originalBunInstall = process.env.BUN_INSTALL;
const originalCode = process.env.CODEX_PATH;
const originalBashEnv = process.env.BASH_ENV;
const originalRuntimeEnvScript = process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT;
const originalShell = process.env.SHELL;

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }

  if (originalBunInstall === undefined) {
    delete process.env.BUN_INSTALL;
  } else {
    process.env.BUN_INSTALL = originalBunInstall;
  }

  if (originalCode === undefined) {
    delete process.env.CODEX_PATH;
  } else {
    process.env.CODEX_PATH = originalCode;
  }

  if (originalBashEnv === undefined) {
    delete process.env.BASH_ENV;
  } else {
    process.env.BASH_ENV = originalBashEnv;
  }

  if (originalRuntimeEnvScript === undefined) {
    delete process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT;
  } else {
    process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT = originalRuntimeEnvScript;
  }

  if (originalShell === undefined) {
    delete process.env.SHELL;
  } else {
    process.env.SHELL = originalShell;
  }
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "orkestrator-codex-runtime-env-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRuntimeHelper(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

describe("runtime environment refresh", () => {
  test("applies whitelisted path variables from shell env output", () => {
    process.env.PATH = "/usr/bin:/bin";
    delete process.env.BUN_INSTALL;

    const updated = __testing.applyRuntimeEnvironmentOutput([
      "PATH=/home/node/.bun/bin:/usr/bin:/bin",
      "BUN_INSTALL=/home/node/.bun",
      "BASH_ENV=/tmp/orkestrator-ai/bash-env.sh",
      "CODEX_PATH=/tmp/should-not-change",
    ].join("\n"));

    expect(updated).toEqual(["PATH", "BUN_INSTALL", "BASH_ENV"]);
    expect(process.env.PATH).toBe("/home/node/.bun/bin:/usr/bin:/bin");
    expect(process.env.BUN_INSTALL).toBe("/home/node/.bun");
    expect(process.env.BASH_ENV).toBe("/tmp/orkestrator-ai/bash-env.sh");
    expect(process.env.CODEX_PATH).not.toBe("/tmp/should-not-change");
  });

  test("ignores malformed and empty runtime values", () => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.BUN_INSTALL = "/home/node/.bun";

    const updated = __testing.applyRuntimeEnvironmentOutput([
      "not-an-env-line",
      "=missing-name",
      "PATH=",
      "BUN_INSTALL=/home/node/.bun",
    ].join("\n"));

    expect(updated).toEqual([]);
    expect(process.env.PATH).toBe("/usr/bin:/bin");
    expect(process.env.BUN_INSTALL).toBe("/home/node/.bun");
  });

  test("sources configured runtime helper and applies refreshed shell environment", async () => {
    await withTempDir(async (dir) => {
      const helper = join(dir, "runtime-env.sh");
      const refreshedPath = join(dir, "bin");
      const bunInstall = join(dir, ".bun");
      mkdirSync(refreshedPath, { recursive: true });

      writeRuntimeHelper(
        helper,
        [
          "orkestrator_source_runtime_env() {",
          `  export PATH=${shellQuote(`${refreshedPath}:/usr/bin:/bin`)}`,
          `  export BUN_INSTALL=${shellQuote(bunInstall)}`,
          "  export CODEX_PATH=/tmp/should-not-change",
          "}",
          "",
        ].join("\n"),
      );

      process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT = helper;
      process.env.PATH = "/usr/bin:/bin";
      process.env.CODEX_PATH = "codex";
      delete process.env.BUN_INSTALL;

      await __testing.refreshRuntimeEnvironment();

      expect(process.env.PATH).toBe(`${refreshedPath}:/usr/bin:/bin`);
      expect(process.env.BUN_INSTALL).toBe(bunInstall);
      expect(process.env.CODEX_PATH).toBe("codex");
    });
  });

  test("keeps existing environment when configured runtime helper is missing", async () => {
    await withTempDir(async (dir) => {
      process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT = join(dir, "missing-runtime-env.sh");
      process.env.PATH = "/usr/bin:/bin";
      process.env.BUN_INSTALL = "/home/node/.bun";

      await __testing.refreshRuntimeEnvironment();

      expect(process.env.PATH).toBe("/usr/bin:/bin");
      expect(process.env.BUN_INSTALL).toBe("/home/node/.bun");
    });
  });

  test("inline prompt commands inherit refreshed runtime PATH", async () => {
    await withTempDir(async (dir) => {
      const bashCheck = Bun.spawnSync({
        cmd: ["sh", "-c", "command -v bash"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (bashCheck.exitCode !== 0) {
        return;
      }

      const helper = join(dir, "runtime-env.sh");
      const bin = join(dir, "bin");
      const toolPath = join(bin, "inline-tool");
      mkdirSync(bin, { recursive: true });
      writeFileSync(toolPath, "#!/bin/sh\nprintf inline-tool\n");
      chmodSync(toolPath, 0o755);
      writeRuntimeHelper(
        helper,
        [
          "orkestrator_source_runtime_env() {",
          `  export PATH=${shellQuote(`${bin}:/usr/bin:/bin`)}`,
          "}",
          "",
        ].join("\n"),
      );

      process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT = helper;
      process.env.PATH = "/usr/bin:/bin";
      process.env.SHELL = "/bin/bash";

      const output = await __testing.runInlinePromptCommand("command -v inline-tool", dir);

      expect(output).toBe(toolPath);
    });
  });

  test("prompt execution refreshes runtime PATH before starting Codex", async () => {
    await withTempDir(async (dir) => {
      const helper = join(dir, "runtime-env.sh");
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeRuntimeHelper(
        helper,
        [
          "orkestrator_source_runtime_env() {",
          `  export PATH=${shellQuote(`${bin}:/usr/bin:/bin`)}`,
          "}",
          "",
        ].join("\n"),
      );

      process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT = helper;
      process.env.PATH = "/usr/bin:/bin";

      let observedPath: string | undefined;
      const session = {
        id: "runtime-env-session",
        conversationMode: "build",
        fastMode: false,
        thread: {
          runStreamed: async () => {
            observedPath = process.env.PATH;
            return { events: (async function* () {})() };
          },
        },
        threadOptions: { workingDirectory: dir },
        threadId: null,
        messages: [],
        status: "idle",
        currentItems: new Map(),
        currentItemOrder: [],
        pendingAttachments: [],
        lastAccessed: Date.now(),
      };

      await __testing.runPrompt(session, "hello");

      expect(observedPath).toBe(`${bin}:/usr/bin:/bin`);
      expect(session.status).toBe("idle");
    });
  });
});
