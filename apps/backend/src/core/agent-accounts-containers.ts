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
 * Codex and Grok refresh tokens are single-use, so a container only ever gets
 * their logins access-only (`accessOnlyLoginText`): a copy that refreshed
 * would sign the host out. Both are therefore re-read from the host before
 * every start, and Grok's, whose access token lasts hours rather than days,
 * also before every Grok bridge start.
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
 *
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
  if (
    platform === "claude" &&
    !(await accountHasBeenUsed(context, platform)) &&
    global.useHostClaudeCredentials !== false
  )
    return;
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
        ? await readLoginFile(path.join(configDir, ".credentials.json"))
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
  global: AppConfig["global"],
  active: ResolvedAgentAccount,
): Promise<string | undefined> {
  if (global.useHostClaudeCredentials === false) return undefined;
  return active.home
    ? await readAddedClaudeCredentials(active.home)
    : await resolveContainerClaudeCredentials(global);
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
      const credentials = await containerClaudeCredentials(global, active);
      if (credentials) {
        await runners.pipe(containerId, SYNC_CONTAINER_CLAUDE_CREDENTIAL_COMMAND, credentials);
      } else if (
        global.useHostClaudeCredentials === false ||
        (await accountHasBeenUsed(context, "claude"))
      ) {
        await runners.exec(containerId, `rm -f ${CONTAINER_CLAUDE_CREDENTIAL_FILE}`);
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
      await runners.exec(containerId, `rm -f ${CONTAINER_CLAUDE_CREDENTIAL_FILE}`);
      return;
    }
    const credentials = await containerClaudeCredentials(global, active);
    if (credentials) {
      await runners.pipe(containerId, SYNC_CONTAINER_CLAUDE_CREDENTIAL_COMMAND, credentials);
    } else {
      // Signed out beats silently staying on the previous account.
      await runners.exec(containerId, `rm -f ${CONTAINER_CLAUDE_CREDENTIAL_FILE}`);
    }
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
