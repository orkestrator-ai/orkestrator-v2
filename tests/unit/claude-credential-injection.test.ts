/**
 * Claude Code credentials must reach containers the way Codex's already do.
 *
 * Codex keeps its token in `~/.codex/auth.json`, so the read-only `/codex-home`
 * mount plus the entrypoint's allowlist carry it in for free. Claude Code on
 * macOS keeps its credential in the login Keychain instead, so nothing under
 * `~/.claude` exists to copy and a container agent reports "Not logged in".
 * These tests cover the host-side resolution and the in-container write that
 * closes that gap.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { __testing } = await import("../../apps/backend/src/core/commands");
const {
  buildSyncContainerClaudeCredentialCommand,
  getHostClaudeCredentials,
} = __testing;

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "orkestrator-claude-cred-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "orkestrator-claude-cred-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runSync(
  credentialFile: string,
  stdin: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    "bash",
    ["-lc", buildSyncContainerClaudeCredentialCommand(credentialFile)],
    { input: stdin, encoding: "utf8" },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

const CREDENTIAL = JSON.stringify({
  claudeAiOauth: { accessToken: "sk-ant-oat01-example", expiresAt: 1 },
});

describe("in-container Claude credential write", () => {
  test("creates the credential file with owner-only permissions", () => {
    withTempDir((dir) => {
      const credentialFile = join(dir, "nested", ".claude", ".credentials.json");
      const result = runSync(credentialFile, CREDENTIAL);

      expect(result.status).toBe(0);
      expect(readFileSync(credentialFile, "utf8")).toBe(CREDENTIAL);
      // A world-readable OAuth token in a shared container is a real leak.
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
    });
  });

  test("writes the payload verbatim without a trailing newline", () => {
    withTempDir((dir) => {
      const credentialFile = join(dir, ".credentials.json");
      runSync(credentialFile, CREDENTIAL);
      // Claude Code parses this file as strict JSON; `echo` would append a
      // newline and `cat`-through-shell would strip meaningful whitespace.
      expect(readFileSync(credentialFile, "utf8")).toBe(CREDENTIAL);
      expect(JSON.parse(readFileSync(credentialFile, "utf8"))).toMatchObject({
        claudeAiOauth: { accessToken: "sk-ant-oat01-example" },
      });
    });
  });

  test("an empty payload leaves an existing in-container credential intact", () => {
    withTempDir((dir) => {
      const credentialFile = join(dir, ".credentials.json");
      writeFileSync(credentialFile, CREDENTIAL, { mode: 0o600 });

      const result = runSync(credentialFile, "");

      // The host having nothing to offer must not log the container out of a
      // session the user established with `claude /login` inside it.
      expect(result.status).toBe(0);
      expect(readFileSync(credentialFile, "utf8")).toBe(CREDENTIAL);
    });
  });

  test("replaces a stale credential so a refreshed token takes effect", () => {
    withTempDir((dir) => {
      const credentialFile = join(dir, ".credentials.json");
      writeFileSync(credentialFile, JSON.stringify({ claudeAiOauth: { accessToken: "old" } }), {
        mode: 0o600,
      });

      runSync(credentialFile, CREDENTIAL);

      expect(readFileSync(credentialFile, "utf8")).toBe(CREDENTIAL);
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
    });
  });

  test("does not interpolate the payload into the script", () => {
    withTempDir((dir) => {
      const credentialFile = join(dir, ".credentials.json");
      const hostile = '{"a":"$(touch ' + join(dir, "pwned") + ')`whoami`"}';

      const result = runSync(credentialFile, hostile);

      expect(result.status).toBe(0);
      expect(readFileSync(credentialFile, "utf8")).toBe(hostile);
      expect(() => statSync(join(dir, "pwned"))).toThrow();
    });
  });
});

describe("host Claude credential resolution", () => {
  const write = async (home: string, contents: string): Promise<void> => {
    await fs.mkdir(join(home, ".claude"), { recursive: true });
    await fs.writeFile(join(home, ".claude", ".credentials.json"), contents);
  };

  test("reads the on-disk credential on non-macOS hosts", async () => {
    await withTempDirAsync(async (dir) => {
      await write(dir, CREDENTIAL);
      expect(await getHostClaudeCredentials("linux", dir)).toBe(CREDENTIAL);
    });
  });

  test("returns undefined when the host has no credential at all", async () => {
    await withTempDirAsync(async (dir) => {
      expect(await getHostClaudeCredentials("linux", dir)).toBeUndefined();
    });
  });

  test.each([
    ["an empty file", ""],
    ["whitespace only", "   \n"],
    ["an empty object", "{}"],
    ["malformed JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"token"'],
  ])("discards %s rather than clobbering a working login", async (_label, contents) => {
    await withTempDirAsync(async (dir) => {
      await write(dir, contents);
      expect(await getHostClaudeCredentials("linux", dir)).toBeUndefined();
    });
  });
});
