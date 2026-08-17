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
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

const { __testing } = await import("../../apps/backend/src/core/commands");
const {
  buildSyncContainerClaudeCredentialCommand,
  getClaudeOAuthAccessToken,
  getHostClaudeCredentials,
  getHostCursorCredentials,
  resolveContainerClaudeCredentials,
  syncAgentTestCursorCredentials,
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

  test("reads an explicit configuration directory before the home directory", async () => {
    // An agent-test profile runs with an isolated HOME but is pointed at the
    // host Claude configuration, so its home directory holds nothing at all.
    await withTempDirAsync(async (dir) => {
      const configDir = join(dir, "host-config");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(join(configDir, ".credentials.json"), CREDENTIAL);
      expect(await getHostClaudeCredentials("linux", join(dir, "isolated-home"), configDir))
        .toBe(CREDENTIAL);
    });
  });

  test("falls back to the home directory when the configuration directory has none", async () => {
    await withTempDirAsync(async (dir) => {
      await write(dir, CREDENTIAL);
      expect(await getHostClaudeCredentials("linux", dir, join(dir, "empty-config")))
        .toBe(CREDENTIAL);
    });
  });
});

describe("host Claude credential resolution on macOS", () => {
  // The Keychain is the whole reason this function exists, and it is also the
  // branch a Linux CI box would never execute. Stubbing `security` on PATH and
  // passing the platform explicitly exercises it on any host.
  const originalPath = process.env.PATH;
  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  const KEYCHAIN = JSON.stringify({
    claudeAiOauth: { accessToken: "sk-ant-oat01-keychain", expiresAt: 2 },
  });
  const ON_DISK = JSON.stringify({
    claudeAiOauth: { accessToken: "sk-ant-oat01-on-disk", expiresAt: 1 },
  });

  const stubSecurity = (dir: string, body: string): void => {
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "security"), body);
    chmodSync(join(binDir, "security"), 0o755);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  };

  const writeOnDisk = async (home: string, contents: string): Promise<void> => {
    await fs.mkdir(join(home, ".claude"), { recursive: true });
    await fs.writeFile(join(home, ".claude", ".credentials.json"), contents);
  };

  test("prefers the Keychain over a stale on-disk credential", async () => {
    await withTempDirAsync(async (dir) => {
      // Claude Code refreshes the Keychain entry; a leftover `.credentials.json`
      // can be months old. Delivering the stale one is what looks like a logout.
      stubSecurity(dir, `#!/bin/sh\nprintf '%s' '${KEYCHAIN}'\n`);
      await writeOnDisk(dir, ON_DISK);
      expect(await getHostClaudeCredentials("darwin", dir)).toBe(KEYCHAIN);
    });
  });

  test("passes the Keychain service name the security tool expects", async () => {
    await withTempDirAsync(async (dir) => {
      const argvLog = join(dir, "argv.log");
      stubSecurity(dir, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nprintf '%s' '${KEYCHAIN}'\n`);
      await getHostClaudeCredentials("darwin", dir);
      expect(readFileSync(argvLog, "utf8")).toBe(
        `find-generic-password -s Claude Code-credentials -w ${join(dir, "Library", "Keychains", "login.keychain-db")}\n`,
      );
    });
  });

  test("extracts only the OAuth access token for the Claude bridge process", () => {
    const now = 1_700_000_000_000;
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-live", expiresAt: now + 3_600_000 },
    });
    expect(getClaudeOAuthAccessToken(live, now)).toBe("sk-ant-oat01-live");
    expect(getClaudeOAuthAccessToken(JSON.stringify({ claudeAiOauth: { refreshToken: "refresh" } })))
      .toBeUndefined();
    expect(getClaudeOAuthAccessToken("not-json")).toBeUndefined();
  });

  test("treats an expired OAuth token as no token at all", () => {
    // The bridge reads this once and never refreshes it. A lapsed bearer token
    // is still non-empty, so forwarding it replaces a clear "signed out" state
    // with opaque authentication failures for the whole session.
    const now = 1_700_000_000_000;
    const withExpiry = (expiresAt: number): string =>
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-example", expiresAt } });

    expect(getClaudeOAuthAccessToken(withExpiry(now - 1), now)).toBeUndefined();
    // Inside the startup grace period counts as expired.
    expect(getClaudeOAuthAccessToken(withExpiry(now + 1_000), now)).toBeUndefined();
    expect(getClaudeOAuthAccessToken(withExpiry(now + 3_600_000), now))
      .toBe("sk-ant-oat01-example");
  });

  test("a credential that records no usable expiry is not treated as expired", () => {
    const now = 1_700_000_000_000;
    expect(getClaudeOAuthAccessToken(
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-example" } }),
      now,
    )).toBe("sk-ant-oat01-example");
    // A string or non-finite expiry is unreadable, not evidence of expiry.
    expect(getClaudeOAuthAccessToken(
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-example", expiresAt: "soon" } }),
      now,
    )).toBe("sk-ant-oat01-example");
  });

  test("retries the default search list for a host that is not an isolated profile", async () => {
    await withTempDirAsync(async (dir) => {
      // A production install may keep the record in a keychain other than
      // `login.keychain-db`. Pinning the path unconditionally would report a
      // logged-in user as signed out.
      const argvLog = join(dir, "argv.log");
      stubSecurity(dir, `#!/bin/sh
printf '%s\\n' "$*" >> '${argvLog}'
case "$*" in
  *login.keychain-db*) exit 1 ;;
  *) printf '%s' '${KEYCHAIN}' ;;
esac
`);
      expect(await getHostClaudeCredentials("darwin", dir, undefined, {
        allowDefaultKeychainSearchList: true,
      })).toBe(KEYCHAIN);
      expect(readFileSync(argvLog, "utf8").trim().split("\n")).toEqual([
        `find-generic-password -s Claude Code-credentials -w ${join(dir, "Library", "Keychains", "login.keychain-db")}`,
        "find-generic-password -s Claude Code-credentials -w",
      ]);
    });
  });

  test("an isolated profile never falls back to the session's default keychain", async () => {
    await withTempDirAsync(async (dir) => {
      // The isolated HOME has no Keychain preferences, so an unqualified lookup
      // would resolve against whatever the launching session defaults to. That
      // is exactly the host exposure this brokering exists to remove.
      const argvLog = join(dir, "argv.log");
      stubSecurity(dir, `#!/bin/sh
printf '%s\\n' "$*" >> '${argvLog}'
case "$*" in
  *login.keychain-db*) exit 1 ;;
  *) printf '%s' '${KEYCHAIN}' ;;
esac
`);
      expect(await getHostClaudeCredentials("darwin", dir)).toBeUndefined();
      expect(readFileSync(argvLog, "utf8").trim().split("\n")).toEqual([
        `find-generic-password -s Claude Code-credentials -w ${join(dir, "Library", "Keychains", "login.keychain-db")}`,
      ]);
    });
  });

  test("falls back to disk when the Keychain lookup fails", async () => {
    await withTempDirAsync(async (dir) => {
      // Exit 1 is a missing item; it is also what a declined access prompt looks
      // like from here. Neither is a reason to give up on a usable disk copy.
      stubSecurity(dir, "#!/bin/sh\nexit 1\n");
      await writeOnDisk(dir, ON_DISK);
      expect(await getHostClaudeCredentials("darwin", dir)).toBe(ON_DISK);
    });
  });

  test("falls back to disk when the Keychain holds an unusable payload", async () => {
    await withTempDirAsync(async (dir) => {
      stubSecurity(dir, "#!/bin/sh\nprintf '%s' '{}'\n");
      await writeOnDisk(dir, ON_DISK);
      expect(await getHostClaudeCredentials("darwin", dir)).toBe(ON_DISK);
    });
  });

  test("returns undefined when neither source has a usable credential", async () => {
    await withTempDirAsync(async (dir) => {
      stubSecurity(dir, "#!/bin/sh\nexit 1\n");
      expect(await getHostClaudeCredentials("darwin", dir)).toBeUndefined();
    });
  });

  test("does not consult the Keychain on a non-darwin platform", async () => {
    await withTempDirAsync(async (dir) => {
      const argvLog = join(dir, "argv.log");
      stubSecurity(dir, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nprintf '%s' '${KEYCHAIN}'\n`);
      await writeOnDisk(dir, ON_DISK);
      expect(await getHostClaudeCredentials("linux", dir)).toBe(ON_DISK);
      expect(() => statSync(argvLog)).toThrow();
    });
  });
});

describe("provider-scoped Cursor credential import", () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  test("queries only Cursor's named services in the explicit host login Keychain", async () => {
    await withTempDirAsync(async (dir) => {
      const binDir = join(dir, "bin");
      const argvLog = join(dir, "argv.log");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "security"), `#!/bin/sh
printf '%s\\n' "$*" >> '${argvLog}'
case "$*" in
  *cursor-access-token*) printf '%s' 'cursor-access' ;;
  *cursor-refresh-token*) printf '%s' 'cursor-refresh' ;;
  *cursor-api-key*) exit 1 ;;
  *) exit 99 ;;
esac
`);
      chmodSync(join(binDir, "security"), 0o755);
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

      expect(await getHostCursorCredentials("darwin", dir)).toEqual({
        accessToken: "cursor-access",
        refreshToken: "cursor-refresh",
      });
      const keychain = join(dir, "Library", "Keychains", "login.keychain-db");
      expect(readFileSync(argvLog, "utf8").trim().split("\n")).toEqual([
        `find-generic-password -a cursor-user -s cursor-access-token -w ${keychain}`,
        `find-generic-password -a cursor-user -s cursor-refresh-token -w ${keychain}`,
        `find-generic-password -a cursor-user -s cursor-api-key -w ${keychain}`,
      ]);
    });
  });

  test("does not consult the Keychain on a non-darwin platform", async () => {
    await withTempDirAsync(async (dir) => {
      const binDir = join(dir, "bin");
      const argvLog = join(dir, "argv.log");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, "security"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nprintf '%s' 'cursor-access'\n`,
      );
      chmodSync(join(binDir, "security"), 0o755);
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

      expect(await getHostCursorCredentials("linux", dir)).toBeUndefined();
      expect(() => statSync(argvLog)).toThrow();
    });
  });

  test("writes and revokes Cursor's owner-only process-specific file store", async () => {
    await withTempDirAsync(async (dir) => {
      const cursorHome = join(dir, "cursor-home");
      const target = join(cursorHome, ".cursor", "auth.json");
      await syncAgentTestCursorCredentials(cursorHome, {
        accessToken: "cursor-access",
        refreshToken: "cursor-refresh",
      });

      expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({
        accessToken: "cursor-access",
        refreshToken: "cursor-refresh",
      });
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(join(cursorHome, ".cursor"))).mode & 0o777).toBe(0o700);

      await syncAgentTestCursorCredentials(cursorHome, undefined);
      expect(await fs.access(target).then(() => true, () => false)).toBe(false);
    });
  });

  test("creates the process-specific home even when there is nothing to import", async () => {
    await withTempDirAsync(async (dir) => {
      // The bridge is launched with this directory as its HOME whether or not
      // Cursor is authorized, so the revoke path must still leave it usable.
      const cursorHome = join(dir, "cursor-home");
      await syncAgentTestCursorCredentials(cursorHome, undefined);

      expect((await fs.stat(cursorHome)).isDirectory()).toBe(true);
      expect((await fs.stat(cursorHome)).mode & 0o777).toBe(0o700);
      expect(await fs.access(join(cursorHome, ".cursor", "auth.json")).then(() => true, () => false))
        .toBe(false);
    });
  });

  test("refuses to write when the Cursor credential path is a regular file", async () => {
    await withTempDirAsync(async (dir) => {
      const cursorHome = join(dir, "cursor-home");
      await fs.mkdir(cursorHome, { recursive: true });
      await fs.writeFile(join(cursorHome, ".cursor"), "not-a-directory");

      await expect(syncAgentTestCursorCredentials(cursorHome, { accessToken: "token" }))
        .rejects.toThrow("not a real directory");
      await expect(syncAgentTestCursorCredentials(cursorHome, undefined))
        .rejects.toThrow("not a real directory");
      expect(await fs.readFile(join(cursorHome, ".cursor"), "utf8")).toBe("not-a-directory");
    });
  });

  test("refuses to write through a replaced Cursor credential directory", async () => {
    await withTempDirAsync(async (dir) => {
      const cursorHome = join(dir, "cursor-home");
      const outside = join(dir, "outside");
      await fs.mkdir(cursorHome, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.symlink(outside, join(cursorHome, ".cursor"));

      await expect(syncAgentTestCursorCredentials(cursorHome, { accessToken: "token" }))
        .rejects.toThrow("not a real directory");
      expect(await fs.access(join(outside, "auth.json")).then(() => true, () => false)).toBe(false);
    });
  });

  test("revokes a replaced Cursor credential directory without deleting its target", async () => {
    await withTempDirAsync(async (dir) => {
      const cursorHome = join(dir, "cursor-home");
      const outside = join(dir, "outside");
      const outsideAuth = join(outside, "auth.json");
      await fs.mkdir(cursorHome, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(outsideAuth, "unrelated-host-data");
      await fs.symlink(outside, join(cursorHome, ".cursor"));

      await syncAgentTestCursorCredentials(cursorHome, undefined);

      expect(await fs.readFile(outsideAuth, "utf8")).toBe("unrelated-host-data");
      expect(await fs.lstat(join(cursorHome, ".cursor")).then(() => true, () => false)).toBe(false);
    });
  });
});

describe("host Claude credential opt-out", () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  const globalConfig = (
    overrides: Record<string, unknown> = {},
  ): Parameters<typeof resolveContainerClaudeCredentials>[0] =>
    ({ allowedDomains: [], ...overrides }) as Parameters<
      typeof resolveContainerClaudeCredentials
    >[0];

  test("resolves nothing, and reads nothing, when explicitly disabled", async () => {
    await withTempDirAsync(async (dir) => {
      // A stub that would fail the test if it ever ran: the gate must be checked
      // before the host is read, so the token never enters this process at all.
      const binDir = join(dir, "bin");
      const argvLog = join(dir, "argv.log");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, "security"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nprintf '%s' '${CREDENTIAL}'\n`,
      );
      chmodSync(join(binDir, "security"), 0o755);
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

      expect(
        await resolveContainerClaudeCredentials(
          globalConfig({ useHostClaudeCredentials: false }),
        ),
      ).toBeUndefined();
      expect(() => statSync(argvLog)).toThrow();
    });
  });

  test("treats an absent setting as enabled, matching the GitHub credential gate", async () => {
    // Existing installs have no such key persisted; they must keep working.
    const resolved = await resolveContainerClaudeCredentials(globalConfig());
    const explicit = await resolveContainerClaudeCredentials(
      globalConfig({ useHostClaudeCredentials: true }),
    );
    expect(resolved).toBe(explicit);
  });
});
