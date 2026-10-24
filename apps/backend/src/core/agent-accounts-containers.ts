import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  AGENT_ACCOUNT_PLATFORMS,
  DEFAULT_AGENT_ACCOUNT_ID,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import { restrictProviderAuthEntries } from "@orkestrator/protocol/login-snapshots";

import type { CommandContext } from "./commands-context.js";
import type { AppConfig, Environment } from "./models.js";
import { quoteShell } from "./commands-agent-support.js";
import { dockerExec } from "./commands-container-exec.js";
import {
  buildSyncContainerClaudeCredentialCommand,
  resolveContainerClaudeCredentials,
  SYNC_CONTAINER_CLAUDE_CREDENTIAL_COMMAND,
} from "./commands-files.js";
import {
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
  CONTAINER_CLAUDE_CREDENTIAL_FILE,
} from "./agent-credential-files.js";
import { DOCKER_LABEL_INPUTS_REVISION } from "./constants.js";
import { runCommand } from "./shell.js";
import {
  accessOnlyLoginText,
  INPUT_LIMITS,
  defaultInputSourceRoots,
  portableInputRevisionDirectory,
  replaceStagedInputFile,
  type InputSourceRoots,
} from "./portable-inputs.js";
import { containerLabel, providerCredentialsAllowed } from "./portable-input-status.js";
import {
  containerBridgeOperationId,
  enqueueContainerBridgeOperation,
} from "./container-bridge-operations.js";
import { agentAccountHome, prepareAgentAccountHome } from "./agent-accounts-homes.js";
import {
  readAddedClaudeCredentials,
  resolveActiveAgentAccount,
  type ResolvedAgentAccount,
} from "./agent-accounts-active.js";

/**
 * Containers and the active agent account.
 *
 * A container gets the active account's login instead of the host's at three
 * points: when it is created (staging), before every start (the staged login
 * the entrypoint imports is refreshed), and when an idle in-container bridge
 * next starts after a switch (the login is written into the running container
 * and the bridge replaced). Each container records which account's login it
 * holds in a marker under `/tmp`; a missing marker means the host login, so a
 * container nobody switched is never touched.
 *
 * Only images with staged inputs carry an account across a restart. An older
 * image mounts the host homes directly, so a restart brings the host login
 * back. A real start invalidates the Codex marker so the next idle bridge
 * request reconciles the imported copy, even if startup later fails.
 *
 * Claude, Codex and Grok refresh tokens are single-use, and most OpenCode and
 * Pi OAuth logins rotate theirs, so containers receive these logins access-only
 * (`accessOnlyLoginText`). All five are re-read from the host before every
 * start. Claude, Grok, OpenCode and Pi are also pushed before every bridge
 * start; Claude is kept current while containers run by
 * `container-claude-login-keeper.ts`.
 */

const ACCOUNT_MARKER: Record<AgentAccountPlatform, string> = {
  claude: "/tmp/orkestrator-claude-account",
  codex: "/tmp/orkestrator-codex-account",
};
/** Never equal to an account marker: the next bridge start re-applies the login. */
const UNSTAGED_CODEX_MARKER = "unstaged";
const CONTAINER_CODEX_AUTH_FILE = "/home/node/.codex/auth.json";
const SYNC_CONTAINER_CODEX_AUTH_COMMAND =
  buildSyncContainerClaudeCredentialCommand(CONTAINER_CODEX_AUTH_FILE);
const CONTAINER_GROK_AUTH_FILE = "/home/node/.grok/auth.json";
const SYNC_CONTAINER_GROK_AUTH_COMMAND =
  buildSyncContainerClaudeCredentialCommand(CONTAINER_GROK_AUTH_FILE);
const CONTAINER_OPENCODE_AUTH_FILE = "/home/node/.local/share/opencode/auth.json";
const CONTAINER_PI_AUTH_FILE = "/home/node/.pi/agent/auth.json";
const MAX_LOGIN_FILE_BYTES = 1024 * 1024;

/** How this module reaches a container; replaced in tests. */
export interface ContainerRunners {
  exec: (containerId: string, command: string) => Promise<string>;
  /** Run `command` with `stdin` piped in; the payload never reaches argv or logs. */
  pipe: (containerId: string, command: string, stdin: string) => Promise<void>;
  label: (containerId: string, label: string) => Promise<string | null>;
}

const defaultRunners: ContainerRunners = {
  exec: (containerId, command) => dockerExec(containerId, command),
  pipe: async (containerId, command, stdin) => {
    await runCommand("docker", ["exec", "-i", containerId, "bash", "-lc", command], {
      stdin,
      timeoutMs: 30_000,
      redactValues: [stdin],
    });
  },
  label: containerLabel,
};

function logFailure(what: string, error: unknown): void {
  // Never the payload: only what failed and why.
  console.warn(`[agent-accounts] ${what}:`, error instanceof Error ? error.message : String(error));
}

/** Account directories to stage from, for the platforms whose active account is an added one. */
export async function activeAgentAccountInputRoots(
  context: CommandContext,
): Promise<Pick<InputSourceRoots, "claudeAccountHome" | "codexAccountHome">> {
  const [claude, codex] = await Promise.all(
    AGENT_ACCOUNT_PLATFORMS.map((platform) => resolveActiveAgentAccount(context, platform)),
  );
  // The staged `.claude.json` must carry the host's current MCP servers.
  if (claude?.home) await prepareAgentAccountHome("claude", claude.home);
  return {
    ...(claude?.home ? { claudeAccountHome: claude.home } : {}),
    ...(codex?.home ? { codexAccountHome: codex.home } : {}),
  };
}

async function readLoginFile(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_LOGIN_FILE_BYTES) return undefined;
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Where the host login lives for staging, exactly as `portableInputSpec` reads it. */
function hostStagingSources(context: CommandContext): {
  claudeConfigDir: string | undefined;
  claudeJson: string;
  codexHome: string | undefined;
  grokAuth: string;
  opencodeAuth: string | undefined;
  piAuth: string;
} {
  const roots = defaultInputSourceRoots(
    context.runtimeFlavor,
    AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
  );
  const hostHome =
    roots.agentTest && roots.agentTestHostHome ? roots.agentTestHostHome : roots.home;
  return {
    claudeConfigDir: roots.agentTest ? roots.claudeConfigDir : path.join(roots.home, ".claude"),
    claudeJson: path.join(hostHome, ".claude.json"),
    codexHome: roots.agentTest ? roots.codexHome : path.join(roots.home, ".codex"),
    grokAuth: path.join(hostHome, ".grok", "auth.json"),
    opencodeAuth: roots.agentTest
      ? roots.xdgDataHome && path.join(roots.xdgDataHome, "opencode", "auth.json")
      : path.join(roots.home, ".local", "share", "opencode", "auth.json"),
    piAuth: path.join(hostHome, ".pi", "agent", "auth.json"),
  };
}

async function accountHasBeenUsed(
  context: CommandContext,
  platform: AgentAccountPlatform,
): Promise<boolean> {
  const store = await context.storage.loadAgentAccounts();
  return (
    Boolean(store.loginGeneration?.[platform]) ||
    Boolean(store.active[platform]) ||
    store.accounts.some((a) => a.platform === platform)
  );
}

/**
 * Rewrite one platform's staged login in a container's revision so its next
 * start imports the active account. Every login is re-read access-only, including
 * default-account revisions created before refresh tokens were restricted.
 * Only the host's current login can keep an access-only snapshot signed in.
 * Staging never acknowledges an installed account: only reconciliation can
 * prove which login was delivered into the running container.
 */
async function refreshStagedLogin(
  context: CommandContext,
  environment: Environment,
  revision: string,
  platform: AgentAccountPlatform,
  selected?: ResolvedAgentAccount,
): Promise<void> {
  const { global } = await context.storage.loadConfig();
  const active = selected ?? (await resolveActiveAgentAccount(context, platform));
  const host = hostStagingSources(context);
  const dataDir = context.storage.getDataDir();
  if (platform === "codex") {
    const home = active.home ?? host.codexHome;
    const auth = accessOnlyLoginText(
      "codex",
      home ? await readLoginFile(path.join(home, "auth.json")) : undefined,
    );
    await replaceStagedInputFile(dataDir, environment.id, revision, "codex-home/auth.json", auth);
    return;
  }
  if (active.home) await prepareAgentAccountHome("claude", active.home);
  const configDir = active.home ?? host.claudeConfigDir;
  const credentials =
    global.useHostClaudeCredentials === false
      ? undefined
      : configDir
        ? accessOnlyLoginText(
            "claude",
            await readLoginFile(path.join(configDir, ".credentials.json")),
          )
        : undefined;
  await replaceStagedInputFile(
    dataDir,
    environment.id,
    revision,
    "claude-config/.credentials.json",
    credentials,
  );
  // `.claude.json` is bind-mounted as a single file under whatever name the
  // source had, so it is found by listing and rewritten in place.
  const claudeJson = await readLoginFile(
    active.home ? path.join(active.home, ".claude.json") : host.claudeJson,
  );
  if (claudeJson === undefined) return;
  const stageDirectory = path.join(
    portableInputRevisionDirectory(dataDir, environment.id, revision),
    "files",
    "claude.json",
  );
  const [name] = await fs.readdir(stageDirectory).catch(() => [] as string[]);
  if (!name) return;
  await replaceStagedInputFile(
    dataDir,
    environment.id,
    revision,
    `files/claude.json/${name}`,
    claudeJson,
    { inPlace: true },
  );
}

/**
 * Point a container's staged logins at the active accounts. Called just
 * before `docker start`; best effort, because a stale login is reported
 * clearly by the agent while a failed start is not recoverable by the user.
 */
export async function refreshStagedAgentAccountLogins(
  context: CommandContext,
  environment: Environment,
  containerId: string,
  runners: ContainerRunners = defaultRunners,
): Promise<void> {
  try {
    const revision = await runners.label(containerId, DOCKER_LABEL_INPUTS_REVISION);
    if (!revision) return;
    const { global } = await context.storage.loadConfig();
    for (const platform of AGENT_ACCOUNT_PLATFORMS) {
      if (
        !providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, platform)
      ) {
        continue;
      }
      await refreshStagedLogin(context, environment, revision, platform);
    }
    for (const provider of PUSHED_LOGIN_PROVIDERS) {
      if (
        !providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, provider)
      ) {
        continue;
      }
      const login = PUSHED_LOGINS[provider];
      const source = login.hostFile(context);
      const auth = source ? await readLoginFile(source) : undefined;
      await replaceStagedInputFile(
        context.storage.getDataDir(),
        environment.id,
        revision,
        login.staged,
        accessOnlyLoginText(provider, auth),
      );
    }
  } catch (error) {
    logFailure("Failed to refresh staged agent logins", error);
  }
}

const PUSHED_LOGIN_PROVIDERS = ["grok", "opencode", "pi"] as const;
type PushedLoginProvider = (typeof PUSHED_LOGIN_PROVIDERS)[number];

/**
 * Keep credential staging and its start hand-off together. A no-op start must
 * leave the installed login and marker alone, especially while a bridge is busy.
 * On a real start the imported login is unknown until idle reconciliation; do
 * not acknowledge it from a restage hint, which may be lost or superseded.
 */
export async function startContainerWithAgentAccounts(
  context: CommandContext,
  environment: Environment | null,
  containerId: string,
  runners: ContainerRunners = defaultRunners,
): Promise<void> {
  const state = await runCommand("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    containerId,
  ]);
  const wasRunning = state.stdout.trim() === "true";
  if (!wasRunning && environment) {
    await refreshStagedAgentAccountLogins(context, environment, containerId, runners);
  }
  try {
    await runCommand("docker", ["start", containerId], { timeoutMs: 60_000 });
  } finally {
    // Docker may have started even when its client failed. Try before project
    // access setup or readiness waiting can fail. A stopped container refuses
    // exec and retains its old marker; the entrypoint also invalidates before
    // importing, including when no backend survives to finish this operation.
    if (!wasRunning) {
      await writeMarker(runners, containerId, "codex", UNSTAGED_CODEX_MARKER).catch(
        (error: unknown) => logFailure("Failed to invalidate the Codex account marker", error),
      );
    }
  }
}

/**
 * Where each pushed login comes from and goes. Grok's file holds one login and
 * is replaced. OpenCode's and Pi's hold one login per model provider, and the
 * user may have signed in to another provider inside the container, so the
 * host's providers are merged in (`buildMergeContainerProviderAuthCommand`).
 */
const PUSHED_LOGINS: Record<
  PushedLoginProvider,
  {
    label: string;
    staged: string;
    hostFile: (context: CommandContext) => string | undefined;
    /** The stdin for `command`, or undefined when the container gets nothing. */
    payload: (text: string) => string | undefined;
    command: string;
  }
> = {
  grok: {
    label: "Grok",
    staged: "grok-home/auth.json",
    hostFile: (context) => hostStagingSources(context).grokAuth,
    payload: (text) => accessOnlyLoginText("grok", text),
    command: SYNC_CONTAINER_GROK_AUTH_COMMAND,
  },
  opencode: {
    label: "OpenCode",
    staged: "opencode-data/auth.json",
    hostFile: (context) => hostStagingSources(context).opencodeAuth,
    payload: (text) => providerAuthMergePayload("opencode", text),
    command: buildMergeContainerProviderAuthCommand(CONTAINER_OPENCODE_AUTH_FILE),
  },
  pi: {
    label: "Pi",
    staged: "pi-config/agent/auth.json",
    hostFile: (context) => hostStagingSources(context).piAuth,
    payload: (text) => providerAuthMergePayload("pi", text),
    command: buildMergeContainerProviderAuthCommand(CONTAINER_PI_AUTH_FILE),
  },
};

/**
 * A host file whose logins have all expired still names its rotating
 * providers, and the merge then blanks any full copy the container holds
 * without handing it anything new: an expired access token is exactly when
 * that copy would spend its refresh token.
 */
function providerAuthMergePayload(format: "opencode" | "pi", text: string): string | undefined {
  const restricted = restrictProviderAuthEntries(format, text);
  const entries = "withheld" in restricted ? {} : restricted.entries;
  if (Object.keys(entries).length === 0 && restricted.accessOnly.length === 0) {
    return undefined;
  }
  return JSON.stringify({ logins: entries, accessOnly: restricted.accessOnly });
}

/**
 * Merge the host's access-only provider logins (`{ logins, accessOnly }` on
 * stdin) into a container's OpenCode or Pi `auth.json`. The host's entries
 * replace the container's for the same provider. Every provider in
 * `accessOnly` (a host OAuth login with a rotating refresh token) also loses
 * any refresh token the container's copy still holds, such as a full copy
 * imported before access-only staging. Other providers, signed in inside the
 * container, are kept. Pi's lock directory (`auth.json.lock`, from
 * proper-lockfile) is held for the write so a Pi in the container cannot
 * interleave. A lock still held after a second leaves the file alone until
 * the next push, however old it looks: Pi's asynchronous refresh holds it for
 * up to 30 s on a 15 s heartbeat, and Pi reclaims a stale one itself.
 */
export function buildMergeContainerProviderAuthCommand(file: string): string {
  const script = `
const fs = require("fs");
const path = require("path");
const file = process.argv[1];
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const lock = file + ".lock";
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
let locked = false;
for (let attempt = 0; attempt < 20 && !locked; attempt++) {
  try { fs.mkdirSync(lock); locked = true; }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Never reclaim another writer's lock: Pi owns its stale-lock protocol.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
if (!locked) process.exit(0);
try {
  let current = {};
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
    }
  } catch {}
  const next = { ...current, ...payload.logins };
  for (const provider of payload.accessOnly) {
    const entry = next[provider];
    if (entry && typeof entry === "object" && entry.type === "oauth") {
      next[provider] = { ...entry, refresh: "" };
    }
  }
  const temporary = path.join(path.dirname(file), ".auth.json." + process.pid + ".tmp");
  try {
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
} finally {
  fs.rmdirSync(lock);
}`;
  return `set -e
umask 077
node -e ${quoteShell(script)} ${quoteShell(file)}
`;
}

/**
 * Before a Grok, OpenCode or Pi bridge starts or is reused in a container:
 * hand it the host's current login, access-only. Their access tokens can last
 * only hours (Grok about six, Anthropic about eight) and the copy can never
 * refresh them, so this is what keeps a long-lived container signed in while
 * the host's own agent keeps refreshing. Pi reloads the file and OpenCode's
 * OAuth plugins read it (`Auth.get`) on each request, so a bridge that is
 * reused picks a renewed login up too; only a provider first signed in after
 * an OpenCode server started waits for that server to restart, as on the
 * host. A host with no usable login leaves the container's copy alone, as the
 * Claude sync does: it is either still valid or already signed out on its
 * own. OpenCode and Pi still strip a refresh token the copy holds for one of
 * the host's rotating providers (`providerAuthMergePayload`).
 */
export async function syncContainerLogin(
  context: CommandContext,
  provider: PushedLoginProvider,
  containerId: string,
  runners: ContainerRunners = defaultRunners,
): Promise<void> {
  const operationId = await containerBridgeOperationId(context, containerId);
  return enqueueContainerBridgeOperation(context, provider, operationId, () =>
    syncContainerLoginUnlocked(context, provider, containerId, runners),
  );
}

/** Caller holds the provider's bridge-operation queue through sync and bridge startup. */
export async function syncContainerLoginUnlocked(
  context: CommandContext,
  provider: PushedLoginProvider,
  containerId: string,
  runners: ContainerRunners = defaultRunners,
): Promise<void> {
  const login = PUSHED_LOGINS[provider];
  try {
    const environment = (await context.storage.loadEnvironments()).find(
      (candidate) =>
        candidate.containerId && containerIdMatches(candidate.containerId, containerId),
    );
    if (!environment) return;
    const { global } = await context.storage.loadConfig();
    if (!providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, provider)) {
      return;
    }
    const source = login.hostFile(context);
    const text = source ? await readLoginFile(source) : undefined;
    const payload = text === undefined ? undefined : login.payload(text);
    // Revocation is persisted before its queued cleanup. Re-read after host I/O
    // so a revoke requested during the read also fences this delivery.
    const current = await context.storage.getEnvironment(environment.id);
    const config = await context.storage.loadConfig();
    if (
      payload &&
      current &&
      current.containerId &&
      containerIdMatches(current.containerId, containerId) &&
      providerCredentialsAllowed(context, config.global.enabledAgentPlatforms, current, provider)
    ) {
      await runners.pipe(containerId, login.command, payload);
    }
  } catch (error) {
    logFailure(`Failed to sync the ${login.label} login into the container`, error);
  }
}

/**
 * The Claude credential a container should hold for the active account.
 * `useHostClaudeCredentials: false` keeps every Orkestrator-held Claude token
 * out of containers, whichever account it belongs to.
 */
async function containerClaudeCredentials(
  context: CommandContext,
  global: AppConfig["global"],
  active: ResolvedAgentAccount,
): Promise<string | undefined> {
  return accessOnlyLoginText("claude", await activeClaudeCredentials(context, global, active));
}

/** The active account's whole Claude credential, refresh token included. Never leaves the host. */
export async function activeClaudeCredentials(
  context: CommandContext,
  global: AppConfig["global"],
  account?: ResolvedAgentAccount,
): Promise<string | undefined> {
  if (global.useHostClaudeCredentials === false) return undefined;
  const active = account ?? (await resolveActiveAgentAccount(context, "claude"));
  return active.home
    ? await readAddedClaudeCredentials(active.home)
    : await resolveContainerClaudeCredentials(global);
}

/**
 * Remove every refresh token from the container's own Claude credential, in
 * place. For when the host has no usable access token to hand over: a copy
 * imported before containers were access-only, or through a host mount, must
 * not keep the host's refresh token while it waits. An unreadable file is
 * removed rather than kept whole.
 */
export function buildRestrictContainerClaudeCredentialCommand(
  credentialFile = CONTAINER_CLAUDE_CREDENTIAL_FILE,
): string {
  return `
  credential_file=${quoteShell(credentialFile)}
  if [ -f "$credential_file" ] && [ ! -L "$credential_file" ]; then
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      const login = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!login || typeof login !== "object" || Array.isArray(login)) process.exit(1);
      let changed = false;
      const strip = (entry) => {
        if (entry && typeof entry === "object" && "refreshToken" in entry) {
          delete entry.refreshToken;
          changed = true;
        }
      };
      strip(login.claudeAiOauth);
      if (login.mcpOAuth && typeof login.mcpOAuth === "object") Object.values(login.mcpOAuth).forEach(strip);
      if (!changed) process.exit(0);
      const temporary = file + "." + process.pid + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify(login), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    ' "$credential_file" 2>/dev/null || rm -f "$credential_file" "$credential_file".*.tmp
  fi
  true
`;
}
const RESTRICT_CONTAINER_CLAUDE_CREDENTIAL_COMMAND =
  buildRestrictContainerClaudeCredentialCommand();

/**
 * Point the running container's `~/.claude.json` at the active account's
 * identity. The entrypoint copies the staged file only at start, so without
 * this `claude auth status` inside names the previous account after a switch.
 * stdin is `{"oauthAccount": …}`, or `{}` to drop a stale identity. A missing
 * or unreadable file is left alone.
 */
export const SYNC_CONTAINER_CLAUDE_ACCOUNT_COMMAND = `
  node -e '
    const fs = require("fs");
    const file = require("os").homedir() + "/.claude.json";
    const update = JSON.parse(fs.readFileSync(0, "utf8"));
    let config;
    try {
      // A missing file is left for the entrypoint to create; a symlink is never followed.
      if (fs.lstatSync(file).isSymbolicLink()) process.exit(0);
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      process.exit(0);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) process.exit(0);
    if (update.oauthAccount) config.oauthAccount = update.oauthAccount;
    else if (!("oauthAccount" in config)) process.exit(0);
    else delete config.oauthAccount;
    const temporary = file + "." + process.pid + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  '
`;

/** Identity reads follow host dotfile links, bounded by the staging file limit. */
async function activeClaudeOAuthAccount(
  context: CommandContext,
  selected?: ResolvedAgentAccount,
): Promise<{ oauthAccount?: unknown } | undefined> {
  const active = selected ?? (await resolveActiveAgentAccount(context, "claude"));
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      active.home ? path.join(active.home, ".claude.json") : hostStagingSources(context).claudeJson,
      "r",
    );
    const limit = INPUT_LIMITS.fileBytes;
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return undefined;
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) return undefined;
    const config = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
    const account = config.oauthAccount;
    return account && typeof account === "object" && !Array.isArray(account)
      ? { oauthAccount: account }
      : {};
  } catch {
    // Unreadable is not signed out: leave the container's identity unchanged.
    return undefined;
  } finally {
    await handle?.close();
  }
}

/**
 * Asks the host to refresh the active Claude login when it is due
 * (`ContainerClaudeLoginKeeper.refreshHostIfDue`), registered by the backend.
 * A container start that finds the host token expired uses it rather than
 * leaving the container signed out until the keeper's next pass.
 */
let hostClaudeLoginRefresher: (() => Promise<unknown>) | undefined;

export function setHostClaudeLoginRefresher(refresher: (() => Promise<unknown>) | undefined): void {
  hostClaudeLoginRefresher = refresher;
}

/** The access-only login to hand over, asking the host to refresh first if it is due. */
async function freshContainerClaudeCredentials(
  context: CommandContext,
  global: AppConfig["global"],
  account?: ResolvedAgentAccount,
): Promise<string | undefined> {
  if (global.useHostClaudeCredentials === false) return undefined;
  const active = account ?? (await resolveActiveAgentAccount(context, "claude"));
  // MCP entries can survive an expired subscription login. Always run the due
  // check, which also handles usable tokens already inside the refresh window.
  await hostClaudeLoginRefresher?.().catch(() => undefined);
  return containerClaudeCredentials(context, global, active);
}

/**
 * What each container was last handed, as a digest of the access-only text,
 * so the keeper only writes into a container when the host's login changed.
 * Lost on restart, when every running container is simply pushed once more.
 */
const pushedClaudeLogins = new Map<string, string>();

function loginDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function pipeClaudeLogin(
  runners: ContainerRunners,
  containerId: string,
  text: string,
): Promise<void> {
  await runners.pipe(containerId, SYNC_CONTAINER_CLAUDE_CREDENTIAL_COMMAND, text);
  pushedClaudeLogins.set(containerId, loginDigest(text));
}

async function removeClaudeLogin(runners: ContainerRunners, containerId: string): Promise<void> {
  await runners.exec(containerId, `rm -f ${CONTAINER_CLAUDE_CREDENTIAL_FILE}`);
  pushedClaudeLogins.delete(containerId);
}

async function restrictClaudeLogin(runners: ContainerRunners, containerId: string): Promise<void> {
  await runners.exec(containerId, RESTRICT_CONTAINER_CLAUDE_CREDENTIAL_COMMAND);
  pushedClaudeLogins.delete(containerId);
}

/**
 * Hand a running container the active account's current Claude access token,
 * when it is on that account and holds anything else. Before every Claude
 * bridge start, and from the keeper whenever the host's login renews: the
 * container's CLI cannot refresh, but it re-reads `.credentials.json` when its
 * mtime changes, so a fresh token reaches even a bridge that is mid-turn.
 *
 * A container on another account is left to `reconcileContainerAgentAccount`.
 * With no usable token to hand over, `restrictWhenUnusable` strips any refresh
 * token the container's copy still holds instead. Caller holds the Claude
 * bridge-operation queue. Returns whether anything was written.
 */
export async function syncContainerClaudeLoginUnlocked(
  context: CommandContext,
  containerId: string,
  options: { restrictWhenUnusable?: boolean; runners?: ContainerRunners } = {},
): Promise<boolean> {
  const runners = options.runners ?? defaultRunners;
  try {
    const environment = await environmentForContainer(context, containerId);
    if (!environment) return false;
    const { global } = await context.storage.loadConfig();
    if (
      global.useHostClaudeCredentials === false ||
      !providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, "claude")
    ) {
      return false;
    }
    // Account and generation come from one authoritative snapshot. Credential
    // reads stay pinned to it even if the selection changes during marker I/O.
    const store = await context.storage.loadAgentAccounts();
    const accountId = store.active.claude ?? DEFAULT_AGENT_ACCOUNT_ID;
    const generation = store.loginGeneration?.claude;
    const expected = generation ? `${accountId}:${generation}` : accountId;
    const active = {
      accountId,
      ...(store.active.claude
        ? { home: agentAccountHome(context.storage.agentAccountsDirectory(), "claude", accountId) }
        : {}),
    };
    if ((await readMarker(runners, containerId, "claude")) !== expected) return false;
    const text = await freshContainerClaudeCredentials(context, global, active);
    // Revocation is persisted before its queued cleanup. Re-read after host I/O
    // so a revoke requested during the read also fences this delivery.
    const current = await context.storage.getEnvironment(environment.id);
    const config = await context.storage.loadConfig();
    if (
      !current?.containerId ||
      !containerIdMatches(current.containerId, containerId) ||
      config.global.useHostClaudeCredentials === false ||
      !providerCredentialsAllowed(
        context,
        config.global.enabledAgentPlatforms,
        current,
        "claude",
      ) ||
      (await currentAccountMarker(context, "claude")) !== expected
    ) {
      return false;
    }
    if (!text) {
      if (options.restrictWhenUnusable) await restrictClaudeLogin(runners, containerId);
      return false;
    }
    if (pushedClaudeLogins.get(containerId) === loginDigest(text)) return false;
    await pipeClaudeLogin(runners, containerId, text);
    return true;
  } catch (error) {
    logFailure("Failed to sync the Claude login into the container", error);
    return false;
  }
}

/** `syncContainerClaudeLoginUnlocked` under the container's Claude bridge-operation queue. */
export async function syncContainerClaudeLogin(
  context: CommandContext,
  containerId: string,
  options: { restrictWhenUnusable?: boolean; runners?: ContainerRunners } = {},
): Promise<boolean> {
  const operationId = await containerBridgeOperationId(context, containerId);
  return enqueueContainerBridgeOperation(context, "claude", operationId, () =>
    syncContainerClaudeLoginUnlocked(context, operationId, options),
  );
}

async function environmentForContainer(
  context: CommandContext,
  containerId: string,
): Promise<Environment | undefined> {
  return (await context.storage.loadEnvironments()).find(
    (candidate) => candidate.containerId && containerIdMatches(candidate.containerId, containerId),
  );
}

async function currentAccountMarker(
  context: CommandContext,
  platform: AgentAccountPlatform,
): Promise<string> {
  const store = await context.storage.loadAgentAccounts();
  const accountId = store.active[platform] ?? DEFAULT_AGENT_ACCOUNT_ID;
  const generation = store.loginGeneration?.[platform];
  return generation ? `${accountId}:${generation}` : accountId;
}

function accountMarker(active: ResolvedAgentAccount): string {
  return active.loginGeneration
    ? `${active.accountId}:${active.loginGeneration}`
    : active.accountId;
}

async function writeMarker(
  runners: ContainerRunners,
  containerId: string,
  platform: AgentAccountPlatform,
  accountId: string,
): Promise<void> {
  await runners.exec(
    containerId,
    `umask 077; printf '%s' ${quoteShell(accountId)} > ${ACCOUNT_MARKER[platform]}`,
  );
}

/**
 * The account a running container's login belongs to, from its marker: an
 * account id, or `default` for the host login.
 */
export async function readContainerAgentAccountId(
  containerId: string,
  platform: AgentAccountPlatform,
  runners: ContainerRunners = defaultRunners,
): Promise<string> {
  return (
    (await readMarker(runners, containerId, platform)).split(":")[0] || DEFAULT_AGENT_ACCOUNT_ID
  );
}

async function readMarker(
  runners: ContainerRunners,
  containerId: string,
  platform: AgentAccountPlatform,
): Promise<string> {
  const marker = (
    await runners.exec(containerId, `cat ${ACCOUNT_MARKER[platform]} 2>/dev/null || true`)
  ).trim();
  return marker || DEFAULT_AGENT_ACCOUNT_ID;
}

/**
 * The environment start path's credential step, replacing the host-only
 * Claude sync. Claude's login is piped in on every start, as it always was,
 * now for the active account. Codex is reconciled on the next idle bridge
 * request after a real start invalidates its marker. This later step must not
 * infer an import from staging or overwrite a marker on a no-op start.
 */
export async function syncContainerAgentAccountsOnStart(
  context: CommandContext,
  environment: Pick<Environment, "revokedInputProviders"> | null | undefined,
  containerId: string,
  global: AppConfig["global"],
  runners: ContainerRunners = defaultRunners,
): Promise<void> {
  if (providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, "claude")) {
    try {
      // Capture before reading/copying: a concurrent renewal must not stamp
      // an older credential with the newer generation.
      const active = await resolveActiveAgentAccount(context, "claude");
      const marker = accountMarker(active);
      const credentials = await freshContainerClaudeCredentials(context, global, active);
      if (credentials) {
        await pipeClaudeLogin(runners, containerId, credentials);
      } else if (
        global.useHostClaudeCredentials === false ||
        (await accountHasBeenUsed(context, "claude"))
      ) {
        await removeClaudeLogin(runners, containerId);
      } else {
        // The host has no usable token: whatever the container kept must
        // still not be able to refresh the host's login.
        await restrictClaudeLogin(runners, containerId);
      }
      if (await accountHasBeenUsed(context, "claude")) {
        await writeMarker(runners, containerId, "claude", marker);
      }
    } catch (error) {
      logFailure("Failed to sync Claude credentials into container", error);
    }
  }
}

/** Write one platform's active login into a running container. */
async function pushContainerLogin(
  context: CommandContext,
  runners: ContainerRunners,
  containerId: string,
  platform: AgentAccountPlatform,
  global: AppConfig["global"],
  active: ResolvedAgentAccount,
): Promise<void> {
  if (platform === "claude") {
    if (global.useHostClaudeCredentials === false) {
      await removeClaudeLogin(runners, containerId);
      return;
    }
    const credentials = await freshContainerClaudeCredentials(context, global, active);
    if (credentials) {
      await pipeClaudeLogin(runners, containerId, credentials);
    } else {
      // Signed out beats silently staying on the previous account.
      await removeClaudeLogin(runners, containerId);
    }
    const identity = await activeClaudeOAuthAccount(context, active);
    if (identity === undefined) return;
    await runners
      .pipe(containerId, SYNC_CONTAINER_CLAUDE_ACCOUNT_COMMAND, JSON.stringify(identity))
      .catch((error: unknown) =>
        logFailure("Failed to update the container's Claude account", error),
      );
    return;
  }
  const home = active.home ?? hostStagingSources(context).codexHome;
  const auth = accessOnlyLoginText(
    "codex",
    home ? await readLoginFile(path.join(home, "auth.json")) : undefined,
  );
  if (!auth) {
    await runners.exec(containerId, `rm -f ${CONTAINER_CODEX_AUTH_FILE}`);
    return;
  }
  await runners.pipe(containerId, SYNC_CONTAINER_CODEX_AUTH_COMMAND, auth);
}

function containerIdMatches(known: string, candidate: string): boolean {
  const left = known.trim();
  const right = candidate.trim();
  return (
    left.length > 0 &&
    right.length > 0 &&
    (left === right || left.startsWith(right) || right.startsWith(left))
  );
}

export interface ContainerBridgeControl {
  isRunning: () => Promise<boolean>;
  stop: () => Promise<void>;
}

/**
 * Before an in-container bridge is started or reused: if the container holds
 * another account's login and the bridge is idle, write the active account's
 * login in and stop the bridge so the start that follows launches on it. A
 * bridge with live work keeps its account until it is idle, as local ones do.
 */
export async function reconcileContainerAgentAccount(
  context: CommandContext,
  containerId: string,
  platform: AgentAccountPlatform,
  bridge: ContainerBridgeControl,
  runners: ContainerRunners = defaultRunners,
): Promise<void> {
  const environment = (await context.storage.loadEnvironments()).find(
    (candidate) => candidate.containerId && containerIdMatches(candidate.containerId, containerId),
  );
  if (!environment) return;
  const { global } = await context.storage.loadConfig();
  // The account was signed in again: the container still holds the login it
  // was given before, whichever account that was.
  const loginRenewed =
    platform === "claude" && context.runtime.localServers.hasStaleContainerLogin(environment.id);
  // An opt-out must revoke a credential already placed in an older container.
  if (
    !loginRenewed &&
    !(await accountHasBeenUsed(context, platform)) &&
    !(platform === "claude" && global.useHostClaudeCredentials === false)
  )
    return;
  if (!providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, platform)) {
    return;
  }
  const active = await resolveActiveAgentAccount(context, platform);
  const expectedMarker = accountMarker(active);
  const markerMatches = (await readMarker(runners, containerId, platform)) === expectedMarker;
  if (
    markerMatches &&
    !loginRenewed &&
    !(platform === "claude" && global.useHostClaudeCredentials === false)
  )
    return;
  if (await context.nativeAgents?.hasObservedLiveWork(environment.id, platform)) {
    return;
  }
  const running = await bridge.isRunning();
  await pushContainerLogin(context, runners, containerId, platform, global, active);
  const revision = await runners.label(containerId, DOCKER_LABEL_INPUTS_REVISION);
  if (revision) {
    await refreshStagedLogin(context, environment, revision, platform, active).catch(
      (error: unknown) => logFailure("Failed to refresh the staged login", error),
    );
  }
  if (running) await bridge.stop();
  // Publish completion only after the old bridge has relinquished its login.
  await writeMarker(runners, containerId, platform, expectedMarker);
  if (platform === "claude") context.runtime.localServers.clearStaleContainerLogin(environment.id);
}

/**
 * After the active Claude login was renewed on the host: have each container
 * that uses it take the new login the next time its idle bridge starts or is
 * reused. Containers with their own isolated login keep it.
 */
export async function markContainersForClaudeLoginRefresh(
  context: CommandContext,
  generationPersisted = false,
): Promise<void> {
  if (!generationPersisted)
    await context.storage.mutateAgentAccounts((store) => ({
      store: {
        ...store,
        loginGeneration: { ...store.loginGeneration, claude: crypto.randomUUID() },
      },
      result: undefined,
    }));
  const { global } = await context.storage.loadConfig();
  if (global.useHostClaudeCredentials === false) return;
  for (const environment of await context.storage.loadEnvironments()) {
    if (environment.containerId)
      context.runtime.localServers.markContainerLoginStale(environment.id);
  }
}
