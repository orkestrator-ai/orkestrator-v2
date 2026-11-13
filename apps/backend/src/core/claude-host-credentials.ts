import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandFailedError, runCommand } from "./shell.js";

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

export async function readKeychainCommand(args: string[], timeoutMs = 10_000): Promise<string> {
  try {
    const { stdout } = await runCommand("security", args, {
      timeoutMs,
      maxOutputBytes: MAX_HOST_AGENT_CREDENTIAL_BYTES,
    });
    return stdout;
  } catch (error) {
    if (!(error instanceof CommandFailedError)) throw error;
    // A partial Keychain answer is credential material even on failure.
    throw new CommandFailedError("Keychain read failed", {
      ...error,
      stdout: "",
      stdoutBytes: Buffer.alloc(0),
      stderr: "",
    });
  }
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

/** What a metadata-only Keychain lookup says about one record. */
export type KeychainItemPresence = "present" | "absent" | "unknown";

/**
 * `security`'s exit status for errSecItemNotFound. Every other failure (a
 * locked keychain, a timeout, a declined prompt) says nothing about whether
 * the record exists. Measured on macOS 27.2 against a temporary keychain
 * (2026-11-13, to-do 4580 (retired), task 4): 44 for a record the keychain
 * lacks, also after the record was deleted, and 0 once it exists. The same 44
 * comes back for a keychain path that is missing, empty, not a keychain or a
 * directory, so a 44 from a pinned path counts only when that path is a
 * keychain file ({@link isKeychainFile}).
 */
const SECURITY_ITEM_NOT_FOUND_EXIT = 44;

/** The first bytes of a keychain file (`login.keychain-db` included). */
const KEYCHAIN_FILE_MAGIC = Buffer.from("kych", "latin1");

/**
 * Whether `file` is a keychain `security` could search: it opens and starts
 * with the keychain magic. A missing, empty or foreign file, or a directory,
 * is not, and `security` would answer item-not-found for it all the same.
 */
export async function isKeychainFile(file: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const head = Buffer.alloc(KEYCHAIN_FILE_MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(KEYCHAIN_FILE_MAGIC);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Whether a Keychain record exists, without reading its secret. Leaving out
 * `-w` keeps the lookup from asking for access to the password, so a declined
 * or unanswered prompt cannot pass for a missing record; only `security`'s
 * own item-not-found status counts as absent. The attributes it prints are
 * discarded.
 */
export async function probeKeychainItemCommand(
  args: string[],
  timeoutMs = 10_000,
): Promise<KeychainItemPresence> {
  try {
    await runCommand("security", args, { timeoutMs, maxOutputBytes: 64 * 1024 });
    return "present";
  } catch (error) {
    return error instanceof CommandFailedError &&
      !error.timedOut &&
      error.exitCode === SECURITY_ITEM_NOT_FOUND_EXIT
      ? "absent"
      : "unknown";
  }
}

/**
 * One on-disk credential file as evidence of a sign-out: absent, or a
 * readable JSON object holding neither a subscription login nor any MCP login
 * (what a sign-out leaves). A file that exists but cannot be read or parsed,
 * or that still holds a login (an expired one included), is not.
 */
async function credentialFileSignedOut(file: string): Promise<boolean> {
  let text: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_HOST_AGENT_CREDENTIAL_BYTES) return false;
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!text.trim()) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (record.claudeAiOauth !== undefined && record.claudeAiOauth !== null) return false;
  const mcp = record.mcpOAuth;
  return !(mcp && typeof mcp === "object" && Object.keys(mcp).length > 0);
}

/**
 * Whether the host has signed out of Claude, as opposed to holding a login
 * that has expired or cannot be read. Looks where `getHostClaudeCredentials`
 * looks, with the same options, and answers true only when every place says
 * there is no login: each credential file is absent or empty of logins and,
 * on macOS, every Keychain lookup reports the record missing
 * (`probeKeychainItemCommand`). The pinned `login.keychain-db` lookup runs
 * only when that file is a keychain; without one, a pinned-only lookup (an
 * agent-test profile) reads as not signed out and an ordinary install relies on
 * the default search list alone. Any unreadable file or inconclusive Keychain
 * answer makes it false, so a misread never signs a container out.
 */
export async function hostClaudeSignedOut(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  configDir?: string,
  options: Parameters<typeof getHostClaudeCredentials>[3] = {},
  probeKeychain: (args: string[]) => Promise<KeychainItemPresence> = probeKeychainItemCommand,
): Promise<boolean> {
  if (platform === "darwin") {
    const args = [
      "find-generic-password",
      "-s",
      options.keychainService ?? HOST_CLAUDE_KEYCHAIN_SERVICE,
    ];
    const pinned = path.join(homeDir, "Library", "Keychains", "login.keychain-db");
    const defaultSearchList = options.allowDefaultKeychainSearchList === true;
    const attempts: string[][] = [];
    if (await isKeychainFile(pinned)) attempts.push([...args, pinned]);
    // `security` says item-not-found for a keychain that is not there, so a
    // pinned lookup with no keychain behind it (an agent-test profile's home)
    // is nowhere to look, not evidence of a sign-out.
    else if (!defaultSearchList) return false;
    if (defaultSearchList) attempts.push(args);
    for (const attempt of attempts) {
      if ((await probeKeychain(attempt)) !== "absent") return false;
    }
  }
  const directories = options.configDirOnly
    ? [configDir]
    : [configDir, path.join(homeDir, ".claude")];
  let examined = 0;
  for (const directory of directories) {
    if (!directory) continue;
    examined += 1;
    if (!(await credentialFileSignedOut(path.join(directory, ".credentials.json")))) return false;
  }
  // Nowhere to look is no evidence of anything.
  return examined > 0;
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
