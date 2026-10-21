import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  AGENT_ACCOUNT_PLATFORMS,
  DEFAULT_AGENT_ACCOUNT_ID,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";

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
} from "./commands-runtime-state.js";
import { DOCKER_LABEL_INPUTS_REVISION } from "./constants.js";
import { runCommand } from "./shell.js";
import {
  accessOnlyLoginText,
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
import { staleLoginEnvironmentIds } from "./agent-account-bridge-state.js";
import { prepareAgentAccountHome } from "./agent-accounts-homes.js";
import { readAddedClaudeCredentials, resolveActiveAgentAccount } from "./agent-accounts-active.js";

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
 * back; the marker is cleared on start so the next bridge start re-applies it.
 *
 * Claude, Codex and Grok refresh tokens are single-use, so a container only
 * ever gets their logins access-only (`accessOnlyLoginText`): a copy that
 * refreshed would sign the host out. They are therefore re-read from the host
 * before every start. Claude's and Grok's access tokens last hours rather than
 * days, so theirs are also pushed before every bridge start, and Claude's
 * whenever the host's renews while the container runs
 * (`container-claude-login-keeper.ts`).
 */

const ACCOUNT_MARKER: Record<AgentAccountPlatform, string> = {
  claude: "/tmp/orkestrator-claude-account",
  codex: "/tmp/orkestrator-codex-account",
};
const CONTAINER_CODEX_AUTH_FILE = "/home/node/.codex/auth.json";
const SYNC_CONTAINER_CODEX_AUTH_COMMAND =
  buildSyncContainerClaudeCredentialCommand(CONTAINER_CODEX_AUTH_FILE);
const CONTAINER_GROK_AUTH_FILE = "/home/node/.grok/auth.json";
const SYNC_CONTAINER_GROK_AUTH_COMMAND =
  buildSyncContainerClaudeCredentialCommand(CONTAINER_GROK_AUTH_FILE);
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
 * start imports the active account. A Claude user who never added an account
 * keeps the snapshot taken when the container was created. Codex is always
 * re-read, access-only: the snapshot a container was created with cannot
 * refresh, so only the host's current login keeps it signed in.
 */
async function refreshStagedLogin(
  context: CommandContext,
  environment: Environment,
  revision: string,
  platform: AgentAccountPlatform,
): Promise<void> {
  const { global } = await context.storage.loadConfig();
  if (
    platform === "claude" &&
    !(await accountHasBeenUsed(context, platform)) &&
    global.useHostClaudeCredentials !== false
  )
    return;
  const active = await resolveActiveAgentAccount(context, platform);
  const host = hostStagingSources(context);
  const dataDir = context.storage.getDataDir();
  if (platform === "codex") {
    const home = active.home ?? host.codexHome;
    const auth = home ? await readLoginFile(path.join(home, "auth.json")) : undefined;
    await replaceStagedInputFile(
      dataDir,
      environment.id,
      revision,
      "codex-home/auth.json",
      accessOnlyLoginText("codex", auth),
    );
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
    if (providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, "grok")) {
      const auth = await readLoginFile(hostStagingSources(context).grokAuth);
      await replaceStagedInputFile(
        context.storage.getDataDir(),
        environment.id,
        revision,
        "grok-home/auth.json",
        accessOnlyLoginText("grok", auth),
      );
    }
  } catch (error) {
    logFailure("Failed to refresh staged agent logins", error);
  }
}

/**
 * Before a Grok bridge starts or is reused in a container: hand it the host's
 * current login, access-only. Grok's access token lasts about six hours and
 * the copy can never refresh it, so this is what keeps a long-lived container
 * signed in while the host's own Grok keeps refreshing. A host with no usable
 * login leaves the container's copy alone, as the Claude sync does: it is
 * either still valid or already signed out on its own.
 */
export async function syncContainerGrokLogin(
  context: CommandContext,
  containerId: string,
  runners: ContainerRunners = defaultRunners,
): Promise<void> {
  const operationId = await containerBridgeOperationId(context, containerId);
  return enqueueContainerBridgeOperation("grok", operationId, () =>
    syncContainerGrokLoginUnlocked(context, containerId, runners),
  );
}

/** Caller holds the Grok bridge-operation queue through sync and bridge startup. */
export async function syncContainerGrokLoginUnlocked(
  context: CommandContext,
  containerId: string,
  runners: ContainerRunners = defaultRunners,
): Promise<void> {
  try {
    const environment = (await context.storage.loadEnvironments()).find(
      (candidate) =>
        candidate.containerId && containerIdMatches(candidate.containerId, containerId),
    );
    if (!environment) return;
    const { global } = await context.storage.loadConfig();
    if (!providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, "grok")) {
      return;
    }
    const auth = accessOnlyLoginText(
      "grok",
      await readLoginFile(hostStagingSources(context).grokAuth),
    );
    // Revocation is persisted before its queued cleanup. Re-read after host I/O
    // so a revoke requested during the read also fences this delivery.
    const current = await context.storage.getEnvironment(environment.id);
    const config = await context.storage.loadConfig();
    if (
      auth &&
      current &&
      current.containerId &&
      containerIdMatches(current.containerId, containerId) &&
      providerCredentialsAllowed(context, config.global.enabledAgentPlatforms, current, "grok")
    ) {
      await runners.pipe(containerId, SYNC_CONTAINER_GROK_AUTH_COMMAND, auth);
    }
  } catch (error) {
    logFailure("Failed to sync the Grok login into the container", error);
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
): Promise<string | undefined> {
  return accessOnlyLoginText("claude", await activeClaudeCredentials(context, global));
}

/** The active account's whole Claude credential, refresh token included. Never leaves the host. */
export async function activeClaudeCredentials(
  context: CommandContext,
  global: AppConfig["global"],
): Promise<string | undefined> {
  if (global.useHostClaudeCredentials === false) return undefined;
  const active = await resolveActiveAgentAccount(context, "claude");
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

/** The active Claude account's `oauthAccount`: identity only, never a credential. */
async function activeClaudeOAuthAccount(context: CommandContext): Promise<unknown> {
  const active = await resolveActiveAgentAccount(context, "claude");
  const text = await readLoginFile(
    active.home ? path.join(active.home, ".claude.json") : hostStagingSources(context).claudeJson,
  );
  try {
    const account = (JSON.parse(text ?? "") as { oauthAccount?: unknown }).oauthAccount;
    return account && typeof account === "object" && !Array.isArray(account) ? account : undefined;
  } catch {
    return undefined;
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
): Promise<string | undefined> {
  const text = await containerClaudeCredentials(context, global);
  if (text || !hostClaudeLoginRefresher) return text;
  await hostClaudeLoginRefresher().catch(() => undefined);
  return containerClaudeCredentials(context, global);
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
    if (await accountHasBeenUsed(context, "claude")) {
      const expected = await currentAccountMarker(context, "claude");
      if ((await readMarker(runners, containerId, "claude")) !== expected) return false;
    }
    const text = await freshContainerClaudeCredentials(context, global);
    // Revocation is persisted before its queued cleanup. Re-read after host I/O
    // so a revoke requested during the read also fences this delivery.
    const current = await context.storage.getEnvironment(environment.id);
    const config = await context.storage.loadConfig();
    if (
      !current?.containerId ||
      !containerIdMatches(current.containerId, containerId) ||
      config.global.useHostClaudeCredentials === false ||
      !providerCredentialsAllowed(context, config.global.enabledAgentPlatforms, current, "claude")
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
  return enqueueContainerBridgeOperation("claude", operationId, () =>
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
 * now for the active account. Codex imports its staged login in the
 * entrypoint, so only its marker is cleared: on an older image that re-import
 * came from the host, and the next bridge start re-applies the account.
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
      const marker = await currentAccountMarker(context, "claude");
      const credentials = await freshContainerClaudeCredentials(context, global);
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
  if (
    providerCredentialsAllowed(context, global.enabledAgentPlatforms, environment, "codex") &&
    (await accountHasBeenUsed(context, "codex").catch(() => false))
  ) {
    await runners
      .exec(containerId, `rm -f ${ACCOUNT_MARKER.codex}`)
      .catch((error: unknown) => logFailure("Failed to reset the Codex account marker", error));
  }
}

/** Write one platform's active login into a running container. */
async function pushContainerLogin(
  context: CommandContext,
  runners: ContainerRunners,
  containerId: string,
  platform: AgentAccountPlatform,
  global: AppConfig["global"],
): Promise<void> {
  if (platform === "claude") {
    if (global.useHostClaudeCredentials === false) {
      await removeClaudeLogin(runners, containerId);
      return;
    }
    const credentials = await freshContainerClaudeCredentials(context, global);
    if (credentials) {
      await pipeClaudeLogin(runners, containerId, credentials);
    } else {
      // Signed out beats silently staying on the previous account.
      await removeClaudeLogin(runners, containerId);
    }
    const oauthAccount = await activeClaudeOAuthAccount(context);
    await runners
      .pipe(
        containerId,
        SYNC_CONTAINER_CLAUDE_ACCOUNT_COMMAND,
        JSON.stringify(oauthAccount ? { oauthAccount } : {}),
      )
      .catch((error: unknown) =>
        logFailure("Failed to update the container's Claude account", error),
      );
    return;
  }
  const active = await resolveActiveAgentAccount(context, "codex");
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
  const loginRenewed = platform === "claude" && staleLoginEnvironmentIds.has(environment.id);
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
  const generation = (await context.storage.loadAgentAccounts()).loginGeneration?.[platform];
  const expectedMarker = generation ? `${active.accountId}:${generation}` : active.accountId;
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
  await pushContainerLogin(context, runners, containerId, platform, global);
  const revision = await runners.label(containerId, DOCKER_LABEL_INPUTS_REVISION);
  if (revision) {
    await refreshStagedLogin(context, environment, revision, platform).catch((error: unknown) =>
      logFailure("Failed to refresh the staged login", error),
    );
  }
  if (running) await bridge.stop();
  // Publish completion only after the old bridge has relinquished its login.
  await writeMarker(runners, containerId, platform, expectedMarker);
  if (platform === "claude") staleLoginEnvironmentIds.delete(environment.id);
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
    if (environment.containerId) staleLoginEnvironmentIds.add(environment.id);
  }
}
