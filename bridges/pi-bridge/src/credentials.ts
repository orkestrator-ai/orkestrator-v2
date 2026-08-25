/**
 * Which providers this environment can actually run a turn against.
 *
 * Pi is a harness in front of other people's models rather than a vendor with
 * an account of its own, so "signed in" is not one boolean — it is one answer
 * per provider. Sign-in itself is deliberately not served here: Pi's login is
 * an interactive multi-step prompt flow (`select`, `text`, `secret`) whose
 * shape has no counterpart in Orkestrator's session surface, and the
 * credential it writes is account-wide rather than per-environment. Users sign
 * in with `pi` itself — the `/login` slash command in a Pi terminal tab — or
 * by putting a key in `auth.json` or the provider's environment variable, and
 * containers are handed the resulting config directory.
 *
 * Nothing here logs, returns or persists a key. `authStatus` reports only
 * which providers are configured and how.
 */
import { CATALOG_TIMEOUT_MS } from "./config.js";
import { modelRuntime } from "./runtime.js";
import { withTimeout } from "./timeout.js";

export interface ProviderAuthStatus {
  id: string;
  label: string;
  /** How the credential was supplied, for the "why is this working" question. */
  source?: string;
  type?: "api_key" | "oauth";
  authenticated: boolean;
  /** Models this provider offers that the credential actually unlocks. */
  modelCount: number;
}

export interface BridgeAuthStatus {
  /** True when at least one provider can serve a turn. */
  authenticated: boolean;
  providers: ProviderAuthStatus[];
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

/** The message every "cannot run a turn" path shares, so it reads the same. */
export const NOT_AUTHENTICATED_MESSAGE =
  "Pi has no authenticated model provider. Sign in with /login in a Pi terminal tab, " +
  "or set the provider's API key, then reopen this tab.";

let authProbeTimeoutMs = CATALOG_TIMEOUT_MS;

/**
 * Report which providers are usable, without disclosing any credential.
 *
 * Availability is asked of the runtime rather than inferred from the presence
 * of a stored credential: a key that exists but no longer authorizes anything
 * would otherwise read as signed in, and the user would be told the model
 * picker is empty for no reason they can act on.
 */
export async function authStatus(): Promise<BridgeAuthStatus> {
  const runtime = await modelRuntime();
  // Providers are independent, as are their auth and model probes. Running
  // both dimensions concurrently keeps the route bounded by one timeout
  // window rather than two windows multiplied by every configured provider.
  const providers = await Promise.all(
    runtime.getProviders().map(async (provider): Promise<ProviderAuthStatus> => {
      const configured = runtime.hasConfiguredAuth(provider.id);
      // Bounded per provider: `checkAuth` can reach the network for an OAuth
      // refresh, and one slow provider must not hold the whole status read.
      const [check, models] = configured
        ? await Promise.all([
            withTimeout(
              runtime.checkAuth(provider.id),
              authProbeTimeoutMs,
              `Pi auth check for ${provider.id} timed out`,
            ).catch(() => undefined),
            withTimeout(
              runtime.getAvailable(provider.id),
              authProbeTimeoutMs,
              `Pi model list for ${provider.id} timed out`,
            ).catch(() => []),
          ])
        : [undefined, []];
      return {
        id: provider.id,
        label: provider.name || provider.id,
        // Asked of the runtime rather than inferred from a stored credential
        // being present, which is what this module promises. A key that was
        // revoked after it was written still has `hasConfiguredAuth` true, and
        // reporting that as signed in tells the user their empty model picker is
        // someone else's problem. `checkAuth` resolves undefined for a
        // credential it cannot resolve, and rejects — caught above — when a
        // refresh fails, so either way the models it can actually serve is the
        // corroborating answer.
        authenticated: configured && (Boolean(check) || models.length > 0),
        ...(check?.source ? { source: check.source } : {}),
        ...(check?.type ? { type: check.type } : {}),
        modelCount: models.length,
      };
    }),
  );

  return {
    authenticated: providers.some((provider) => provider.authenticated && provider.modelCount > 0),
    providers,
  };
}

/** Shorten the external auth probe budget for deterministic timeout tests. */
export function setAuthProbeTimeoutForTests(timeoutMs?: number): void {
  authProbeTimeoutMs = timeoutMs ?? CATALOG_TIMEOUT_MS;
}

/**
 * Fail a turn early when nothing can serve it.
 *
 * Called before a session is attached rather than when the first prompt is
 * sent, so an unauthenticated environment reports a readable reason instead of
 * a provider error from deep inside a run the user already paid to start.
 */
export async function assertAuthenticated(): Promise<void> {
  const runtime = await modelRuntime();
  const available = await withTimeout(
    runtime.getAvailable(),
    CATALOG_TIMEOUT_MS,
    "Pi model availability read timed out",
  ).catch(() => []);
  if (available.length === 0) throw new CredentialError(NOT_AUTHENTICATED_MESSAGE);
}
