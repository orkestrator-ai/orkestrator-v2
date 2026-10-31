import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AgentAccountIdentity,
  AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";

/**
 * Filesystem side of an added account: its configuration directory, the links
 * that share everything but the login with the host directory, and reading the
 * login back. See docs/architecture/agent-accounts.md.
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
 * Shared entries that are directories, created on the host when missing.
 * Without the link, the first write from an account (a transcript, a saved
 * plan) would grow a private copy that no other account sees. An empty
 * directory reads the same as a missing one to both CLIs; files are not
 * created, because an empty `settings.json` or `config.toml` is not.
 */
const SHARED_DIRECTORIES: {
  claude: readonly (typeof CLAUDE_SHARED_ENTRIES)[number][];
  codex: readonly (typeof CODEX_SHARED_ENTRIES)[number][];
} = {
  claude: [
    "agents",
    "commands",
    "skills",
    "plugins",
    "hooks",
    "rules",
    "output-styles",
    "projects",
    "todos",
    "file-history",
    "plans",
  ],
  codex: ["skills", "rules", "prompts", "plugins", "sessions", "archived_sessions"],
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

/** See `claude-host-credentials.ts`; re-exported where account code has always imported it. */
export { claudeKeychainService } from "./claude-host-credentials.js";

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

/** Do not follow directory links: their contents are not part of the move. */
async function hasRelativeSymlink(directory: string): Promise<boolean> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!path.isAbsolute(await fs.readlink(file))) return true;
    } else if (entry.isDirectory() && (await hasRelativeSymlink(file))) {
      return true;
    }
  }
  return false;
}

/**
 * Move a directory the account created while the host had none up to the
 * host, so the link that replaces it shares its content with every account.
 * Never merges: when the host has its own, the account keeps its copy and
 * `privateSharedEntries` reports it. Best effort, because a failure (another
 * volume, a CLI recreating the directory) only leaves that copy in place.
 */
async function adoptAccountDirectory(link: string, target: string): Promise<void> {
  const current = await fs.lstat(link).catch(() => null);
  if (!current?.isDirectory()) return;
  const targetExists = await fs.lstat(target).then(
    () => true,
    () => false,
  );
  if (targetExists) return;
  try {
    // Moving changes the base of relative links that escape the subtree. Keep
    // all relative links private conservatively: even an apparently internal
    // path can escape through another symlink before resolving `..`.
    if (await hasRelativeSymlink(link)) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(link, target);
  } catch {
    // Left in place and reported as private.
  }
}

/**
 * Point each shared entry of an account directory at the host's.
 *
 * Idempotent and conservative: a regular file or directory already in the
 * account directory is left alone, because the CLI puts one there when it
 * saves by atomic rename and that content is the account's now. The exception
 * is a required directory the host lacks, which is moved to the host first
 * (`adoptAccountDirectory`). A link whose host target has gone is removed.
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
    const requiredDirectory = requiredDirectories.includes(entry);
    if (requiredDirectory) {
      await adoptAccountDirectory(link, target);
      try {
        await fs.mkdir(target, { recursive: true });
      } catch (error) {
        // A file or dangling link may occupy the host path. Leave it intact;
        // only usable directories are shared below.
        if (!isErrno(error, "EEXIST")) throw error;
      }
    }
    const targetExists = await (requiredDirectory ? fs.stat(target) : fs.lstat(target)).then(
      (stat) => !requiredDirectory || stat.isDirectory(),
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

/**
 * Shared entries the account directory now holds as its own file or directory
 * rather than a link to the host's: the CLI saved one by atomic rename, or
 * wrote a directory that could not be moved to the host, so that account no
 * longer sees the host's copy (or the other accounts' changes).
 * Reported, never re-linked here: replacing the file would race a CLI writing
 * it and discard whatever the account saved. Names only, in list order.
 */
export async function privateSharedEntries(
  platform: AgentAccountPlatform,
  accountHome: string,
): Promise<string[]> {
  const entries = platform === "claude" ? CLAUDE_SHARED_ENTRIES : CODEX_SHARED_ENTRIES;
  const found = await Promise.all(
    entries.map(async (entry) => {
      const current = await fs.lstat(path.join(accountHome, entry)).catch(() => null);
      return current && !current.isSymbolicLink() ? entry : undefined;
    }),
  );
  return found.filter((entry): entry is (typeof entries)[number] => entry !== undefined);
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
  const accountJsonPath = path.join(accountHome, ".claude.json");
  let outcome: "synced" | "unchanged" | "skipped" = "skipped";
  const locked = await withClaudeJsonLock(accountJsonPath, async () => {
    // A waiter must copy the latest revision, even if a newer save overtook it.
    const host = await readJsonObjectFile(hostJsonPath);
    if (!host) return;
    const current = await readJsonObjectFile(accountJsonPath);
    if (current === undefined) return;
    const account = current ?? {};
    const next: JsonObject = { ...account };
    const hostServers = asObject(host.mcpServers);
    if (hostServers) next.mcpServers = hostServers;
    else delete next.mcpServers;
    if (host.hasCompletedOnboarding === true) next.hasCompletedOnboarding = true;
    const projects: JsonObject = { ...asObject(account.projects) };
    // Account-only project servers must disappear too. Preserve account-local
    // history, statistics and trust for projects the host does not name.
    for (const [projectPath, value] of Object.entries(projects)) {
      const entry = asObject(value);
      if (!entry || !("mcpServers" in entry) || asObject(asObject(host.projects)?.[projectPath]))
        continue;
      const nextEntry = { ...entry };
      delete nextEntry.mcpServers;
      projects[projectPath] = nextEntry;
    }
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

/**
 * Give a moved folder the per-project entry (local MCP servers, trust,
 * allowed tools) Claude keeps for its old path in `.claude.json`. An entry
 * already present for the new path is kept. False when the lock was busy.
 */
export async function copyClaudeProjectEntry(
  jsonPath: string,
  fromPath: string,
  toPath: string,
): Promise<boolean> {
  return withClaudeJsonLock(jsonPath, async () => {
    // A linked file is the user's own arrangement; replacing it would unlink it.
    if ((await fs.lstat(jsonPath).catch(() => null))?.isSymbolicLink()) return;
    const current = await readJsonObjectFile(jsonPath);
    if (!current) return;
    const projects = asObject(current.projects);
    const entry = asObject(projects?.[fromPath]);
    if (!projects || !entry || toPath in projects) return;
    await writeFileAtomic(
      jsonPath,
      `${JSON.stringify({ ...current, projects: { ...projects, [toPath]: entry } }, null, 2)}\n`,
    );
  });
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
      SHARED_DIRECTORIES.claude,
    );
    await syncClaudeAccountSettings(accountHome, sources.claudeJson);
  } else {
    await linkSharedEntries(
      accountHome,
      sources.codexHome,
      CODEX_SHARED_ENTRIES,
      SHARED_DIRECTORIES.codex,
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
