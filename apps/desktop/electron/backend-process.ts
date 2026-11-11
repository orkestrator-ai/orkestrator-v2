import type { BackendHello } from "@orkestrator/protocol/backend-profile";
import { checkBackendRoute } from "./backend-hello.js";
import { fromCodedWire } from "@orkestrator/protocol/contract/errors";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { DESKTOP_SUPERVISED_ENV } from "@orkestrator/protocol/node/application-logging";
import { forEachBoundedLine } from "@orkestrator/protocol/node/bounded-line-splitter";
import { isLogPolicyChangedRecord } from "@orkestrator/protocol/node/log-policy";
import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";
import {
  isHostMaintenanceSnapshot,
  type HostMaintenanceSnapshot,
  type HostUpdaterReport,
} from "@orkestrator/protocol/host-maintenance";
import {
  GATEWAY_EVENT_CURSOR_PARAM,
  GATEWAY_STREAM_CONNECT_TIMEOUT_MS,
  GATEWAY_RELAYED_EVENTS_PARAM,
  GATEWAY_STREAM_SILENCE_LIMIT_MS,
  GatewayEventStreamState,
  type GatewayRelayedEventsMode,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  TERMINAL_EVENT_STREAM_CONNECTED_EVENT,
  readSseStream,
} from "@orkestrator/protocol/gateway-event-stream";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";
import {
  RelayedEventStream,
  type RelayedEventConnection,
  type RelayedEventConnectionHandlers,
} from "@orkestrator/protocol/relayed-event-stream";
import { TERMINAL_HTTP_INPUT_SEND_TIMEOUT_MS } from "@orkestrator/protocol/terminal-input-batcher";
import { TerminalInputSequencer } from "@orkestrator/protocol/terminal-input-sequencer";
import {
  createLogger,
  emitLogRecord,
  formatLogError,
  parseLogRecordLine,
  writeProcessOutputLine,
} from "@orkestrator/protocol/logger";

const clientLog = createLogger("backend.client");
const desktopLog = createLogger("desktop");

/**
 * Relays one line of the backend's stdio into this process's log. A logger entry
 * crosses as a JSON record carrying its own level and is re-emitted at that
 * level. Anything else (a vendor's own printing, a crash dump) is captured as
 * it always was: stdout as LOG, stderr as ERROR.
 */
export function relayBackendLine(
  stream: "stdout" | "stderr",
  line: string,
  onLogPolicyChanged: BackendLogPolicyListener | undefined,
): void {
  const record = parseLogRecordLine(line);
  if (!record) {
    writeProcessOutputLine(stream, `[Backend] ${line}`);
    return;
  }
  // Only a hint to re-read `config.json`, because any output can imitate a
  // record: an imitation costs one read and cannot change what the file says.
  if (onLogPolicyChanged && isLogPolicyChangedRecord(record)) {
    onLogPolicyChanged(() => emitLogRecord(record));
    return;
  }
  emitLogRecord(record);
}

/**
 * The backend's logging settings changed. Applies them, and calls `audit` to write
 * the backend's audit line at the point where it reaches the log either way.
 */
export type BackendLogPolicyListener = (audit?: () => void) => void;

/** The readiness line, or null for any other stdout line. */
function parseReadyMessage(line: string): ReadyMessage | null {
  if (!line.startsWith("{")) return null;
  try {
    const message = JSON.parse(line) as Partial<ReadyMessage> | null;
    return message?.type === "orkestrator-backend-ready" &&
      typeof message.url === "string" &&
      typeof message.authFile === "string" &&
      typeof message.bindAddress === "string" &&
      typeof message.port === "number"
      ? (message as ReadyMessage)
      : null;
  } catch {
    return null;
  }
}

export const HOSTED_WEB_CLIENT_ORIGINS = [
  "https://orkestrator.dev",
  "https://www.orkestrator.dev",
] as const;

export type GatewayStartInfo = {
  bindAddress: string;
  port: number;
  url: string;
  authFile: string;
  browserUrl?: string;
  browserError?: string;
};

const AGENT_TEST_SAFE_ENV_NAMES = new Set([
  "BUN_INSTALL",
  "CI",
  "COLORTERM",
  // Cursor's producer trim threshold (`bridges/cursor-bridge/src/config.ts`).
  // Local bridges inherit the backend's environment, so this lets an isolated
  // profile reach the bound in a short qualification run. A size, never a
  // credential.
  "CURSOR_BRIDGE_MAX_TRANSCRIPT_BYTES",
  // Where the Docker daemon is, not who may talk to it. Stripping these sends
  // every `docker` call to the built-in default context, which is wrong for
  // Colima, Rancher Desktop, rootless Podman, a remote daemon, and Docker
  // Desktop without the default-socket shim.
  "DOCKER_CERT_PATH",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "FORCE_COLOR",
  "LANG",
  "LOGNAME",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "NODE_PATH",
  "NO_COLOR",
  "ORKESTRATOR_AGENT_INTERACTION_MONITOR_KILL_SWITCH",
  "ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY",
  // A loopback origin for Claude and Codex plan-usage reads (to-do 7542 (retired)), so a
  // two-backend spec can script fixture accounts' usage. The backend honours it
  // only in an isolated agent-test profile, for a loopback origin
  // (`agentTestUsageOrigin`). An address, never a credential.
  "ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN",
  // A loopback Anthropic origin every Claude bridge of the isolated backend
  // is pointed at (to-do 7542 (retired)), under the same gate (`agentTestAnthropicOrigin`).
  "ORKESTRATOR_AGENT_TEST_ANTHROPIC_ORIGIN",
  "ORKESTRATOR_CONTROL_MCP_PORT",
  "ORKESTRATOR_GATEWAY_DISABLED",
  // `off` skips the startup container-to-host probe, as other disposable test
  // backends do: each spec run is a new data directory, so its probe network
  // would belong to an owner no reaper revisits, and its result dialog takes
  // keyboard focus mid-test. A switch, never a credential.
  "ORKESTRATOR_HOST_REACHABILITY_CHECK",
  // Recurring-work policy switches (rollback and metrics), so an isolated
  // profile can qualify the previous drivers. Policy only, never credentials.
  "ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK",
  "ORKESTRATOR_NATIVE_OBSERVATION_SHARING",
  "ORKESTRATOR_RECURRING_METRICS",
  // Service-preview transport overrides (`PreviewRuntime.effectiveSettings`),
  // so an isolated profile can qualify the tunnel and relay. Policy only.
  "ORKESTRATOR_PREVIEW_RELAY",
  "ORKESTRATOR_PREVIEW_TRANSPORT",
  // Browser queueing fixtures use a private scheduler within the outer review
  // reservation. These carry capacity/path settings, never credentials.
  "ORKESTRATOR_TEST_SCHEDULER_DIR",
  "ORKESTRATOR_TEST_HOST_WORKERS",
  "ORKESTRATOR_TEST_HOST_MEMORY_MIB",
  "ORKESTRATOR_VERSION",
  "PATH",
  "PWD",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
]);

function retainSafeAgentTestEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (!AGENT_TEST_SAFE_ENV_NAMES.has(name) && !name.startsWith("LC_")) delete env[name];
  }
}

/** Isolated replacement for `~/.docker`, pointed at by `DOCKER_CONFIG`. */
export function agentTestDockerConfigDir(isolatedCredentialRoot: string): string {
  return path.join(isolatedCredentialRoot, "docker-disabled");
}

export function agentTestKeychainDir(isolatedCredentialRoot: string): string {
  return path.join(isolatedCredentialRoot, "home", "Library", "Keychains");
}

/**
 * Remove the legacy host-Keychain link created by older agent-test profiles.
 *
 * Linking the complete writable login Keychain into a HOME used by terminals and
 * repository-controlled subprocesses exposed unrelated services and survived a
 * later credential opt-out. Current profiles broker provider-specific secrets at
 * bridge startup instead, so every launch reconciles this managed target even
 * when no Keychain-backed provider is authorized.
 *
 * A real directory is profile-owned state and must never be removed here.
 */
export async function removeAgentTestHostKeychainLink(
  isolatedCredentialRoot: string,
): Promise<boolean> {
  const target = agentTestKeychainDir(isolatedCredentialRoot);
  const existing = await lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;
  await rm(target, { force: true });
  return true;
}

export function hostDockerConfigDir(
  parentEnv: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  return parentEnv.DOCKER_CONFIG?.trim() || path.join(homeDir, ".docker");
}

/**
 * Give the isolated `DOCKER_CONFIG` enough of the host's configuration to reach
 * the same daemon, and nothing more.
 *
 * `contexts/` and `currentContext` are topology: without them the CLI silently
 * falls back to the built-in `unix:///var/run/docker.sock`, which is not where
 * Colima, Rancher Desktop, or Docker Desktop without the default-socket shim
 * listen. `auths`, `credsStore`, and every other key are credentials and stay
 * behind — that is the point of the isolated directory.
 *
 * Best-effort: a profile whose Docker configuration cannot be read still starts,
 * it just falls back to the default context the way it did before.
 */
export async function seedAgentTestDockerConfig(options: {
  isolatedCredentialRoot: string;
  sourceDir: string;
}): Promise<void> {
  const target = agentTestDockerConfigDir(options.isolatedCredentialRoot);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(path.join(options.sourceDir, "contexts"), path.join(target, "contexts"), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
  const parsed = await readFile(path.join(options.sourceDir, "config.json"), "utf8")
    .then((contents) => JSON.parse(contents) as unknown)
    .catch(() => null);
  const currentContext =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { currentContext?: unknown }).currentContext
      : undefined;
  await writeFile(
    path.join(target, "config.json"),
    `${JSON.stringify(typeof currentContext === "string" && currentContext ? { currentContext } : {}, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function getBrowserGatewayStatus(info: GatewayStartInfo | null) {
  return {
    enabled: true,
    running: Boolean(info?.browserUrl),
    url: info?.browserUrl ?? null,
    error: info?.browserError ?? null,
  };
}

/**
 * The gateway port the desktop asks its backend for. The installed app owns the
 * fixed port; `mise run dev` has its own data directory and takes a free one, so
 * it cannot move the installed app's address by starting first.
 */
export function desktopGatewayPort(isDev: boolean, profilePort?: number): number {
  return profilePort ?? (isDev ? 0 : 34121);
}

export function createBackendProcessEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  appVersion?: string,
  runtime?: {
    flavor: "production" | "development" | "agent-test";
    credentialSources?: readonly string[];
    isolatedCredentialRoot?: string;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    ORKESTRATOR_GATEWAY_DISABLED: "0",
    // Electron re-logs this child's output into its own log file, so the
    // backend must not also write one of its own.
    [DESKTOP_SUPERVISED_ENV]: "1",
  };
  const version = appVersion?.trim();
  if (version) {
    // Always prefer Electron's authoritative application version over a value
    // inherited from the shell that launched the desktop app.
    env.ORKESTRATOR_VERSION = version;
  } else {
    // An empty or blank version is absent, not a version. Exporting `""` would
    // leave the backend and both bridges reading a defined-but-useless value
    // instead of falling back to their own default, and it would still shadow
    // whatever the shell had set.
    delete env.ORKESTRATOR_VERSION;
  }
  // The desktop supplies an approved dev URL explicitly on the command line.
  // Never let the backend fallback select a renderer from the launching shell.
  delete env.ORKESTRATOR_RENDERER_DEV_SERVER_URL;
  delete env.ORKESTRATOR_GATEWAY_HOST;
  delete env.ORKESTRATOR_GATEWAY_PORT;
  delete env.ORKESTRATOR_GATEWAY_TOKEN;
  delete env.ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS;
  delete env.ORKESTRATOR_TAILSCALE_SERVE;
  delete env.ORKESTRATOR_TAILSCALE_SERVE_PORT;
  delete env.ORKESTRATOR_TAILSCALE_BIN;
  delete env.ORKESTRATOR_TOOLCHAIN_BIN;
  delete env.ORKESTRATOR_RUNTIME_FLAVOR;
  delete env.ORKESTRATOR_WORKTREE_DIR;
  delete env.ORKESTRATOR_DOCKER_IMAGE;
  delete env.ORKESTRATOR_CREDENTIAL_SOURCE;
  delete env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
  delete env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;
  delete env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT;
  delete env.ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR;
  // A development or agent-test profile runs from a source checkout, but its
  // launcher's shell may descend from a production backend (the CLI shim sets
  // NODE_ENV=production for `orkestrator serve`). Inherited, that value makes
  // the backend look for packaged bridges under the resource root instead of
  // `bridges/<name>`, and every local agent tab fails to connect.
  if (
    (runtime?.flavor === "development" || runtime?.flavor === "agent-test") &&
    env.NODE_ENV === "production"
  ) {
    delete env.NODE_ENV;
  }
  if (runtime?.flavor === "agent-test") {
    const allowed = new Set(runtime.credentialSources ?? []);
    const inherited = { ...parentEnv };
    const inheritedHome = inherited.HOME?.trim();
    retainSafeAgentTestEnvironment(env);
    // Not a secret, and what makes this backend relay records as it does in
    // production. Without it a profile's backend logs text the desktop cannot
    // re-emit, so the essential log would never see its entries.
    env[DESKTOP_SUPERVISED_ENV] = "1";
    env.ORKESTRATOR_AGENT_TEST_ISOLATED = "1";
    if (runtime.isolatedCredentialRoot) {
      const isolatedHome = path.join(runtime.isolatedCredentialRoot, "home");
      env.HOME = isolatedHome;
      if (inheritedHome) env.ORKESTRATOR_AGENT_TEST_HOST_HOME = inheritedHome;
      env.GH_CONFIG_DIR = path.join(runtime.isolatedCredentialRoot, "github-disabled");
      env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
      env.NPM_CONFIG_USERCONFIG = path.join(runtime.isolatedCredentialRoot, "npmrc-disabled");
      env.DOCKER_CONFIG = agentTestDockerConfigDir(runtime.isolatedCredentialRoot);
      env.AWS_CONFIG_FILE = path.join(runtime.isolatedCredentialRoot, "aws", "config");
      env.AWS_SHARED_CREDENTIALS_FILE = path.join(
        runtime.isolatedCredentialRoot,
        "aws",
        "credentials",
      );
      env.AWS_EC2_METADATA_DISABLED = "true";
      env.KUBECONFIG = path.join(runtime.isolatedCredentialRoot, "kube", "config");
      env.AZURE_CONFIG_DIR = path.join(runtime.isolatedCredentialRoot, "azure");
      env.CLOUDSDK_CONFIG = path.join(runtime.isolatedCredentialRoot, "google");
    }
    if (allowed.has("claude")) {
      if (inherited.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = inherited.ANTHROPIC_API_KEY;
      // A shell that set CLAUDE_CONFIG_DIR (an Orkestrator agent tab on an
      // added account, say) uses that directory's own Keychain entry, even
      // when it spells ~/.claude. The backend reads the same login.
      const explicitClaudeConfigDir = inherited.CLAUDE_CONFIG_DIR?.trim();
      const claudeConfigDir =
        explicitClaudeConfigDir ||
        (inheritedHome ? path.join(inheritedHome, ".claude") : undefined);
      if (claudeConfigDir) {
        env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = claudeConfigDir;
        if (explicitClaudeConfigDir)
          env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT = "1";
      }
    }
    if (runtime.isolatedCredentialRoot) {
      env.CLAUDE_CONFIG_DIR = path.join(runtime.isolatedCredentialRoot, "claude");
    }
    // Codex and OpenCode always get the profile's own homes. An authorized
    // source adds the host's login as a restricted snapshot in them
    // (`seedAgentTestProviderCredentials` in `scripts/dev/profile-io.ts`), so
    // a trust grant, an MCP editor save or a session never reaches the host's
    // `~/.codex` or OpenCode directories, and a refresh cannot rotate its login.
    if (allowed.has("codex") && inherited.OPENAI_API_KEY) {
      env.OPENAI_API_KEY = inherited.OPENAI_API_KEY;
    }
    if (allowed.has("opencode") && inherited.OPENCODE_API_KEY) {
      env.OPENCODE_API_KEY = inherited.OPENCODE_API_KEY;
    }
    if (runtime.isolatedCredentialRoot) {
      env.CODEX_HOME = path.join(runtime.isolatedCredentialRoot, "codex");
      env.XDG_CONFIG_HOME = path.join(runtime.isolatedCredentialRoot, "xdg-config");
      env.XDG_DATA_HOME = path.join(runtime.isolatedCredentialRoot, "xdg-data");
      env.XDG_STATE_HOME = path.join(runtime.isolatedCredentialRoot, "xdg-state");
    }
    if (allowed.has("pi")) {
      // Only the path: the backend hands the Pi bridge this directory's
      // `auth.json` and nothing else from it.
      const piAgentDir =
        inherited.PI_CODING_AGENT_DIR?.trim() ||
        (inheritedHome ? path.join(inheritedHome, ".pi", "agent") : undefined);
      if (piAgentDir) {
        const expanded =
          inheritedHome && (piAgentDir === "~" || piAgentDir.startsWith("~/"))
            ? path.join(inheritedHome, piAgentDir.slice(2))
            : piAgentDir;
        env.ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR = path.resolve(expanded);
      }
    }
    if (allowed.has("cursor") && inherited.CURSOR_API_KEY) {
      env.CURSOR_API_KEY = inherited.CURSOR_API_KEY;
    }
  }
  return env;
}

type ReadyMessage = GatewayStartInfo & { type: "orkestrator-backend-ready" };
/** Desktop reconnects are local or to one remote; retry fast, then back off. */
const EVENT_RECONNECT_DELAY_MS = 500;
const EVENT_RECONNECT_MAX_DELAY_MS = 8_000;
const EVENT_STREAM_HEALTHY_AFTER_MS = 30_000;
const TERMINAL_OUTPUT_EVENT_PREFIX = "terminal-output-";
/** The only routes a local window's direct transport uses. */
const DIRECT_TRANSPORT_PATHS: ReadonlySet<string> = new Set([
  "/__orkestrator/invoke",
  "/__orkestrator/events",
]);

export type BackendStreamState = "open" | "closed" | "unauthorized";

export type BackendListenOptions = {
  /** Called when the authoritative stream opens or drops (it reconnects by itself). */
  onStreamState?: (state: BackendStreamState) => void;
  /** Test overrides for how long a silent stream or attempt is given. */
  streamSilenceLimitMs?: number;
  streamConnectTimeoutMs?: number;
  /** Test override for the clock those limits and reconnect health are measured on. */
  streamNow?: () => number;
};

/**
 * Gives up on an attempt nothing answers, and on a stream the gateway has stopped
 * talking on: a link that drops with no answer never errors the stream by itself.
 */
function watchStreamAttempt(signal: AbortSignal, options: BackendListenOptions) {
  const now = options.streamNow ?? Date.now;
  const silenceLimitMs = options.streamSilenceLimitMs ?? GATEWAY_STREAM_SILENCE_LIMIT_MS;
  const connectTimeoutMs = options.streamConnectTimeoutMs ?? GATEWAY_STREAM_CONNECT_TIMEOUT_MS;
  const attempt = new AbortController();
  const abortAttempt = () => attempt.abort();
  signal.addEventListener("abort", abortAttempt, { once: true });
  let deadline = now() + connectTimeoutMs;
  const watchdog = setInterval(
    () => {
      if (now() >= deadline) attempt.abort();
    },
    Math.min(silenceLimitMs, connectTimeoutMs) / 4,
  );
  watchdog.unref?.();
  return {
    signal: attempt.signal,
    /** The gateway said something, or answered the attempt. */
    heard() {
      deadline = now() + silenceLimitMs;
    },
    stop() {
      clearInterval(watchdog);
      signal.removeEventListener("abort", abortAttempt);
    },
  };
}

/** The contract fields of an invoke envelope, as they go next to `command` and `args`. */
export type InvokeEnvelopeFields = {
  domain?: unknown;
  version?: unknown;
  critical?: unknown;
};

/**
 * The `domain`, `version` and `critical` of a renderer's envelope, or `null`
 * when it carries none. Opaque here: the backend's gateway decodes them with
 * the protocol's bounded guard and refuses a malformed one. `command` and
 * `args` always come from the call itself, never from the envelope.
 */
export function invokeEnvelopeFields(
  envelope: Record<string, unknown> | undefined,
): InvokeEnvelopeFields | null {
  if (!envelope) return null;
  const fields: InvokeEnvelopeFields = {};
  for (const key of ["domain", "version", "critical"] as const) {
    if (Object.hasOwn(envelope, key) && envelope[key] !== undefined) fields[key] = envelope[key];
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * A request the backend never ran: this client held it back while its route
 * awaited verification, or the gateway refused the credential (HTTP 401)
 * before dispatching it. Nothing of it reached a shell, so terminal input
 * that failed this way may be sent again on the next credential.
 */
export class RequestNotSentError extends Error {
  constructor(
    message: string,
    readonly reason: "route-suspended" | "credential-refused",
  ) {
    super(message);
    this.name = "RequestNotSentError";
  }
}

/**
 * How many new credentials one terminal send waits for after a refusal
 * before it fails (and fences the terminal) as before. Each wait is bounded
 * by the sequencer's send deadline too.
 */
const TERMINAL_SEND_CREDENTIAL_RETRIES = 3;

export class BackendHttpClient {
  private abortEvents: AbortController | null = null;
  private listener: {
    onEvent: (event: string, payload: unknown) => void;
    options: BackendListenOptions;
  } | null = null;
  /** Kept across a route retarget to the same backend generation so replay resumes. */
  private eventStream = new GatewayEventStreamState();
  /**
   * The per-node relayed events a window on this client listens to, on one
   * stream with its own cursor. Empty, it holds no connection.
   */
  private relayedEvents: RelayedEventStream;
  private readonly relayedEventNames = new Set<string>();
  private readonly eventReconnectDelayMs: number;
  /**
   * Shared ordering contract for terminal input. After an ambiguous loss only
   * a successful start or an explicit resume re-arms; the sequencer answers
   * resume itself, so it never becomes an HTTP request. There is no batching delay, because a loopback backend answers faster than
   * a typing timer would; input typed during a round trip still coalesces.
   */
  private readonly terminalInput: TerminalInputSequencer;
  private suspended = false;
  /** Whether the event stream asks for terminal output; see `setTerminalOutputRelay`. */
  private relayTerminalOutput: boolean;
  /**
   * Set for a client whose credential is renewed for it (a workspace grant):
   * told when the gateway refuses the current credential, so a new one is
   * fetched. Terminal input refused this way waits for that credential.
   */
  private readonly onCredentialRefused: (() => void) | null;
  /** Bumped by every `retarget`: a new route or credential. */
  private credentialGeneration = 0;
  /** The generation whose refusal was last reported, so one refusal opens one reopen. */
  private reportedRefusal = -1;
  private readonly credentialWaiters = new Set<() => void>();

  get isSuspended(): boolean {
    return this.suspended;
  }

  suspend(): void {
    this.suspended = true;
    this.abortEvents?.abort();
    this.relayedEvents.dropConnection();
  }

  private endpoint(endpoint: string): URL {
    if (this.suspended)
      throw new RequestNotSentError(
        "The connection is awaiting a verified route.",
        "route-suspended",
      );
    return new URL(`${this.baseUrl.replace(/\/$/, "")}${endpoint}`);
  }

  constructor(
    private baseUrl: string,
    private token: string,
    options: {
      terminalSendTimeoutMs?: number;
      eventReconnectDelayMs?: number;
      relayTerminalOutput?: boolean;
      /** See the field: a workspace connection reopens its grant on a refusal. */
      onCredentialRefused?: () => void;
    } = {},
  ) {
    const terminalSendTimeoutMs =
      options.terminalSendTimeoutMs ?? TERMINAL_HTTP_INPUT_SEND_TIMEOUT_MS;
    if (!Number.isFinite(terminalSendTimeoutMs) || terminalSendTimeoutMs <= 0) {
      throw new RangeError("Terminal send timeout must be positive");
    }
    this.eventReconnectDelayMs = options.eventReconnectDelayMs ?? EVENT_RECONNECT_DELAY_MS;
    this.relayTerminalOutput = options.relayTerminalOutput ?? true;
    this.onCredentialRefused = options.onCredentialRefused ?? null;
    this.relayedEvents = this.createRelayedEventStream();
    this.terminalInput = new TerminalInputSequencer({
      batchDelayMs: 0,
      sendTimeoutMs: terminalSendTimeoutMs,
      sendInput: (request, signal) =>
        this.sendTerminal(
          request.command,
          { sessionId: request.sessionId, data: request.data },
          signal,
        ),
      runLifecycle: (operation, signal) =>
        this.sendTerminal(operation.command, operation.args, signal),
    });
  }

  /**
   * One terminal input or lifecycle request. On a client whose credential is
   * renewed for it, a request the backend never ran (`RequestNotSentError`)
   * waits for the next credential and is sent again, so a lapsed grant that
   * main reopens does not fence the terminal: no part of it reached the
   * shell, and the sequencer holds every later input behind it, so order is
   * kept. Anything else (a lost response, a timeout) fails as before.
   */
  private async sendTerminal(
    command: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    for (let retries = 0; ; retries++) {
      const generation = this.credentialGeneration;
      try {
        return await this.request(command, args, signal);
      } catch (error) {
        if (
          !(error instanceof RequestNotSentError) ||
          !this.onCredentialRefused ||
          retries >= TERMINAL_SEND_CREDENTIAL_RETRIES ||
          signal.aborted
        )
          throw error;
        await this.nextCredential(generation, signal);
      }
    }
  }

  /** Settles once `retarget` ran after `generation`, or rejects when `signal` aborts. */
  private nextCredential(generation: number, signal: AbortSignal): Promise<void> {
    if (this.credentialGeneration !== generation) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        this.credentialWaiters.delete(wake);
        signal.removeEventListener("abort", abort);
      };
      const wake = () => {
        if (this.credentialGeneration === generation) return;
        done();
        resolve();
      };
      const abort = () => {
        done();
        reject(signal.reason);
      };
      this.credentialWaiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /** Report a refusal of the current credential once; a renewed one may be refused again. */
  private noteCredentialRefused(generation: number): void {
    if (!this.onCredentialRefused || generation !== this.credentialGeneration) return;
    if (this.reportedRefusal === generation) return;
    this.reportedRefusal = generation;
    this.onCredentialRefused();
  }

  /** Origin this client currently reaches. Ephemeral for a tunnelled route. */
  get origin(): string {
    return new URL(this.baseUrl).origin;
  }

  /**
   * Bearer for a local window's direct transport: this exact origin and only
   * its command and event routes. The credential stays in main; the window
   * never reads it, and gets no other route through it.
   */
  directTransportAuthorization(urlValue: string): string | null {
    try {
      const url = new URL(urlValue);
      if (url.origin !== this.origin || !DIRECT_TRANSPORT_PATHS.has(url.pathname)) return null;
      return `Bearer ${this.token}`;
    } catch {
      return null;
    }
  }

  /**
   * Whether this client's stream carries terminal output, which only a window
   * on the relay consumes. A change restarts the stream from its cursor. The
   * reopened stream announces itself, so a relay window gaining the output
   * reads its exact terminal snapshot first.
   */
  setTerminalOutputRelay(relay: boolean): void {
    if (this.relayTerminalOutput === relay) return;
    this.relayTerminalOutput = relay;
    if (this.listener) this.listen(this.listener.onEvent, this.listener.options);
  }

  /**
   * Point this client at another route to the same backend without
   * replacing it, so the terminal input sequencer and its ambiguous-send
   * fence survive the route change. The event stream restarts; its replay
   * cursor is kept only when the caller proved the backend generation did
   * not change (a cursor from another process lifetime is meaningless).
   */
  retarget(baseUrl: string, token: string, options: { preserveCursor: boolean }): void {
    this.suspended = false;
    this.baseUrl = baseUrl;
    this.token = token;
    this.credentialGeneration++;
    if (!options.preserveCursor) {
      this.eventStream = new GatewayEventStreamState();
      this.relayedEvents.forgetCursor();
    }
    if (this.listener) this.listen(this.listener.onEvent, this.listener.options);
    this.relayedEvents.dropConnection();
    this.relayedEvents.retryWaiting();
    for (const wake of Array.from(this.credentialWaiters)) wake();
  }

  /**
   * Which per-node relayed events this client's filtered stream carries: the ones
   * a window on it listens to. A change reopens that stream from its cursor; the
   * main stream is left alone.
   */
  setRelayedEvents(events: readonly string[]): void {
    // A late window update must not restart streams after backend exit or shutdown.
    if (!this.listener) return;
    const wanted = new Set(events);
    for (const event of Array.from(this.relayedEventNames)) {
      if (wanted.has(event)) continue;
      this.relayedEventNames.delete(event);
      this.relayedEvents.remove(event);
    }
    for (const event of wanted) {
      this.relayedEventNames.add(event);
      this.relayedEvents.add(event);
    }
  }

  /** Settles once the stream carrying this per-node relayed event is open. */
  relayedEventReady(event: string): Promise<void> {
    return this.relayedEvents.ready(event);
  }

  /**
   * Runs a command on this backend. `options.envelope` is the renderer's invoke
   * envelope (plan item 1003): its `domain`, `version` and `critical` travel
   * next to `command` and `args`, and the backend checks them. Without one the
   * body is `{ command, args }`, as an older backend expects. Terminal input
   * and lifecycle commands keep their sequencer, which sends the plain body
   * (no terminal command has a definition yet; plan item 7002 carries it).
   */
  invoke<T>(
    command: string,
    args: Record<string, unknown> = {},
    options?: { envelope?: Record<string, unknown> },
  ): Promise<T> {
    const sequenced = this.terminalInput.invoke(command, args);
    if (sequenced) return sequenced as Promise<T>;
    const contract = invokeEnvelopeFields(options?.envelope);
    return contract
      ? this.request<T>(command, args, undefined, contract)
      : this.request<T>(command, args);
  }

  private async request<T>(
    command: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    contract?: InvokeEnvelopeFields,
  ): Promise<T> {
    const generation = this.credentialGeneration;
    const response = await fetch(this.endpoint("/__orkestrator/invoke"), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(contract ? { command, args, ...contract } : { command, args }),
      signal,
    });
    const payload = (await response.json().catch((error) => {
      if (!response.ok) return {};
      throw new Error("Backend command returned malformed JSON", { cause: error });
    })) as {
      result?: T;
      error?: string;
    };
    if (!response.ok) {
      // A registered code keeps its class, code and bounded details (a typed
      // incompatibility's 1005 class, or `CodedError`), so main's
      // `orkestrator:invoke` can send it on in the IPC message form.
      const coded = fromCodedWire(payload);
      if (coded) throw coded;
      const message = payload.error ?? `Backend request failed with HTTP ${response.status}`;
      if (response.status === 401) {
        // Refused before dispatch: the command did not run.
        this.noteCredentialRefused(generation);
        throw new RequestNotSentError(message, "credential-refused");
      }
      throw new Error(message);
    }
    return payload.result as T;
  }

  /** WebSocket URL of this backend's desktop preview tunnel. Carries no credential. */
  previewTunnelUrl(): string {
    const url = this.endpoint("/__orkestrator/preview/tunnel");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  async probe(timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.endpoint("/__orkestrator/status"), {
        headers: { authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean };
      return response.ok && payload.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Authenticated hello; `null` for an older backend without one. */
  async hello(timeoutMs: number): Promise<BackendHello | null> {
    const outcome = await checkBackendRoute(this.baseUrl, this.token, { timeoutMs });
    return outcome.kind === "hello" ? outcome.hello : null;
  }

  async getTokenSettings(): Promise<GatewayTokenSettings> {
    return this.gatewaySettings("GET");
  }

  async setToken(token: string): Promise<GatewayTokenSettings> {
    const settings = await this.gatewaySettings("PUT", { token });
    this.token = settings.token;
    return settings;
  }

  async getWebClientStatus(): Promise<WebClientStatus> {
    return this.webClientAccess("GET");
  }

  async setWebClientEnabled(enabled: boolean): Promise<WebClientStatus> {
    return this.webClientAccess("PUT", { enabled });
  }

  async resetWebClientServe(): Promise<WebClientStatus> {
    return this.webClientAccess("DELETE");
  }

  /** Update jobs for this computer; served only on the loopback control listener. */
  async hostUpdaterSnapshot(): Promise<HostMaintenanceSnapshot> {
    return this.hostUpdater("GET");
  }

  async reportHostUpdater(report: HostUpdaterReport): Promise<HostMaintenanceSnapshot> {
    return this.hostUpdater("POST", report);
  }

  private async hostUpdater(
    method: "GET" | "POST",
    body?: HostUpdaterReport,
  ): Promise<HostMaintenanceSnapshot> {
    const response = await fetch(this.endpoint("/__orkestrator/host-updater"), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      const error = (payload as { error?: unknown }).error;
      throw new Error(
        typeof error === "string"
          ? error
          : `Host updater request failed with HTTP ${response.status}`,
      );
    }
    if (!isHostMaintenanceSnapshot(payload)) {
      throw new Error("Host updater response was malformed");
    }
    return payload;
  }

  listen(
    onEvent: (event: string, payload: unknown) => void,
    options: BackendListenOptions = {},
  ): void {
    this.abortEvents?.abort();
    const controller = new AbortController();
    this.abortEvents = controller;
    this.listener = { onEvent, options };
    void this.consumeEvents(controller.signal, onEvent, options);
  }

  stopListening(): void {
    this.abortEvents?.abort();
    this.abortEvents = null;
    this.listener = null;
    this.relayedEvents.dispose();
    this.relayedEvents = this.createRelayedEventStream();
    this.relayedEventNames.clear();
  }

  private createRelayedEventStream(): RelayedEventStream {
    return new RelayedEventStream({
      open: (events, since, handlers) => this.openRelayedConnection(events, since, handlers),
      deliver: (event, payload) => this.listener?.onEvent(event, payload),
      backoff: new ReconnectBackoff({
        initialDelayMs: this.eventReconnectDelayMs,
        maxDelayMs: Math.max(this.eventReconnectDelayMs, EVENT_RECONNECT_MAX_DELAY_MS),
        healthyAfterMs: EVENT_STREAM_HEALTHY_AFTER_MS,
      }),
    });
  }

  private openRelayedConnection(
    events: readonly string[],
    since: string | null,
    handlers: RelayedEventConnectionHandlers,
  ): RelayedEventConnection {
    // Parked until `retarget` reopens it: nothing may reach an unverified route.
    if (this.suspended) return { close: () => undefined };
    const controller = new AbortController();
    const watch = watchStreamAttempt(controller.signal, this.listener?.options ?? {});
    void (async () => {
      try {
        const url = this.endpoint("/__orkestrator/events");
        url.searchParams.set("includeEvents", events.join(","));
        if (since) url.searchParams.set(GATEWAY_EVENT_CURSOR_PARAM, since);
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: watch.signal,
        });
        if (!response.ok || !response.body)
          throw new Error(`Backend event stream returned HTTP ${response.status}`);
        watch.heard();
        handlers.onOpen();
        await readSseStream(
          response.body,
          watch.signal,
          (frame) => {
            if (frame.data) handlers.onMessage(frame.data, frame.id);
          },
          undefined,
          watch.heard,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        clientLog.warn("event-stream.disconnected", { error: formatLogError(error) });
      } finally {
        watch.stop();
      }
      if (!controller.signal.aborted) handlers.onError();
    })();
    return { close: () => controller.abort() };
  }

  /**
   * Consumes the gateway's authoritative stream with the same recovery
   * contract as the browser: each reconnect resumes from the last cursor, so
   * the gateway replays what was missed, and consumers are told to refetch only
   * for the first fresh connection or an explicit reconciliation.
   */
  private async consumeEvents(
    signal: AbortSignal,
    onEvent: (event: string, payload: unknown) => void,
    options: BackendListenOptions = {},
  ): Promise<void> {
    const stream = this.eventStream;
    const now = options.streamNow ?? Date.now;
    const backoff = new ReconnectBackoff(
      {
        initialDelayMs: this.eventReconnectDelayMs,
        maxDelayMs: Math.max(this.eventReconnectDelayMs, EVENT_RECONNECT_MAX_DELAY_MS),
        healthyAfterMs: EVENT_STREAM_HEALTHY_AFTER_MS,
      },
      { now },
    );
    while (!signal.aborted) {
      const watch = watchStreamAttempt(signal, options);
      let credentialRejected = false;
      try {
        const url = this.endpoint("/__orkestrator/events");
        if (stream.cursor) url.searchParams.set(GATEWAY_EVENT_CURSOR_PARAM, stream.cursor);
        // Relayed events come on their own filtered stream, for what windows
        // listen to. A backend from before per-node names ignores this and sends
        // them here under the old name, which windows always listen for.
        url.searchParams.set(
          GATEWAY_RELAYED_EVENTS_PARAM,
          "per-node" satisfies GatewayRelayedEventsMode,
        );
        if (!this.relayTerminalOutput) {
          url.searchParams.set("excludeEvents", TERMINAL_OUTPUT_EVENT_PREFIX);
        }
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: watch.signal,
        });
        credentialRejected = response.status === 401;
        if (!response.ok || !response.body)
          throw new Error(`Backend event stream returned HTTP ${response.status}`);
        if (signal.aborted) {
          await response.body.cancel().catch(() => undefined);
          return;
        }
        watch.heard();
        backoff.connected();
        options.onStreamState?.("open");
        // Terminal output is excluded from authoritative replay. Even a quiet
        // caught-up reconnect must trigger exact snapshot recovery.
        onEvent(TERMINAL_EVENT_STREAM_CONNECTED_EVENT, undefined);
        await readSseStream(
          response.body,
          watch.signal,
          (frame) => {
            if (!frame.data) return;
            const message = stream.accept(frame.data, frame.id);
            if (message.kind === "event") onEvent(message.event, message.payload);
            else if (message.kind === "resync")
              onEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
            else if (message.kind === "malformed") {
              clientLog.warn("event-stream.malformed-frame");
            }
          },
          undefined,
          watch.heard,
        );
      } catch (error) {
        if (signal.aborted) return;
        clientLog.warn("event-stream.disconnected", { error: formatLogError(error) });
      } finally {
        watch.stop();
      }
      if (signal.aborted) return;
      // A refused credential proves the backend is reachable. Keep reads enabled
      // so command responses can expose the authentication failure to the user.
      options.onStreamState?.(credentialRejected ? "unauthorized" : "closed");
      // A stream that ends cleanly is retried with the same backoff as a failed
      // one, so a peer that accepts and immediately closes cannot spin this loop.
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", wake);
          resolve();
        };
        const timer = setTimeout(wake, backoff.nextDelayMs());
        signal.addEventListener("abort", wake, { once: true });
      });
    }
  }

  private async gatewaySettings(
    method: "GET" | "PUT",
    body?: { token: string },
  ): Promise<GatewayTokenSettings> {
    const response = await fetch(this.endpoint("/__orkestrator/gateway-settings"), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch((error) => {
      if (!response.ok) return {};
      throw new Error("Backend settings returned malformed JSON", { cause: error });
    })) as GatewayTokenSettings & {
      error?: string;
    };
    if (!response.ok)
      throw new Error(
        payload.error ?? `Backend settings request failed with HTTP ${response.status}`,
      );
    return payload;
  }

  private async webClientAccess(
    method: "GET" | "PUT" | "DELETE",
    body?: { enabled: boolean },
  ): Promise<WebClientStatus> {
    const response = await fetch(this.endpoint("/__orkestrator/web-client-access"), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch((error) => {
      if (!response.ok) return {};
      throw new Error("Backend web client response was malformed JSON", { cause: error });
    })) as WebClientStatus & {
      error?: string;
    };
    if (!response.ok)
      throw new Error(
        payload.error ?? `Backend web client request failed with HTTP ${response.status}`,
      );
    return payload;
  }
}

export class BackendProcess {
  private child: ChildProcess | null = null;
  private childClosed: Promise<void> | null = null;
  private client: BackendHttpClient | null = null;
  private info: GatewayStartInfo | null = null;
  private starting: Promise<BackendHttpClient> | null = null;

  async start(options: {
    isDev: boolean;
    appVersion?: string;
    appRoot: string;
    resourceRoot: string;
    dataDir: string;
    toolchainBinDir?: string;
    rendererDevServerUrl?: string;
    gatewayHost?: string;
    gatewayPort?: number;
    fallbackGatewayHost?: string;
    allowNonTailscaleBind?: boolean;
    desktopWebClient?: boolean;
    /** This app can install updates; the backend accepts remote update requests. */
    desktopUpdater?: boolean;
    tailscaleExecutable?: string;
    runtimeFlavor?: "production" | "development" | "agent-test";
    runtimeProfileId?: string;
    worktreeDir?: string;
    dockerImage?: string;
    strictDockerOwner?: boolean;
    strictGatewayPort?: boolean;
    credentialSources?: AgentPlatform[];
    /** Exact agent tools port (`--agent-tools-port`); agent-test profiles only. */
    agentToolsPort?: number;
    /** False when no window will need terminal output from this client's stream. */
    relayTerminalOutput?: boolean;
    onEvent: (event: string, payload: unknown) => void;
    onUnexpectedExit?: (error: Error) => void;
    onLogPolicyChanged?: BackendLogPolicyListener;
  }): Promise<BackendHttpClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.launch(options).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(options: {
    isDev: boolean;
    appVersion?: string;
    appRoot: string;
    resourceRoot: string;
    dataDir: string;
    toolchainBinDir?: string;
    rendererDevServerUrl?: string;
    gatewayHost?: string;
    gatewayPort?: number;
    fallbackGatewayHost?: string;
    allowNonTailscaleBind?: boolean;
    desktopWebClient?: boolean;
    /** This app can install updates; the backend accepts remote update requests. */
    desktopUpdater?: boolean;
    tailscaleExecutable?: string;
    runtimeFlavor?: "production" | "development" | "agent-test";
    runtimeProfileId?: string;
    worktreeDir?: string;
    dockerImage?: string;
    strictDockerOwner?: boolean;
    strictGatewayPort?: boolean;
    credentialSources?: AgentPlatform[];
    /** Exact agent tools port (`--agent-tools-port`); agent-test profiles only. */
    agentToolsPort?: number;
    /** False when no window will need terminal output from this client's stream. */
    relayTerminalOutput?: boolean;
    onEvent: (event: string, payload: unknown) => void;
    onUnexpectedExit?: (error: Error) => void;
    onLogPolicyChanged?: BackendLogPolicyListener;
  }): Promise<BackendHttpClient> {
    const bun = options.isDev ? "bun" : path.join(options.resourceRoot, "bin", "bun");
    const entry = options.isDev
      ? path.join(options.appRoot, "apps", "backend", "src", "main.ts")
      : path.join(options.resourceRoot, "backend", "main.js");
    const args = [
      entry,
      "--port",
      String(desktopGatewayPort(options.isDev, options.gatewayPort)),
      "--control-host",
      "127.0.0.1",
      "--control-port",
      "0",
      "--data-dir",
      options.dataDir,
      "--app-root",
      options.appRoot,
      "--resource-root",
      options.resourceRoot,
      "--renderer-root",
      options.isDev
        ? path.join(options.appRoot, "apps", "web", "dist")
        : path.join(options.resourceRoot, "web"),
    ];
    if (options.toolchainBinDir) args.push("--toolchain-bin-dir", options.toolchainBinDir);
    if (options.desktopUpdater) args.push("--desktop-updater");
    // The desktop's local backend is always a command node: it can register
    // the user's other machines as its leaves (docs/architecture/command-nodes.md).
    args.push("--command-node");
    if (options.desktopWebClient) {
      args.push(
        "--desktop-web-client",
        "--host",
        "127.0.0.1",
        "--allow-non-tailscale-bind",
        "--allowed-origins",
        HOSTED_WEB_CLIENT_ORIGINS.join(","),
      );
      if (options.tailscaleExecutable) args.push("--tailscale-bin", options.tailscaleExecutable);
    } else if (options.gatewayHost) {
      args.push("--host", options.gatewayHost);
    } else {
      args.push("--fallback-host", options.fallbackGatewayHost ?? "127.0.0.1");
    }
    if (options.allowNonTailscaleBind) args.push("--allow-non-tailscale-bind");
    if (options.rendererDevServerUrl)
      args.push("--renderer-dev-server-url", options.rendererDevServerUrl);
    if (options.runtimeFlavor) args.push("--runtime-flavor", options.runtimeFlavor);
    if (options.runtimeProfileId) args.push("--runtime-profile-id", options.runtimeProfileId);
    if (options.worktreeDir) args.push("--worktree-dir", options.worktreeDir);
    if (options.dockerImage) args.push("--docker-image", options.dockerImage);
    if (options.strictDockerOwner) args.push("--strict-docker-owner");
    if (options.strictGatewayPort) args.push("--strict-gateway-port");
    if (options.credentialSources?.length)
      args.push("--credential-source", options.credentialSources.join(","));
    if (options.agentToolsPort !== undefined)
      args.push("--agent-tools-port", String(options.agentToolsPort));

    // Isolate desktop startup from any remote-service configuration in the parent shell.
    const isolatedCredentialRoot = path.join(options.dataDir, "agent-credentials");
    const env = createBackendProcessEnvironment(
      process.env,
      options.appVersion,
      options.runtimeFlavor
        ? {
            flavor: options.runtimeFlavor,
            credentialSources: options.credentialSources,
            isolatedCredentialRoot,
          }
        : undefined,
    );
    if (options.runtimeFlavor === "agent-test") {
      await seedAgentTestDockerConfig({
        isolatedCredentialRoot,
        sourceDir: hostDockerConfigDir(process.env),
      }).catch((error: unknown) => {
        desktopLog.warn("backend.docker-context-seed-failed", { error: formatLogError(error) });
      });
      await removeAgentTestHostKeychainLink(isolatedCredentialRoot).catch((error: unknown) => {
        desktopLog.warn("backend.keychain-link-remove-failed", { error: formatLogError(error) });
      });
    }
    const child = spawn(bun, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    // `exit` can precede the last stdout/stderr lines. Keep the drain wait
    // even after childFailure clears the process state on exit.
    this.childClosed = new Promise((resolve) => child.once("close", () => resolve()));
    // Line-oriented: production logging tees `console`, so a chunk boundary
    // must not become a log-entry boundary or split a single record. Bounded:
    // a backend line with no newline cannot grow this process's memory.
    if (child.stderr) {
      forEachBoundedLine(child.stderr, (line) => {
        relayBackendLine("stderr", line, options.onLogPolicyChanged);
      });
    }

    let startupComplete = false;
    let unexpectedExitReported = false;
    let rejectStartup: ((error: Error) => void) | null = null;
    const clearState = () => {
      if (this.child !== child) return;
      this.client?.stopListening();
      this.client = null;
      this.child = null;
      this.info = null;
    };
    const childFailure = (error: Error) => {
      rejectStartup?.(error);
      if (this.child !== child) return;
      clearState();
      if (startupComplete && !unexpectedExitReported) {
        unexpectedExitReported = true;
        options.onUnexpectedExit?.(error);
      }
    };
    child.once("error", (error) => childFailure(error));
    child.once("exit", (code, signal) =>
      childFailure(
        // As fields too: the essential log keeps these and never the message.
        Object.assign(
          new Error(
            `Backend service exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})`,
          ),
          { exitCode: code ?? undefined, signal: signal ?? undefined },
        ),
      ),
    );

    try {
      const ready = await new Promise<ReadyMessage>((resolve, reject) => {
        rejectStartup = reject;
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for the backend service")),
          30_000,
        );
        if (!child.stdout) {
          clearTimeout(timeout);
          reject(new Error("Backend service stdout is unavailable"));
          return;
        }
        const finish = (message: ReadyMessage) => {
          clearTimeout(timeout);
          rejectStartup = null;
          resolve(message);
        };
        forEachBoundedLine(child.stdout, (line) => {
          const message = parseReadyMessage(line);
          if (message) finish(message);
          else relayBackendLine("stdout", line, options.onLogPolicyChanged);
        });
      });
      // A change this process missed while the backend was down, and the
      // backend's one-time upgrade of an older config.
      options.onLogPolicyChanged?.();
      const auth = JSON.parse(await readFile(ready.authFile, "utf8")) as { token?: unknown };
      if (typeof auth.token !== "string" || auth.token.length < 16) {
        throw new Error("Backend authentication file does not contain a valid token");
      }
      if (this.child !== child || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Backend service exited during startup");
      }
      this.info = ready;
      this.client = new BackendHttpClient(ready.url, auth.token, {
        relayTerminalOutput: options.relayTerminalOutput,
      });
      this.client.listen(options.onEvent);
      startupComplete = true;
      return this.client;
    } catch (error) {
      rejectStartup = null;
      clearState();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      throw error;
    }
  }

  getInfo(): GatewayStartInfo | null {
    return this.info;
  }

  getPid(): number | undefined {
    return this.child?.pid;
  }

  /** Sends SIGTERM; resolves after exit and delivery of the final stdio lines. */
  stop(): Promise<void> {
    const child = this.child;
    this.client?.stopListening();
    this.client = null;
    this.child = null;
    this.info = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      return this.childClosed ?? Promise.resolve();
    }
    const closed =
      this.childClosed ?? new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 20_000);
    force.unref();
    return closed.finally(() => clearTimeout(force));
  }
}
