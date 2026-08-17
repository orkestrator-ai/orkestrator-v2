import { path, createHash, resolveComparisonRef, DiffStatsService, GitFetchScheduler, runCommand, spawnCommand, terminateProcessTree } from "./commands-dependencies.js";
import type { ChildProcessWithoutNullStreams, ClientEnvironment, Environment, PtyProcess } from "./commands-dependencies.js";
import type { CommandContext, BackendEmit } from "./commands-context.js";

export type TerminalSessionConfig =
  ({
    kind: "container";
    containerId: string;
    cols: number;
    rows: number;
    user?: string;
    environmentId?: string;
    activityEnvironmentId?: string;
    trackEnvironmentActivity?: boolean;
  }
  | {
    kind: "local";
    environmentId: string;
    cols: number;
    rows: number;
    trackEnvironmentActivity?: boolean;
  }) & { bootstrapped?: boolean };

export const terminalProcesses = new Map<string, PtyProcess>();
export const terminalSessionConfigs = new Map<string, TerminalSessionConfig>();
export type TerminalOutputBuffer = {
  chunks: string[];
  headIndex: number;
  headOffset: number;
  length: number;
};

export const terminalOutputBuffers = new Map<string, TerminalOutputBuffer>();
export const terminalOutputRevisions = new Map<string, number>();
export const terminalOutputGenerations = new Map<string, number>();
export type TerminalOutputDelta = { revision: number; text: string };
export const terminalOutputDeltas = new Map<string, TerminalOutputDelta[]>();
export const terminalOutputDeltaBytes = new Map<string, number>();
export const terminalOutputTruncated = new Set<string>();
export const terminalOutputRetentionTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
export const terminalSessionIdsByStableKey = new Map<string, string>();
export const terminalStableKeysBySessionId = new Map<string, string>();
export const orphanedTerminalMissingSince = new Map<string, number>();
export const terminalActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const terminalActivityArmed = new Set<string>();
export const terminalActivityGenerations = new Map<string, number>();
export const terminalActivityCompletions = new Map<string, number>();
export type TerminalActivityCompletionState = {
  id: string;
  generation: number;
  cancelled: boolean;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
};
export const terminalActivityCompletionStates = new Map<number, TerminalActivityCompletionState>();
export let nextTerminalActivityGeneration = 0;
export function nextTerminalActivityGenerationValue(): number {
  nextTerminalActivityGeneration += 1;
  return nextTerminalActivityGeneration;
}
export const localServerProcesses = new Map<string, ChildProcessWithoutNullStreams>();
/** Per-process bearer tokens for renderer → local Codex bridge requests. */
export const localCodexBridgeTokens = new Map<string, string>();
/** Per-process bearer tokens for renderer → local Claude bridge requests. */
export const localClaudeBridgeTokens = new Map<string, string>();
/** Per-process HTTP Basic passwords for renderer → local OpenCode requests. */
export const localOpenCodeServerPasswords = new Map<string, string>();
/** Per-process bearer tokens for renderer → ACP bridge requests. */
export const localCursorBridgeTokens = new Map<string, string>();
export const localGrokBridgeTokens = new Map<string, string>();
/** Credential generation used by each live local Cursor bridge. */
export const localCursorCredentialFingerprints = new Map<string, string>();
export type OpenCodeAgentToolsConfiguration = {
  fingerprint: string;
  controller: AbortController;
  task: Promise<void>;
};
/** Backend-owned reconciliation; native tabs must not be its lifecycle owner. */
export const openCodeAgentToolsConfigurations = new Map<
  string,
  OpenCodeAgentToolsConfiguration
>();
/**
 * What reconciliation last established about a server generation, and when.
 *
 * `connected` memoizes a successful POST so ordinary status reads do no I/O;
 * `unavailable` records an exhausted retry cycle so status can report degraded
 * ticket tools instead of failing silently. Both entries expire — see
 * `openCodeAgentToolsMemoWindowMs`.
 */
export type OpenCodeAgentToolsOutcome = {
  fingerprint: string;
  state: "connected" | "unavailable";
  /** `Date.now()` when this outcome was recorded. */
  at: number;
};
export const configuredOpenCodeAgentTools = new Map<
  string,
  OpenCodeAgentToolsOutcome
>();
/** Shape of a base64url-encoded 32-byte bridge token persisted in the container. */
export const BRIDGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const localServerEnvironmentOperations = new Map<string, Promise<void>>();
export const containerBridgeOperations = new Map<string, Promise<void>>();
export const deletingLocalServerEnvironments = new Set<string>();
export const mergingEnvironments = new Set<string>();
export const mergeCleanupRecoveryTasks = new Map<string, Promise<void>>();
export type LocalServerKind = "opencode" | "claude" | "codex" | "cursor" | "grok";
/** The ACP-speaking subset of `LocalServerKind`, launched through the ACP bridge. */
export type AcpLocalServerKind = Extract<LocalServerKind, "cursor" | "grok">;

export function retryableBridgeStartupError(
  message: string,
  retryAfterMs = 500,
): Error & { retryable: true; retryAfterMs: number } {
  return Object.assign(new Error(message), { retryable: true as const, retryAfterMs });
}
export const LOCAL_SERVER_KINDS: readonly LocalServerKind[] = ["opencode", "claude", "codex", "cursor", "grok"];
// Codex bridge shutdown can spend five seconds draining app-server before its
// one-second hard-kill fallback. Give that path time to reap the MCP process
// group before escalating the bridge itself.
export const LOCAL_SERVER_SHUTDOWN_GRACE_MS = 8_000;
export const LOCAL_SERVER_KILL_WAIT_MS = 1_000;
export const LOCAL_SERVER_HEALTH_ATTEMPTS = 75;
export const LOCAL_SERVER_HEALTH_INTERVAL_MS = 200;
/**
 * Grok and Cursor take longer than the HTTP bridges to bind: the ACP child
 * often becomes healthy about a second after the 15s wait gives up, which
 * flashes Connection Failed and then attaches on the next refresh.
 */
export const ACP_LOCAL_SERVER_HEALTH_ATTEMPTS = 120;
export let localServerShutdownRequested = false;
export let localServerShutdownPromise: Promise<void> | null = null;
export function isLocalServerShutdownRequested(): boolean {
  return localServerShutdownRequested;
}
export function requestLocalServerShutdown(): void {
  localServerShutdownRequested = true;
}
export function setLocalServerShutdownRequested(value: boolean): void {
  localServerShutdownRequested = value;
}
export function getLocalServerShutdownPromise(): Promise<void> | null {
  return localServerShutdownPromise;
}
export function setLocalServerShutdownPromise(value: Promise<void> | null): void {
  localServerShutdownPromise = value;
}
export let terminateProcessTreeImpl = terminateProcessTree;
export let spawnLocalServerCommandImpl = spawnCommand;
export function setTerminateProcessTreeImplementation(
  implementation: typeof terminateProcessTree,
): void {
  terminateProcessTreeImpl = implementation;
}
export function setSpawnLocalServerCommandImplementation(
  implementation: typeof spawnCommand,
): void {
  spawnLocalServerCommandImpl = implementation;
}
export const CLAUDE_MODEL_CATALOG_TTL_MS = 5 * 60_000;
export const CLAUDE_MODEL_CATALOG_REQUEST_TIMEOUT_MS = 30_000;
export const CONTAINER_WORKSPACE_SETUP_COMMAND = "if command -v flock >/dev/null 2>&1; then flock /tmp/orkestrator-workspace-setup.lock -c '/usr/local/bin/workspace-setup.sh'; else /usr/local/bin/workspace-setup.sh; fi";
export const CONTAINER_WORKSPACE_PREPARE_COMMAND = "if command -v flock >/dev/null 2>&1; then flock /tmp/orkestrator-workspace-setup.lock -c '/usr/local/bin/workspace-setup.sh --prepare-only'; else /usr/local/bin/workspace-setup.sh --prepare-only; fi";
// The preparation phase is a contract with the script baked into the container
// image (docker/Dockerfile COPYs it to /usr/local/bin), and the image tag is
// unversioned, so an upgraded backend routinely meets an older script. That
// script has no argument handling: it ignores --prepare-only and runs the whole
// setup — including repository-controlled orkestrator-ai.json commands, as root —
// and exits 0, so the commit we would then record is not a pre-setup baseline at
// all. Probe for the capability by *reading* the script before executing it: any
// probe that runs it has already done the damage it was meant to prevent.
export const CONTAINER_WORKSPACE_SETUP_CAPABILITY_MARKER = "ORKESTRATOR_SETUP_CAPABILITIES=prepare-only";
export const CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL = `${String.fromCharCode(0x1e)}ORKESTRATOR_PREPARE_SUPPORTED${String.fromCharCode(0x1f)}`;
export const CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL = `${String.fromCharCode(0x1e)}ORKESTRATOR_PREPARE_OK${String.fromCharCode(0x1f)}`;
export const CONTAINER_INTERACTIVE_SHELL_COMMAND = [
  "source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true",
  "orkestrator_source_runtime_env 2>/dev/null || true",
  "exec zsh -l",
].join("\n");
export const CONTAINER_GITHUB_CREDENTIAL_FILE = "/tmp/orkestrator-ai/github-token";
export const CONTAINER_CLAUDE_CREDENTIAL_FILE = "/home/node/.claude/.credentials.json";
export const CONTAINER_CURSOR_API_KEY_FILE = "/tmp/orkestrator-ai/cursor-api-key";
export const CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE =
  "/tmp/orkestrator-ai/cursor-api-key-fingerprint";
/**
 * Both Cursor credential files live here. Nothing in the image guarantees it
 * exists: `workspace-setup.sh` only creates it past the `--prepare-only` exit
 * and only when it runs as `node`, so every writer has to create it itself.
 */
export const CONTAINER_CURSOR_CREDENTIAL_DIR = path.posix.dirname(
  CONTAINER_CURSOR_API_KEY_FILE,
);
export const HOST_CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV =
  "ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR";
export const AGENT_TEST_CURSOR_CREDENTIAL_STORE_ENV = "AGENT_CLI_CREDENTIAL_STORE";
export const CLAUDE_GITHUB_CREDENTIAL_FILE_ENV = "ORKESTRATOR_GITHUB_CREDENTIAL_FILE";
export const CLAUDE_GITHUB_ENV_FINGERPRINT_FILE =
  "/tmp/orkestrator-ai/claude-github-env-fingerprint";
export const CLAUDE_GITHUB_ENV_FINGERPRINT = createHash("sha256")
  .update("managed-github-query-environment-v1")
  .digest("hex");
export const OPENCODE_GITHUB_ENV_PLUGIN_PATH = "/home/node/.config/opencode/plugins/orkestrator-github-env.js";
export const OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT_FILE =
  "/tmp/orkestrator-ai/opencode-github-env-plugin-fingerprint";

export function buildOpenCodeGitHubEnvironmentPluginSource(
  credentialFile = CONTAINER_GITHUB_CREDENTIAL_FILE,
): string {
  return `import { readFile } from "node:fs/promises";

const credentialFile = ${JSON.stringify(credentialFile)};

export const OrkestratorGitHubEnvironmentPlugin = async () => ({
  "shell.env": async (_input, output) => {
    let token = "";
    try {
      token = (await readFile(credentialFile, "utf8")).trim();
    } catch {
      // Missing or unreadable managed state means no GitHub identity.
    }
    if (token) {
      output.env.GITHUB_TOKEN = token;
      output.env.GH_TOKEN = token;
    }
  },
});
`;
}

export const OPENCODE_GITHUB_ENV_PLUGIN_SOURCE =
  buildOpenCodeGitHubEnvironmentPluginSource();
export const OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT = createHash("sha256")
  .update(OPENCODE_GITHUB_ENV_PLUGIN_SOURCE)
  .digest("hex");

export function withContainerRuntimeCredential(command: string): string {
  return [
    "source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true",
    "orkestrator_source_runtime_env 2>/dev/null || true",
    command,
  ].join("\n");
}
/** Renders a sentinel as a `printf` format string, so the shell cannot drift from it. */
export function shellPrintfSentinel(sentinel: string): string {
  return sentinel.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/g,
    (character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
}
export const CONTAINER_WORKSPACE_PREPARE_SUPPORT_COMMAND = `if grep -qxF '${CONTAINER_WORKSPACE_SETUP_CAPABILITY_MARKER}' /usr/local/bin/workspace-setup.sh 2>/dev/null; then printf '${shellPrintfSentinel(CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL)}'; fi`;
export const SETUP_DONE_OSC_SEQUENCE = "\u001b]9999;setup_done\u0007";
export const SETUP_FAILED_OSC_SEQUENCE = "\u001b]9999;setup_failed\u0007";
export const SETUP_DONE_PRINTF_CMD = "printf '\\033]9999;setup_done\\007'";
export const SETUP_FAILED_PRINTF_CMD = "printf '\\033]9999;setup_failed\\007'";
export const MAX_TERMINAL_OUTPUT_BUFFER_CHARS = 500 * 1024;
/** Keep exited PTY snapshots long enough for a lagging SSE client to recover. */
export const TERMINAL_OUTPUT_RETENTION_MS = 5 * 60_000;
/** Overridable so tests can observe the real expiry path without a five-minute wait. */
export let terminalOutputRetentionMs = TERMINAL_OUTPUT_RETENTION_MS;
export function getTerminalOutputRetentionMs(): number {
  return terminalOutputRetentionMs;
}
export function resetTerminalOutputRetentionMs(): void {
  terminalOutputRetentionMs = TERMINAL_OUTPUT_RETENTION_MS;
}
export function setTerminalOutputRetentionMs(retentionMs: number): void {
  terminalOutputRetentionMs = retentionMs;
}
/** Bound worst-case retained output to 32 × 500 KB. */
export const MAX_RETAINED_TERMINAL_OUTPUT_BUFFERS = 32;
export const TERMINAL_ACTIVITY_SETTLE_MS = 750;
export function buildContainerSafeBase64Reader(
  testMutation?: "append" | "replace",
): string {
  const afterInitialValidationForTest = testMutation === "append"
    ? 'fs.appendFileSync(target, "x");'
    : testMutation === "replace"
      ? 'fs.renameSync(target, target + ".old"); fs.writeFileSync(target, "replacement");'
      : "";
  return `
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.argv[1]);
const target = path.resolve(process.argv[2]);
const limit = Number(process.argv[3]);
function fail(message) {
  const error = new Error(message);
  error.safeMessage = true;
  throw error;
}
function inside(rootPath, targetPath) {
  const child = path.relative(rootPath, targetPath);
  return child === "" || (child !== ".." && !child.startsWith(".." + path.sep) && !path.isAbsolute(child));
}
function main() {
  if (!inside(root, target)) fail("File is outside the container workspace");
  const canonicalRoot = fs.realpathSync(root);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) fail("Symbolic-link attachments are not allowed");
  }
  if (!inside(canonicalRoot, fs.realpathSync(target))) fail("File is outside the container workspace");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const initial = fs.fstatSync(fd);
    const assertStablePath = (opened) => {
      const currentStats = fs.lstatSync(target);
      if (currentStats.isSymbolicLink()) fail("Symbolic-link attachments are not allowed");
      if (!currentStats.isFile() || !opened.isFile() || currentStats.dev !== opened.dev || currentStats.ino !== opened.ino) {
        fail("Attachment is not a stable regular file");
      }
      if (!inside(canonicalRoot, fs.realpathSync(target))) fail("File is outside the container workspace");
    };
    assertStablePath(initial);
    if (initial.size > limit) fail("File exceeds the attachment size limit");
    ${afterInitialValidationForTest}
    const chunks = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, (limit + 1) - total));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > limit) fail("File exceeds the attachment size limit");
    const final = fs.fstatSync(fd);
    assertStablePath(final);
    if (
      final.dev !== initial.dev
      || final.ino !== initial.ino
      || final.size !== initial.size
      || final.size !== total
      || final.mtimeMs !== initial.mtimeMs
      || final.ctimeMs !== initial.ctimeMs
    ) fail("File changed while it was being read; please try again");
    process.stdout.write(Buffer.concat(chunks, total).toString("base64"));
  } finally {
    fs.closeSync(fd);
  }
}
try {
  main();
} catch (error) {
  const message = error && error.safeMessage
    ? error.message
    : "File could not be read safely from the container workspace";
  process.stderr.write(message + "\\n");
  process.exitCode = 1;
}
`.trim();
}
export const CONTAINER_SAFE_BASE64_READER = buildContainerSafeBase64Reader();

export const CONTAINER_UNTRACKED_STATS_SCANNER = String.raw`
const fs = require("node:fs");
const limit = Number(process.argv[1]);
const maxFiles = Number(process.argv[2]);
let scanned = 0;
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  let offset = 0;
  while (offset < input.length) {
    const end = input.indexOf(0, offset);
    if (end === -1) process.exit(2);
    const record = input.subarray(offset, end);
    offset = end + 1;
    if (record.length < 4 || record[0] !== 63 || record[1] !== 63 || record[2] !== 32) continue;
    const filePath = record.subarray(3);
    // Past the cap the path is still reported - the user must be able to see the
    // file - but it is not opened. The host marks the result truncated by
    // comparing the record count against the same cap.
    if (scanned >= maxFiles) {
      process.stdout.write(Buffer.from("0\t"));
      process.stdout.write(filePath);
      process.stdout.write(Buffer.from([0]));
      continue;
    }
    scanned += 1;
    let count = 0;
    let fd;
    try {
      fd = fs.openSync(
        filePath,
        fs.constants.O_RDONLY
          | (fs.constants.O_NOFOLLOW || 0)
          | (fs.constants.O_NONBLOCK || 0),
      );
      const initial = fs.fstatSync(fd);
      if (!initial.isFile() || initial.size === 0 || initial.size > limit) throw new Error("skip");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      let separators = 0;
      let previousWasCarriageReturn = false;
      let lastByte = -1;
      while (true) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > limit) throw new Error("skip");
        for (let index = 0; index < bytesRead; index += 1) {
          const byte = buffer[index];
          if (byte === 0) throw new Error("skip");
          if (byte === 13) {
            separators += 1;
            previousWasCarriageReturn = true;
          } else if (byte === 10) {
            if (!previousWasCarriageReturn) separators += 1;
            previousWasCarriageReturn = false;
          } else {
            previousWasCarriageReturn = false;
          }
          lastByte = byte;
        }
      }
      count = separators + (lastByte !== 13 && lastByte !== 10 ? 1 : 0);
    } catch {
      count = 0;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
    process.stdout.write(Buffer.from(String(count) + "\t"));
    process.stdout.write(filePath);
    process.stdout.write(Buffer.from([0]));
  }
});
`;

export type EnvironmentSetupSession = {
  environmentId: string;
  sessionId: string;
  running: boolean;
  startedAt: string;
  completedAt?: string;
  success?: boolean;
  error?: string;
};

export type EnvironmentSetupStartResult = {
  setupStarted: boolean;
  setupSessionId?: string;
  environment: Environment;
};

export type ClientEnvironmentSetupStartResult = Omit<
  EnvironmentSetupStartResult,
  "environment"
> & {
  environment: ClientEnvironment;
};

export const environmentSetupSessions = new Map<string, EnvironmentSetupSession>();
export const environmentSetupTasks = new Map<string, Promise<Environment>>();
export const environmentSetupStartTasks = new Map<string, Promise<EnvironmentSetupStartResult>>();
export const environmentStartTasks = new Map<string, Promise<EnvironmentSetupStartResult>>();
export const environmentLifecycleOperations = new Map<string, Promise<void>>();
export const environmentBaselineTasks = new Map<string, Promise<Environment>>();
export const WORKSPACE_ARTIFACT_GIT_EXCLUDE_PATTERNS = [".orkestrator", ".claude/settings.local.json"] as const;

/**
 * Shared by every worktree of every repository, so N environments of one project
 * make one fetch rather than N against the same origin.
 */
export const gitFetchScheduler = new GitFetchScheduler({
  run: (args, timeoutMs) => runCommand("git", args, { timeoutMs }),
});

/**
 * How stale a cached file list may be before the Files panel reads for itself.
 *
 * Comfortably under the panel's own refresh cadence, so the common case - the
 * panel and the sidebar looking at the same environment - shares one scan
 * without the panel ever showing something older than it would have fetched.
 */
export const DIFF_CACHE_MAX_AGE_MS = 3_000;

/**
 * Emitting is a property of the running backend, not of any one command, but the
 * context that carries `emit` only arrives with the first invocation. Reading it
 * through a mutable binding is the same trick `main.ts` uses for a gateway that
 * does not exist yet.
 */
export let diffStatsEmit: BackendEmit | undefined;
export let diffStatsSyncGeneration = 0;
export let diffStatsSyncQueue: Promise<void> = Promise.resolve();

export const diffStatsService = new DiffStatsService({
  emit: (event, payload) => diffStatsEmit?.(event, payload),
  scan: async (target) => {
    // Load the scanners only when a scan runs. `commands-files` consumes shared
    // runtime constants from this module, so a static import here creates an
    // initialization cycle before those constants have been assigned.
    const {
      getContainerGitStatusDetailed,
      getLocalGitStatusDetailed,
    } = await import("./commands-files.js");
    const detailed = target.kind === "local"
      ? await getLocalGitStatusDetailed(target.worktreePath!, target.comparisonRef, true)
      : await getContainerGitStatusDetailed(target.containerId!, target.comparisonRef, true);
    return {
      stats: {
        additions: detailed.changes.reduce((sum, change) => sum + change.additions, 0),
        deletions: detailed.changes.reduce((sum, change) => sum + change.deletions, 0),
        filesChanged: detailed.changes.length,
        truncated: detailed.truncated,
      },
      changes: detailed.changes,
    };
  },
  onWarning: (message, error) => {
    console.warn(`[diff-stats] ${message}:`, error instanceof Error ? error.message : error);
  },
});

/**
 * Reconciles which environments are tracked against what storage says exists.
 *
 * Reconciling the whole set rather than patching it means every caller - start,
 * stop, delete, a client connecting - converges on the same answer, and a missed
 * lifecycle event self-corrects on the next call instead of leaving an
 * environment permanently unwatched or a deleted one permanently watched.
 */
export function invalidatePendingDiffStatsSync(): void {
  diffStatsSyncGeneration += 1;
}

export async function syncDiffStatsTracking(context: CommandContext): Promise<void> {
  diffStatsEmit = context.emit;
  const generation = diffStatsSyncGeneration;
  const operation = diffStatsSyncQueue
    .catch(() => undefined)
    .then(async () => {
      const [environments, config] = await Promise.all([
        context.storage.loadEnvironments(),
        context.storage.loadConfig(),
      ]);

      // A stop, delete, shutdown, or newer reconciliation may have happened
      // while storage was loading. Applying this older snapshot would recreate
      // a watcher or poller that the later lifecycle action deliberately
      // removed.
      if (generation !== diffStatsSyncGeneration) return;

      const live = new Set<string>();
      for (const environment of environments) {
        live.add(environment.id);
        const comparisonRef = resolveComparisonRef(
          environment.createdFromCommit,
          config.repositories?.[environment.projectId],
        );
        const target = environment.environmentType === "local"
          ? (environment.worktreePath
            ? { environmentId: environment.id, kind: "local" as const, worktreePath: environment.worktreePath, comparisonRef }
            : undefined)
          : (environment.status === "running" && environment.containerId
            ? { environmentId: environment.id, kind: "container" as const, containerId: environment.containerId, comparisonRef }
            : undefined);

        // Readable now: scan it. Not readable but still an environment: hold the
        // last counts and stop scanning, rather than discarding a reading that
        // described work which is still on disk.
        if (target) diffStatsService.track(target);
        else diffStatsService.pause(environment.id);
      }

      for (const environmentId of diffStatsService.trackedIds()) {
        if (!live.has(environmentId)) diffStatsService.untrack(environmentId);
      }
    });
  diffStatsSyncQueue = operation;
  await operation;
}

/** Releases every diff watcher and timer; called on backend shutdown. */
export function shutdownDiffStatsTracking(): void {
  invalidatePendingDiffStatsSync();
  diffStatsService.shutdown();
}

/**
 * PR monitoring composition root. Same shape as the diff-stats block above: the
 * service is module-level state, `emit` and `storage` arrive with the first
 * command context, and tracking is reconciled against storage rather than
 * patched so every lifecycle path converges on the same monitored set.
 */
