/**
 * Claude's sign-in state for this bridge: the account read behind
 * `GET /global/auth` and the prompt admission every session reports.
 *
 * Both come from one cached `accountInfo()` probe. The probe spawns a whole
 * Claude CLI, so it runs only when something asks: an auth read, or Claude
 * refusing a turn for want of a login. It can tell that no credential exists,
 * but not that one has expired, so only the first locks the composer. An
 * expired login keeps failing as a turn error, which the tab already turns
 * into a sign-in card.
 */
import { controlOnlyQuery } from "./control-only-query.js";
import type { AccountInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  NativeAgentAuthStatus,
  NativeAgentReadiness,
  NativeAgentSignInRoute,
} from "@orkestrator/protocol/native-agent";
import { claudeExecutableOptions } from "./session-manager-core.js";

const AUTH_CACHE_TTL_MS = 30_000;
const FAILED_AUTH_CACHE_TTL_MS = 5_000;

const CLAUDE_SIGN_IN: NativeAgentSignInRoute = {
  kind: "terminal",
  hint: "Open a Claude terminal tab and run /login.",
};

export const CLAUDE_SIGN_IN_REQUIRED_MESSAGE =
  "Claude isn't signed in. Sign in to Claude to keep working.";

let authCache: { expiresAt: number; value: NativeAgentAuthStatus } | undefined;
/** One probe at a time: a background re-read and a route read share it. */
let authRead: Promise<NativeAgentAuthStatus> | undefined;
let authReadGeneration: number | undefined;
let authRefreshPending = false;
/** Bumped by every invalidation so an older probe cannot repopulate the cache. */
let authGeneration = 0;
/**
 * A turn failed authentication and no model has answered since. The probe
 * cannot see an expired or revoked login, so while it still finds a
 * credential the read reports `expired` rather than `signed-in`. That never
 * locks the composer; only `needs-auth` does.
 */
let turnAuthenticationFailed = false;

function withTurnFailure(value: NativeAgentAuthStatus): NativeAgentAuthStatus {
  return turnAuthenticationFailed && value.state === "signed-in"
    ? { ...value, state: "expired" }
    : value;
}

export function resetClaudeSignInForTesting(): void {
  authCache = undefined;
  authRead = undefined;
  authReadGeneration = undefined;
  authRefreshPending = false;
  authGeneration += 1;
  turnAuthenticationFailed = false;
}

/** Claude reports an absent source as the literal string "none". */
function presentSource(value: string | undefined): string | undefined {
  return value && value !== "none" ? value : undefined;
}

export function normalizeClaudeAccount(account: AccountInfo): NativeAgentAuthStatus {
  const source = presentSource(account.apiKeySource) ?? presentSource(account.tokenSource);
  // `firstParty` is reported with or without a login. Any other backend
  // (Bedrock, Vertex, a gateway) is authenticated outside Claude's own login.
  const externalProvider =
    account.apiProvider && account.apiProvider !== "firstParty" ? account.apiProvider : undefined;
  const signedIn = Boolean(
    source || account.subscriptionType || account.organization || externalProvider,
  );
  const label = account.organization || account.subscriptionType || externalProvider;
  return {
    state: signedIn ? "signed-in" : "needs-auth",
    ...(label
      ? {
          account: {
            label,
            ...(account.subscriptionType ? { plan: account.subscriptionType } : {}),
          },
        }
      : {}),
    signIn: CLAUDE_SIGN_IN,
    signOut: false,
  };
}

async function probeAccount(): Promise<NativeAgentAuthStatus> {
  let probe: Query | undefined;
  try {
    probe = controlOnlyQuery({
      cwd: process.env.CWD || process.cwd(),
      env: { ...process.env },
      ...claudeExecutableOptions(),
    });
    return normalizeClaudeAccount(await probe.accountInfo());
  } finally {
    await Promise.resolve(probe?.close()).catch(() => undefined);
  }
}

export function readClaudeAuthStatus(): Promise<NativeAgentAuthStatus> {
  if (authCache && authCache.expiresAt > Date.now()) {
    return Promise.resolve(withTurnFailure(authCache.value));
  }
  if (authRead) return authRead;
  const generation = authGeneration;
  const read = probeAccount()
    .then(
      (value) => ({ value, ttl: AUTH_CACHE_TTL_MS }),
      () => ({
        value: {
          state: "unknown",
          signIn: CLAUDE_SIGN_IN,
          signOut: false,
        } as NativeAgentAuthStatus,
        ttl: FAILED_AUTH_CACHE_TTL_MS,
      }),
    )
    .then(({ value, ttl }) => {
      if (generation === authGeneration) {
        authCache = { expiresAt: Date.now() + ttl, value };
      }
      return withTurnFailure(value);
    })
    .finally(() => {
      if (authRead !== read) return;
      authRead = undefined;
      authReadGeneration = undefined;
      if (authRefreshPending) {
        authRefreshPending = false;
        void readClaudeAuthStatus();
      }
    });
  authReadGeneration = generation;
  authRead = read;
  return read;
}

/**
 * Claude refused a turn because it has no usable login. Re-read the account
 * now rather than waiting for the cache, so a missing login locks the
 * composer before the user sends into the same failure again.
 */
export function noteClaudeAuthenticationFailure(): void {
  turnAuthenticationFailed = true;
  authCache = undefined;
  // Failures share the active probe. If success already fenced it, queue one
  // replacement after its cleanup, rather than spawning concurrent CLIs.
  if (authRead && authReadGeneration !== authGeneration) authRefreshPending = true;
  void readClaudeAuthStatus();
}

/** A model answered, so a cached "no login" is stale. */
export function noteClaudeAuthenticationWorked(): void {
  // Success also fences a probe that has not published any cache entry yet.
  // Keep its slot until cleanup completes so another read cannot spawn a
  // second CLI while the obsolete probe is still running.
  authGeneration += 1;
  authRefreshPending = false;
  turnAuthenticationFailed = false;
  if (authCache?.value.state === "needs-auth") authCache = undefined;
}

/**
 * Prompt admission for every session on this bridge. Omitted unless a probe
 * found no credential at all, because absent readiness never locks the tab.
 * While locked, an expired answer is re-read in the background, so a login
 * made in a terminal unlocks the tab without a send; a failed re-read is
 * `unknown` and unlocks it too.
 */
export function claudeReadiness(): NativeAgentReadiness | undefined {
  const cached = authCache;
  if (cached?.value.state !== "needs-auth") return undefined;
  if (cached.expiresAt <= Date.now()) void readClaudeAuthStatus();
  return {
    state: "authentication-required",
    message: CLAUDE_SIGN_IN_REQUIRED_MESSAGE,
    signIn: CLAUDE_SIGN_IN,
  };
}
