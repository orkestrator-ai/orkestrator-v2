/**
 * The experimental Cursor SDK bridge: selection, credentials and login.
 *
 * Cursor sessions can be served by either of two bridge processes — the ACP
 * one that drives `cursor-agent`, or the SDK one that drives `@cursor/sdk`.
 * The platform, the provider, the transcript shape and every route are
 * identical; only the engine differs. This module owns the choice between them
 * and the credential the SDK engine needs, so no caller has to know that two
 * exist.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";

/**
 * Where a login minted through Orkestrator is stored.
 *
 * Deliberately inside Orkestrator's own data directory rather than the SDK
 * default of `~/.cursor/sdk/auth.json`: an environment authenticated through
 * the app should not be revoked by an unrelated `cursor-agent` logout, and a
 * container can be handed exactly this one file.
 */
export function cursorSdkCredentialPath(context: CommandContext): string {
  return path.join(context.storage.getDataDir(), "cursor-sdk", "auth.json");
}

/** Inside a container, where the same credential is delivered. */
export const CONTAINER_CURSOR_SDK_AUTH_FILE = "/tmp/orkestrator-ai/cursor-sdk-auth.json";

/** Whether new Cursor sessions should be created on the SDK bridge. */
export async function cursorSdkBridgeEnabled(context: CommandContext): Promise<boolean> {
  const config = await context.storage.loadConfig();
  return config.global.experimentalCursorSdkBridge === true;
}

export interface CursorSdkAuthStatus {
  authenticated: boolean;
  source: "api-key-env" | "api-key-config" | "stored-login" | "none";
  email?: string;
  expiresAt?: string;
}

/**
 * Report whether the SDK engine can run a turn, without disclosing the key.
 *
 * The order mirrors the bridge's own resolution so the settings pane cannot
 * claim a credential the bridge would not actually use. A stored API key is
 * reported separately from an inherited one because only the former can be
 * cleared from this pane.
 */
export async function cursorSdkAuthStatus(
  context: CommandContext,
  storedApiKey: string | undefined,
): Promise<CursorSdkAuthStatus> {
  if (process.env.CURSOR_API_KEY?.trim()) {
    return { authenticated: true, source: "api-key-env" };
  }
  if (storedApiKey?.trim()) return { authenticated: true, source: "api-key-config" };

  const credentials = await readStoredCredentials(cursorSdkCredentialPath(context));
  if (!credentials) return { authenticated: false, source: "none" };
  return {
    authenticated: true,
    source: "stored-login",
    ...(credentials.email ? { email: credentials.email } : {}),
    ...(credentials.apiKeyExpiresAtMs
      ? { expiresAt: new Date(credentials.apiKeyExpiresAtMs).toISOString() }
      : {}),
  };
}

interface StoredCredentials {
  apiKey: string;
  email?: string;
  apiKeyExpiresAtMs?: number;
}

/**
 * Read the stored login, treating an expired or malformed file as absent.
 *
 * Never returns the key to a caller that only asked about status; the one
 * caller that needs it is the container credential sync below.
 */
async function readStoredCredentials(filePath: string): Promise<StoredCredentials | undefined> {
  const raw = await readFile(filePath, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt credential file reads as logged out, so the remedy the UI
    // offers is the login flow rather than an error the user cannot act on.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.apiKey !== "string" || !record.apiKey.trim()) return undefined;
  const expiresAtMs =
    typeof record.apiKeyExpiresAtMs === "number" ? record.apiKeyExpiresAtMs : undefined;
  if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) return undefined;
  return {
    apiKey: record.apiKey,
    ...(typeof record.email === "string" ? { email: record.email } : {}),
    ...(expiresAtMs !== undefined ? { apiKeyExpiresAtMs: expiresAtMs } : {}),
  };
}

/** The stored login's key, for delivery into a container. */
export async function cursorSdkStoredApiKey(context: CommandContext): Promise<string | undefined> {
  return (await readStoredCredentials(cursorSdkCredentialPath(context)))?.apiKey;
}

export async function cursorSdkLogout(context: CommandContext): Promise<void> {
  // Local only: the minted key stays valid until its expiry unless revoked
  // from Cursor's dashboard. Say that where the user can see it rather than
  // implying this revokes anything.
  await rm(cursorSdkCredentialPath(context), { force: true });
}

export interface CursorSdkLoginHandle {
  loginUrl: string;
  /** Resolves when the browser flow completes. Rejects with a readable reason. */
  completion: Promise<void>;
  cancel(): void;
}

/**
 * How long to wait for the one-shot login child to emit its login URL. The
 * child opens a browser and prints one JSON line, so it should be near
 * instant; a child that has not produced a URL after this is wedged and must
 * not leave the login flow stranded as "pending".
 */
export const LOGIN_START_TIMEOUT_MS = 30_000;

/**
 * Run an interactive login in a short-lived bridge process.
 *
 * The SDK is a five-megabyte bundle with native helpers, and it lives in the
 * bridge package rather than the backend. Spawning the bridge in its one-shot
 * login mode keeps that dependency where it belongs and means a login needs no
 * environment, no container and no running session — the credential it mints
 * is account-wide.
 */
export async function beginCursorSdkLogin(
  context: CommandContext,
  options: {
    bridgeEntrypoint: string;
    runtime: string;
    /** Injected by tests; defaults to the real spawn. */
    spawnImpl?: typeof spawn;
    /** Lets the backend cancel a login before the child has emitted its URL. */
    signal?: AbortSignal;
    /** Bounds how long to wait for the child's login URL; tests lower this. */
    startupTimeoutMs?: number;
  },
): Promise<CursorSdkLoginHandle> {
  const credentialPath = cursorSdkCredentialPath(context);
  await mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
  if (!existsSync(options.bridgeEntrypoint)) {
    throw new Error(
      "The Cursor SDK bridge is not built. Run `bun run build:cursor-bridge` and try again.",
    );
  }

  const child = (options.spawnImpl ?? spawn)(
    options.runtime,
    [options.bridgeEntrypoint, "--login"],
    {
      env: {
        ...process.env,
        CURSOR_BRIDGE_AUTH_FILE: credentialPath,
        // The login must mint a credential of its own rather than short-circuit
        // on an ambient one: a user who asks to sign in is asking for a key
        // this app owns and can revoke.
        CURSOR_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let resolveUrl: (url: string) => void = () => undefined;
  let rejectUrl: (error: Error) => void = () => undefined;
  const urlPromise = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  let settleCompletion: (error?: Error) => void = () => undefined;
  const completion = new Promise<void>((resolve, reject) => {
    settleCompletion = (error) => (error ? reject(error) : resolve());
  });
  // A child can fail before it emits the URL, in which case this function
  // rejects without returning the handle that normally observes completion.
  // Mark that sibling promise handled immediately so the backend process does
  // not terminate on its otherwise-unhandled rejection.
  void completion.catch(() => undefined);

  const abortLogin = (): void => {
    child.kill("SIGTERM");
  };
  const removeAbortListener = (): void => {
    options.signal?.removeEventListener("abort", abortLogin);
  };
  // A child that never emits its URL must not strand the login flow as
  // "pending" with no way forward. The timer only guards the pre-URL window;
  // once the URL is out it is cleared and the human-paced browser flow runs
  // under its own (longer) bounds.
  const startupError = new Error(
    "The Cursor sign-in process timed out before producing a login URL",
  );
  const startupTimer = setTimeout(() => {
    abortLogin();
    rejectUrl(startupError);
    settleCompletion(startupError);
  }, options.startupTimeoutMs ?? LOGIN_START_TIMEOUT_MS);
  startupTimer.unref();

  let buffered = "";
  let failure = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    // The child speaks one JSON object per line. Bounded because a runaway
    // child must not be able to grow this buffer without limit.
    if (buffered.length > 64 * 1024) buffered = buffered.slice(-64 * 1024);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (typeof event.loginUrl === "string") {
          clearTimeout(startupTimer);
          resolveUrl(event.loginUrl);
        } else if (event.ok === true) settleCompletion();
        else if (typeof event.error === "string") failure = event.error;
      } catch {
        // Not our protocol. Ignored rather than failed: a stray line from the
        // runtime must not abort a login the user is completing in a browser.
      }
    }
  });
  // Never logged: the child's stderr can carry paths and provider detail.
  child.stderr?.resume();

  child.once("error", (error) => {
    clearTimeout(startupTimer);
    removeAbortListener();
    rejectUrl(error);
    settleCompletion(error);
  });
  child.once("exit", (code) => {
    clearTimeout(startupTimer);
    removeAbortListener();
    const error = new Error(
      failure || `Cursor sign-in did not complete (exit code ${code ?? "null"})`,
    );
    // Both are no-ops once settled, so a clean exit after success stays clean.
    rejectUrl(error);
    settleCompletion(code === 0 ? undefined : error);
  });
  if (options.signal?.aborted) abortLogin();
  else options.signal?.addEventListener("abort", abortLogin, { once: true });

  const loginUrl = await urlPromise;
  return {
    loginUrl,
    completion,
    cancel: abortLogin,
  };
}

export type CursorSdkLoginState = "pending" | "authenticated" | "failed" | "idle";

export interface CursorSdkLoginProgress {
  state: CursorSdkLoginState;
  loginUrl?: string;
  error?: string;
  auth: CursorSdkAuthStatus;
}

/**
 * The single in-flight login, held in the backend rather than the renderer.
 *
 * One at a time: a second concurrent flow would mint a second key and race to
 * persist it. Keeping the handle here is also what lets the settings pane be a
 * plain view — it starts a login and polls a status, and every decision about
 * spawning, parsing, storing and cancelling stays on this side.
 */
let activeLogin:
  | { handle: CursorSdkLoginHandle; state: CursorSdkLoginState; error?: string }
  | undefined;
interface CursorSdkLoginStartup {
  promise: Promise<CursorSdkLoginHandle>;
  controller: AbortController;
  cancelled: boolean;
}
let activeLoginStartup: CursorSdkLoginStartup | undefined;

export async function startCursorSdkLogin(
  context: CommandContext,
  options: { bridgeEntrypoint: string; runtime: string; spawnImpl?: typeof spawn },
): Promise<{ loginUrl: string }> {
  if (activeLogin?.state === "pending") return { loginUrl: activeLogin.handle.loginUrl };
  if (activeLoginStartup) {
    const startup = activeLoginStartup;
    try {
      const handle = await startup.promise;
      if (startup.cancelled) throw new Error("Cursor sign-in was cancelled");
      return { loginUrl: handle.loginUrl };
    } catch (error) {
      if (startup.cancelled) throw new Error("Cursor sign-in was cancelled");
      throw error;
    }
  }

  const controller = new AbortController();
  const startup: CursorSdkLoginStartup = {
    promise: beginCursorSdkLogin(context, { ...options, signal: controller.signal }),
    controller,
    cancelled: false,
  };
  activeLoginStartup = startup;
  let handle: CursorSdkLoginHandle;
  try {
    handle = await startup.promise;
  } catch (error) {
    if (activeLoginStartup === startup) activeLoginStartup = undefined;
    if (startup.cancelled) throw new Error("Cursor sign-in was cancelled");
    throw error;
  }
  if (activeLoginStartup === startup) activeLoginStartup = undefined;
  if (startup.cancelled) throw new Error("Cursor sign-in was cancelled");
  const entry = {
    handle,
    state: "pending" as CursorSdkLoginState,
    error: undefined as string | undefined,
  };
  activeLogin = entry;
  void handle.completion.then(
    () => {
      entry.state = "authenticated";
    },
    (error: unknown) => {
      entry.state = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
    },
  );
  return { loginUrl: handle.loginUrl };
}

export async function cursorSdkLoginProgress(
  context: CommandContext,
  storedApiKey: string | undefined,
): Promise<CursorSdkLoginProgress> {
  const auth = await cursorSdkAuthStatus(context, storedApiKey);
  if (activeLoginStartup) return { state: "pending", auth };
  if (!activeLogin) return { state: "idle", auth };
  return {
    state: activeLogin.state,
    loginUrl: activeLogin.handle.loginUrl,
    ...(activeLogin.error ? { error: activeLogin.error } : {}),
    auth,
  };
}

export function cancelCursorSdkLogin(): void {
  if (activeLoginStartup) {
    activeLoginStartup.cancelled = true;
    activeLoginStartup.controller.abort();
  }
  activeLogin?.handle.cancel();
  activeLogin = undefined;
}

/**
 * Deliver a login-minted credential into a container.
 *
 * Mirrors the API-key sync exactly: the key is piped over stdin so it never
 * appears in Docker argv, a process listing or an error message, and the file
 * it lands in is owner-only. The bridge reads it at startup.
 *
 * Passing `undefined` removes the file. That is the path taken when the SDK
 * engine is not selected, or when the user has signed out — a stale credential
 * left in a container would keep working after it was revoked here.
 */
export async function syncContainerCursorSdkCredentials(
  containerId: string,
  apiKey: string | undefined,
  runners: {
    exec: (containerId: string, command: string) => Promise<string>;
    pipe: (containerId: string, command: string, stdin: string) => Promise<void>;
  } = defaultRunners,
): Promise<void> {
  if (!apiKey) {
    await runners.exec(containerId, `rm -f ${CONTAINER_CURSOR_SDK_AUTH_FILE}`);
    return;
  }
  // The SDK's own on-disk credential shape. Written by the backend rather than
  // copied byte-for-byte from the host file so a host file carrying extra
  // fields cannot smuggle them into a container.
  const contents = JSON.stringify({
    version: 1,
    backendUrl: process.env.CURSOR_BACKEND_URL?.trim() || "https://api2.cursor.sh",
    apiKey,
    createdAtMs: Date.now(),
  });
  await runners.pipe(containerId, containerCredentialWriteScript(), contents);
}

const defaultRunners = {
  exec: async (containerId: string, command: string): Promise<string> => {
    const { dockerExec } = await import("./commands-container-exec.js");
    return dockerExec(containerId, command);
  },
  pipe: async (containerId: string, command: string, stdin: string): Promise<void> => {
    const { runCommand } = await import("./shell.js");
    await runCommand("docker", ["exec", "-i", containerId, "sh", "-c", command], {
      stdin,
      timeoutMs: 30_000,
      redactValues: [stdin],
    });
  },
};

/** The in-container script that receives the credential on stdin. */
export function containerCredentialWriteScript(): string {
  return [
    "set -eu",
    `credential_dir=${shellQuote(path.posix.dirname(CONTAINER_CURSOR_SDK_AUTH_FILE))}`,
    'mkdir -p "$credential_dir"',
    'chmod 700 "$credential_dir"',
    'credential_tmp="$(mktemp "$credential_dir/.cursor-sdk-auth.XXXXXX")"',
    "trap 'rm -f \"$credential_tmp\"' EXIT",
    'cat > "$credential_tmp"',
    'chmod 600 "$credential_tmp"',
    `mv "$credential_tmp" ${shellQuote(CONTAINER_CURSOR_SDK_AUTH_FILE)}`,
    "trap - EXIT",
  ].join("\n");
}

/** Persist a credential file directly. Used by recovery and by tests. */
export async function writeCursorSdkCredentials(
  context: CommandContext,
  contents: string,
): Promise<void> {
  const credentialPath = cursorSdkCredentialPath(context);
  await mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
  await writeFile(credentialPath, contents, { mode: 0o600 });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
