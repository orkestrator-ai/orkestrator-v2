import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST_CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The Keychain service Claude Code reads for a configuration directory.
 *
 * Unset means the host's plain entry. Otherwise the suffix is the first eight
 * hex digits of SHA-256 over the literal `CLAUDE_CONFIG_DIR` string (verified
 * against Claude Code 2.1.283), so callers must pass exactly the string the
 * CLI is launched with: a trailing slash or symlinked spelling is a different
 * entry.
 */
export function claudeKeychainService(configDir: string | undefined): string {
  if (!configDir) return HOST_CLAUDE_KEYCHAIN_SERVICE;
  const suffix = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `${HOST_CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

/**
 * Where Claude Code itself looks for the login of a configuration directory.
 *
 * With `CLAUDE_CONFIG_DIR` set explicitly (`explicit`), Claude reads the
 * Keychain entry named after that string and then only that directory's
 * `.credentials.json`, even when it spells `~/.claude`. Without it, the plain
 * entry and `~/.claude`. Reading the plain entry for an explicit directory
 * hands over a different login than the CLI in that shell would use.
 */
export function claudeLoginLookupOptions(
  configDir: string | undefined,
  explicit: boolean,
): { keychainService?: string; configDirOnly?: boolean } {
  return explicit && configDir
    ? { keychainService: claudeKeychainService(configDir), configDirOnly: true }
    : {};
}

function readKeychainCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      args,
      { encoding: "utf8", timeout: 10_000, maxBuffer: MAX_HOST_AGENT_CREDENTIAL_BYTES },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

const MAX_HOST_AGENT_CREDENTIAL_BYTES = 1024 * 1024;

/**
 * Reads one named Keychain record, preferring an explicit login-Keychain path.
 *
 * The explicit path is what makes an isolated agent-test profile deterministic:
 * its HOME holds no Keychain preferences, so an unqualified lookup would resolve
 * against whatever the launching session happens to default to. A host that is
 * not isolated has no such requirement and may legitimately keep the record in a
 * keychain other than `login.keychain-db`, so it retries the default search list
 * — which is what an unqualified lookup did before the path was pinned — rather
 * than reporting a logged-in user as signed out.
 */
async function readMacKeychainPassword(
  service: string,
  homeDir: string,
  account?: string,
  allowDefaultSearchList = false,
  readKeychain: (args: string[]) => Promise<string> = readKeychainCommand,
): Promise<string | undefined> {
  const args = ["find-generic-password"];
  if (account) args.push("-a", account);
  args.push("-s", service, "-w");
  const attempts = [[...args, path.join(homeDir, "Library", "Keychains", "login.keychain-db")]];
  if (allowDefaultSearchList) attempts.push(args);
  for (const attempt of attempts) {
    try {
      const stdout = await readKeychain(attempt);
      const value = stdout.trim();
      // An empty or oversized payload is not a reason to stop looking; a second
      // keychain may still hold the real record.
      if (!value || Buffer.byteLength(value) > MAX_HOST_AGENT_CREDENTIAL_BYTES) continue;
      return value;
    } catch {
      // A missing item and a declined access prompt look identical from here.
    }
  }
  return undefined;
}

/**
 * Reads the host's Claude Code credential, preferring the macOS Keychain.
 *
 * Returns the raw credential JSON, or undefined when the host has no usable
 * credential. A non-JSON or empty Keychain payload is discarded rather than
 * forwarded, so a corrupt entry cannot overwrite a working in-container login.
 *
 * `keychainService` and `configDirOnly` read one added account's login: its
 * Keychain entry is named after its directory, and falling back to
 * `~/.claude` would report the host login as that account's.
 */
export async function getHostClaudeCredentials(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  configDir?: string,
  options: {
    allowDefaultKeychainSearchList?: boolean;
    keychainService?: string;
    configDirOnly?: boolean;
  } = {},
  readKeychain: (args: string[]) => Promise<string> = readKeychainCommand,
): Promise<string | undefined> {
  const isUsable = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === "{}") return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      return Object.keys(parsed as Record<string, unknown>).length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  };

  if (platform === "darwin") {
    const fromKeychain = isUsable(
      await readMacKeychainPassword(
        options.keychainService ?? HOST_CLAUDE_KEYCHAIN_SERVICE,
        homeDir,
        undefined,
        options.allowDefaultKeychainSearchList === true,
        readKeychain,
      ),
    );
    if (fromKeychain) return fromKeychain;
  }

  // `CLAUDE_CONFIG_DIR` first, because that is where Claude Code itself keeps
  // the on-disk credential when it is set. An agent-test profile runs with an
  // isolated HOME but is pointed at the host configuration, so reading only
  // `homeDir` would look inside the empty isolated home and report no login.
  const directories = options.configDirOnly
    ? [configDir]
    : [configDir, path.join(homeDir, ".claude")];
  for (const directory of directories) {
    if (!directory) continue;
    try {
      const found = isUsable(await fs.readFile(path.join(directory, ".credentials.json"), "utf-8"));
      if (found) return found;
    } catch {
      // Try the next location; a missing file is not an error here.
    }
  }
  return undefined;
}

/**
 * Grace period applied to a recorded OAuth expiry.
 *
 * The token is read once, at bridge start, and never refreshed. One that lapses
 * during startup would be indistinguishable from a broken login, so treat the
 * final moments of its life as already expired.
 */
const CLAUDE_OAUTH_EXPIRY_SKEW_MS = 30_000;

/**
 * Extracts the single OAuth access token that may be handed to one bridge.
 *
 * An expired token is treated as no token at all. It is a non-empty bearer
 * credential that the CLI prefers over every other source, so forwarding a
 * lapsed one turns a stale host login into opaque authentication failures
 * instead of the signed-out state the agent reports clearly. A credential that
 * records no expiry is not evidence of expiry, so only a real timestamp that has
 * already passed rejects.
 */
export function getClaudeOAuthAccessToken(
  credentials: string | undefined,
  now: number = Date.now(),
): string | undefined {
  if (!credentials) return undefined;
  try {
    const parsed = JSON.parse(credentials) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const accessToken = parsed.claudeAiOauth?.accessToken;
    if (typeof accessToken !== "string") return undefined;
    const expiresAt = parsed.claudeAiOauth?.expiresAt;
    if (
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt <= now + CLAUDE_OAUTH_EXPIRY_SKEW_MS
    ) {
      return undefined;
    }
    const trimmed = accessToken.trim();
    return trimmed && Buffer.byteLength(trimmed) <= MAX_HOST_AGENT_CREDENTIAL_BYTES
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}
