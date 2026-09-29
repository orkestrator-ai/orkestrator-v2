import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AgentAccountIdentity,
  AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";

import { HOST_CLAUDE_KEYCHAIN_SERVICE } from "./commands-runtime-state.js";

/**
 * Filesystem side of an added account: its configuration directory, the links
 * that share everything but the login with the host directory, and reading the
 * login back. See docs/plans/multi-account.md.
 */

/**
 * Host entries an account directory links to. User-authored configuration and
 * every transcript are shared so a conversation resumes on any account; the
 * login, `.claude.json` (which names the login) and provider caches are not.
 */
export const CLAUDE_SHARED_ENTRIES = [
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "skills",
  "plugins",
  "hooks",
  "rules",
  "output-styles",
  "keybindings.json",
  "projects",
  "todos",
  "file-history",
  "plans",
  "history.jsonl",
] as const;

/**
 * SQLite state is deliberately absent: SQLite creates its `-wal`/`-shm`
 * sidecars next to the path it opened, so a linked database would be written
 * from two directories at once.
 */
export const CODEX_SHARED_ENTRIES = [
  "config.toml",
  "AGENTS.md",
  "skills",
  "rules",
  "prompts",
  "hooks.json",
  "plugins",
  "sessions",
  "archived_sessions",
  "session_index.jsonl",
  "history.jsonl",
] as const;

/**
 * Transcript roots created on the host when missing. Without the link, an
 * account's first session would grow a private copy that no other account sees.
 */
const REQUIRED_SHARED_DIRECTORIES: Record<AgentAccountPlatform, readonly string[]> = {
  claude: ["projects"],
  codex: ["sessions"],
};

/** Keys copied from each host `.claude.json` project entry. */
const CLAUDE_SYNCED_PROJECT_KEYS = [
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "hasTrustDialogAccepted",
  "allowedTools",
] as const;

/** Claude's own `.claude.json` lock treats a directory older than this as abandoned. */
const CLAUDE_JSON_LOCK_STALE_MS = 10_000;
const CLAUDE_JSON_LOCK_WAIT_MS = 3_000;
const MAX_ACCOUNT_FILE_BYTES = 8 * 1024 * 1024;

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

export function hostClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
}

/** Without `CLAUDE_CONFIG_DIR`, Claude keeps `.claude.json` beside the directory, in HOME. */
export function hostClaudeJsonPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? path.join(configDir, ".claude.json") : path.join(home, ".claude.json");
}

export function hostCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return env.CODEX_HOME?.trim() || path.join(home, ".codex");
}

/** An account's directory. Always built the same way: its spelling names a Keychain entry. */
export function agentAccountHome(
  accountsRoot: string,
  platform: AgentAccountPlatform,
  accountId: string,
): string {
  return path.join(path.resolve(accountsRoot), platform, accountId);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Point each shared entry of an account directory at the host's.
 *
 * Idempotent and conservative: a regular file or directory already in the
 * account directory is left alone, because the CLI puts one there when it
 * saves by atomic rename and that content is the account's now. A link whose
 * host target has gone is removed.
 */
export async function linkSharedEntries(
  accountHome: string,
  hostHome: string,
  entries: readonly string[],
  requiredDirectories: readonly string[] = [],
): Promise<void> {
  for (const entry of entries) {
    const target = path.join(hostHome, entry);
    const link = path.join(accountHome, entry);
    if (requiredDirectories.includes(entry)) {
      await fs.mkdir(target, { recursive: true });
    }
    const targetExists = await fs.lstat(target).then(
      () => true,
      () => false,
    );
    const current = await fs.lstat(link).catch(() => null);
    if (current?.isSymbolicLink()) {
      if (targetExists && (await fs.readlink(link)) === target) continue;
      await fs.unlink(link).catch(() => undefined);
    } else if (current) {
      continue;
    }
    if (!targetExists) continue;
    try {
      await fs.symlink(target, link);
    } catch (error) {
      // A concurrent launch for the same account linked it first.
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * `null` for a missing file, `undefined` for one that cannot be trusted. The
 * difference matters: syncing over an unreadable file would erase the login
 * identity Claude keeps in it.
 */
async function readJsonObjectFile(file: string): Promise<JsonObject | null | undefined> {
  let raw: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_ACCOUNT_FILE_BYTES) return undefined;
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    return isErrno(error, "ENOENT") ? null : undefined;
  }
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function writeFileAtomic(file: string, contents: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Hold Claude's own `<file>.lock` directory lock, the same protocol the CLI
 * uses for `.claude.json`. Gives up (returns false) rather than waiting out a
 * live holder, because the next launch syncs again.
 */
async function withClaudeJsonLock(
  file: string,
  operation: () => Promise<void>,
  now: () => number = Date.now,
): Promise<boolean> {
  const lock = `${file}.lock`;
  const deadline = now() + CLAUDE_JSON_LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && now() - stat.mtimeMs > CLAUDE_JSON_LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await operation();
    return true;
  } finally {
    await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Copy the host's MCP servers and per-project trust into an account's
 * `.claude.json`.
 *
 * With `CLAUDE_CONFIG_DIR` set, Claude reads user- and local-scope MCP servers
 * from that directory's `.claude.json` only, so without this an account would
 * silently lose every server the user configured. The account's own keys —
 * above all `oauthAccount` — are never touched.
 */
export async function syncClaudeAccountSettings(
  accountHome: string,
  hostJsonPath: string,
): Promise<"synced" | "unchanged" | "skipped"> {
  const host = await readJsonObjectFile(hostJsonPath);
  if (!host) return "skipped";
  const accountJsonPath = path.join(accountHome, ".claude.json");
  let outcome: "synced" | "unchanged" | "skipped" = "skipped";
  const locked = await withClaudeJsonLock(accountJsonPath, async () => {
    const current = await readJsonObjectFile(accountJsonPath);
    if (current === undefined) return;
    const account = current ?? {};
    const next: JsonObject = { ...account };
    const hostServers = asObject(host.mcpServers);
    if (hostServers) next.mcpServers = hostServers;
    else delete next.mcpServers;
    if (host.hasCompletedOnboarding === true) next.hasCompletedOnboarding = true;
    const projects: JsonObject = { ...asObject(account.projects) };
    for (const [projectPath, value] of Object.entries(asObject(host.projects) ?? {})) {
      const hostEntry = asObject(value);
      if (!hostEntry) continue;
      const merged: JsonObject = { ...asObject(projects[projectPath]) };
      for (const key of CLAUDE_SYNCED_PROJECT_KEYS) {
        if (key in hostEntry) merged[key] = hostEntry[key];
        else delete merged[key];
      }
      projects[projectPath] = merged;
    }
    next.projects = projects;
    if (JSON.stringify(next) === JSON.stringify(account)) {
      outcome = "unchanged";
      return;
    }
    await writeFileAtomic(accountJsonPath, `${JSON.stringify(next, null, 2)}\n`);
    outcome = "synced";
  });
  return locked ? outcome : "skipped";
}

export interface AgentAccountHomeSources {
  claudeHome: string;
  claudeJson: string;
  codexHome: string;
}

export function hostAgentAccountSources(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): AgentAccountHomeSources {
  return {
    claudeHome: hostClaudeConfigDir(env, home),
    claudeJson: hostClaudeJsonPath(env, home),
    codexHome: hostCodexHome(env, home),
  };
}

/** Create or refresh an account directory. Safe to run before every launch. */
export async function prepareAgentAccountHome(
  platform: AgentAccountPlatform,
  accountHome: string,
  sources: AgentAccountHomeSources = hostAgentAccountSources(),
): Promise<void> {
  await fs.mkdir(accountHome, { recursive: true, mode: 0o700 });
  await fs.chmod(accountHome, 0o700);
  if (platform === "claude") {
    await linkSharedEntries(
      accountHome,
      sources.claudeHome,
      CLAUDE_SHARED_ENTRIES,
      REQUIRED_SHARED_DIRECTORIES.claude,
    );
    await syncClaudeAccountSettings(accountHome, sources.claudeJson);
  } else {
    await linkSharedEntries(
      accountHome,
      sources.codexHome,
      CODEX_SHARED_ENTRIES,
      REQUIRED_SHARED_DIRECTORIES.codex,
    );
  }
}

/** Best-effort read of an account directory's `.claude.json`. */
export async function readClaudeAccountJson(file: string): Promise<JsonObject | undefined> {
  return (await readJsonObjectFile(file)) ?? undefined;
}

/** Raw `auth.json` of a Codex home, or undefined when it has none. */
export async function readCodexAuthFile(codexHome: string): Promise<string | undefined> {
  const file = path.join(codexHome, "auth.json");
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_ACCOUNT_FILE_BYTES) return undefined;
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

export interface AgentAccountLoginState {
  signedIn: boolean;
  identity: AgentAccountIdentity;
  /** Stable provider identity, used to refuse adding the same login twice. */
  identityKey?: string;
}

function nonEmpty(value: unknown, max = 320): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function jwtClaims(token: unknown): JsonObject | undefined {
  const segment = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!segment) return undefined;
  try {
    return asObject(JSON.parse(Buffer.from(segment, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

/**
 * What a Claude login says about itself.
 *
 * Signed in means a refresh token (the CLI renews the access token itself) or
 * an access token that has not expired. Identity comes from `oauthAccount`,
 * which the CLI writes into `.claude.json` after login.
 */
export function claudeAccountLoginState(
  credentialsRaw: string | undefined,
  claudeJson: JsonObject | undefined,
  now: number = Date.now(),
): AgentAccountLoginState {
  const oauth = asObject(asObject(parseJson(credentialsRaw))?.claudeAiOauth);
  const expiresAt = oauth?.expiresAt;
  const accessTokenLive =
    Boolean(nonEmpty(oauth?.accessToken, 16_384)) &&
    !(typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= now);
  const signedIn = Boolean(nonEmpty(oauth?.refreshToken, 16_384)) || accessTokenLive;
  const account = asObject(claudeJson?.oauthAccount);
  const identity: AgentAccountIdentity = {};
  const email = nonEmpty(account?.emailAddress);
  const organizationName = nonEmpty(account?.organizationName);
  const plan = nonEmpty(oauth?.subscriptionType, 64);
  if (email) identity.email = email;
  if (organizationName) identity.organizationName = organizationName;
  if (plan) identity.plan = plan;
  const accountUuid = nonEmpty(account?.accountUuid, 128);
  const organizationUuid = nonEmpty(account?.organizationUuid, 128) ?? "";
  return {
    signedIn,
    identity,
    ...(accountUuid ? { identityKey: `claude:${accountUuid}:${organizationUuid}` } : {}),
  };
}

/** What a Codex `auth.json` says about itself. */
export function codexAccountLoginState(authRaw: string | undefined): AgentAccountLoginState {
  const auth = asObject(parseJson(authRaw));
  const tokens = asObject(auth?.tokens);
  if (tokens) {
    const claims = jwtClaims(tokens.id_token);
    const openai = asObject(claims?.["https://api.openai.com/auth"]);
    const email = nonEmpty(claims?.email);
    const plan = nonEmpty(openai?.chatgpt_plan_type, 64);
    const accountId = nonEmpty(tokens.account_id, 128) ?? nonEmpty(openai?.chatgpt_account_id, 128);
    const identity: AgentAccountIdentity = {};
    if (email) identity.email = email;
    if (plan) identity.plan = plan;
    return {
      signedIn:
        Boolean(nonEmpty(tokens.refresh_token, 16_384)) ||
        Boolean(nonEmpty(tokens.access_token, 16_384)),
      identity,
      ...(accountId || email ? { identityKey: `codex:${accountId ?? ""}:${email ?? ""}` } : {}),
    };
  }
  const apiKey = nonEmpty(auth?.OPENAI_API_KEY, 16_384);
  if (apiKey) {
    const digest = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
    return {
      signedIn: true,
      identity: { plan: "API key" },
      identityKey: `codex:api-key:${digest}`,
    };
  }
  return { signedIn: false, identity: {} };
}
