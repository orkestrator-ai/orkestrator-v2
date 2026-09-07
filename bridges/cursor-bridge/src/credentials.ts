/**
 * Resolving the credential the SDK runs under, and minting one interactively.
 *
 * The SDK accepts three credentials in a fixed order — an explicit key, then
 * `CURSOR_API_KEY`, then a stored login. This bridge makes that order explicit
 * so an environment cannot silently fall back to an ambient key the user did
 * not choose, and so the settings UI can say which one is in play.
 *
 * Nothing here logs, returns or persists a key outside the SDK's own store.
 * `authStatus` deliberately reports only presence and expiry.
 */
import { Cursor, FileCredentialStore, type SdkCredentialStore } from "@cursor/sdk";
import type { NativeAgentAuthStatus } from "@orkestrator/protocol/native-agent";
import { credentialFile, LOGIN_TIMEOUT_MS } from "./config.js";

export type CredentialSource = "api-key-env" | "stored-login" | "none";

export const CURSOR_AUTHENTICATION_REQUIRED_MESSAGE =
  "Cursor is not signed in. Sign in from Settings › Cursor, or set a Cursor API key.";

export interface CredentialResolution {
  apiKey?: string;
  source: CredentialSource;
}

export type BridgeAuthStatus = NativeAgentAuthStatus;
const AUTH_CACHE_TTL_MS = 15_000;
let authCache: { credential: string; expiresAt: number; value: BridgeAuthStatus } | undefined;

/**
 * The credential store this bridge reads and writes.
 *
 * Pointed at Orkestrator's own data directory when the launcher supplies a
 * path, so an environment authenticated through the app is isolated from
 * unrelated Cursor state and a container can be handed exactly one credential
 * file. Falls back to the SDK default otherwise.
 */
export const credentialStore: SdkCredentialStore = credentialFile
  ? new FileCredentialStore(credentialFile)
  : new FileCredentialStore();

export async function resolveCredential(): Promise<CredentialResolution> {
  const fromEnvironment = process.env.CURSOR_API_KEY?.trim();
  if (fromEnvironment) return { apiKey: fromEnvironment, source: "api-key-env" };
  const stored = await credentialStore.load().catch(() => undefined);
  if (stored?.apiKey && !isExpired(stored.apiKeyExpiresAtMs)) {
    return { apiKey: stored.apiKey, source: "stored-login" };
  }
  return { source: "none" };
}

/**
 * Report whether this bridge can run a turn, without disclosing the key.
 *
 * An expired stored login reads as unauthenticated rather than as an error:
 * the remedy is the same login flow either way, and the settings UI should
 * offer it rather than a failure the user cannot act on.
 */
export async function authStatus(): Promise<BridgeAuthStatus> {
  const fromEnvironment = process.env.CURSOR_API_KEY?.trim();
  const stored = fromEnvironment ? undefined : await credentialStore.load().catch(() => undefined);
  const statusFn = (
    Cursor.auth as typeof Cursor.auth & {
      status?: typeof Cursor.auth.status;
    }
  ).status;
  const sdkStatus = fromEnvironment
    ? ({ status: "logged-in" as const } as const)
    : statusFn
      ? await statusFn({ store: credentialStore }).catch(() => ({ status: "logged-out" as const }))
      : stored?.apiKey
        ? ({
            status: "logged-in" as const,
            email: stored.email,
            apiKeyExpiresAtMs: stored.apiKeyExpiresAtMs,
          } as const)
        : ({ status: "logged-out" as const } as const);
  if (sdkStatus.status !== "logged-in") {
    return { state: "signed-out", signIn: { kind: "browser-url" }, signOut: false };
  }
  const expiresAtMs =
    "apiKeyExpiresAtMs" in sdkStatus ? sdkStatus.apiKeyExpiresAtMs : stored?.apiKeyExpiresAtMs;
  if (isExpired(expiresAtMs)) {
    return { state: "expired", signIn: { kind: "browser-url" }, signOut: true };
  }
  const credential = fromEnvironment ?? stored?.apiKey;
  if (credential && authCache?.credential === credential && authCache.expiresAt > Date.now()) {
    return authCache.value;
  }
  const meFn = (Cursor as typeof Cursor & { me?: typeof Cursor.me }).me;
  const me =
    credential && meFn ? await meFn({ apiKey: credential }).catch(() => undefined) : undefined;
  const label =
    [me?.userFirstName, me?.userLastName].filter(Boolean).join(" ") ||
    me?.apiKeyName ||
    ("email" in sdkStatus ? sdkStatus.email : undefined) ||
    stored?.email ||
    "Cursor account";
  const value: BridgeAuthStatus = {
    state: "signed-in",
    account: {
      label,
      ...(expiresAtMs ? { expiresAt: new Date(expiresAtMs).toISOString() } : {}),
    },
    signIn: fromEnvironment
      ? { kind: "none", hint: "Remove CURSOR_API_KEY to sign out." }
      : { kind: "browser-url" },
    signOut: !fromEnvironment,
  };
  if (credential) {
    authCache = { credential, expiresAt: Date.now() + AUTH_CACHE_TTL_MS, value };
  }
  return value;
}

export interface LoginHandle {
  /** Resolves once the user completes the browser flow, or rejects. */
  completion: Promise<BridgeAuthStatus>;
  /** The URL the user must open. Available before `completion` settles. */
  loginUrl: Promise<string>;
  cancel(): void;
}

/**
 * Start an interactive login and hand back the URL to open.
 *
 * `openBrowser` is the caller's decision because it depends entirely on where
 * this process is running. The one-shot `--login` child is spawned by the
 * backend on the user's own machine, so opening a browser there is exactly
 * right. A bridge serving a session may instead be inside a container, where
 * the same launch would either fail or open a browser nobody is looking at —
 * those callers leave it off and let Orkestrator surface the URL instead.
 *
 * The URL is published either way, so a host that opened a browser still has
 * something to show when the launch silently did nothing.
 */
export function beginLogin(options: { openBrowser?: boolean } = {}): LoginHandle {
  const controller = new AbortController();
  let publishUrl: (url: string) => void = () => undefined;
  let failUrl: (error: Error) => void = () => undefined;
  const loginUrl = new Promise<string>((resolve, reject) => {
    publishUrl = resolve;
    failUrl = reject;
  });

  const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
  timeout.unref();

  const completion = Cursor.auth
    .login({
      openBrowser: options.openBrowser ?? false,
      onLoginUrl: (url) => publishUrl(url),
      signal: controller.signal,
      store: credentialStore,
      apiKeyName: "Orkestrator",
    })
    .then(async () => authStatus())
    .catch((error: unknown) => {
      // A failure before the URL was published would otherwise leave a caller
      // awaiting `loginUrl` forever.
      failUrl(error instanceof Error ? error : new Error(String(error)));
      throw error;
    })
    .finally(() => clearTimeout(timeout));

  // The URL promise is settled by whichever of the two paths above runs first;
  // an unobserved rejection on it must not take the process down.
  void loginUrl.catch(() => undefined);

  return {
    completion,
    loginUrl,
    cancel: () => controller.abort(),
  };
}

export async function logout(): Promise<void> {
  authCache = undefined;
  await Cursor.auth.logout({ store: credentialStore });
}

function isExpired(expiresAtMs: number | undefined): boolean {
  return typeof expiresAtMs === "number" && expiresAtMs <= Date.now();
}
