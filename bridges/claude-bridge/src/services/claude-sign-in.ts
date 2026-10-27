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
import { liveInitializationResult, readFromLiveClaude } from "./live-claude-control.js";
import type { AccountInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  NativeAgentAuthStatus,
  NativeAgentReadiness,
  NativeAgentSignInRoute,
} from "@orkestrator/protocol/native-agent";
import { claudeExecutableOptions } from "./session-manager-core.js";

const AUTH_CACHE_TTL_MS = 30_000;
const FAILED_AUTH_CACHE_TTL_MS = 5_000;

/**
 * The bridge cannot run Claude's login itself: the backend drives
 * `claude auth login` for the active account (`ClaudeAuthRecoveryCard`, the
 * Agent Info card and Settings → Claude). `terminal` stays the kind because
 * the CLI's own `/login` in a terminal is still the fallback those cards offer,
 * and no route kind names a backend-driven login.
 */
const CLAUDE_SIGN_IN: NativeAgentSignInRoute = {
  kind: "terminal",
  hint: "Sign in to Claude from the sign-in card in this tab or from Settings → Claude.",
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
 * A turn failed authentication recently. The probe
 * cannot see an expired or revoked login, so while it still finds a
 * credential the read reports `expired` rather than `signed-in` for one cache
 * window. A later probe can observe a terminal re-login without requiring a
 * successful turn first. That never locks the composer; only `needs-auth` does.
 */
let turnAuthenticationFailedUntil = 0;
/** Launch-time accounts stay suspect until a model proves authentication works. */
let reuseLiveAccounts = true;

function withTurnFailure(value: NativeAgentAuthStatus): NativeAgentAuthStatus {
  return Date.now() < turnAuthenticationFailedUntil && value.state === "signed-in"
    ? { ...value, state: "expired" }
    : value;
}

export function resetClaudeSignInForTesting(): void {
  authCache = undefined;
  authRead = undefined;
  authReadGeneration = undefined;
  authRefreshPending = false;
  authGeneration += 1;
  turnAuthenticationFailedUntil = 0;
  reuseLiveAccounts = true;
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

/**
 * The account a running CLI signed in with, read from its initialize answer.
 *
 * Only a signed-in answer counts. That answer is from the CLI's launch, so it
 * cannot show a login made since: a `needs-auth` one would keep the composer
 * locked after the user signed in from a terminal, which only a probe sees.
 * A login revoked since is caught by the turn that fails on it
 * (`noteClaudeAuthenticationFailure`).
 */
function liveSignedInAccount(): Promise<NativeAgentAuthStatus | undefined> {
  return readFromLiveClaude((control) =>
    liveInitializationResult(control)?.then((result) => {
      const account = result?.account;
      if (!account || typeof account !== "object") return undefined;
      const status = normalizeClaudeAccount(account as AccountInfo);
      return status.state === "signed-in" ? status : undefined;
    }),
  );
}

async function probeAccount(): Promise<NativeAgentAuthStatus> {
  // A warm CLI's launch-time account cannot prove that a refused login still
  // exists. Check again after awaiting it in case a turn failed mid-read.
  if (reuseLiveAccounts) {
    const live = await liveSignedInAccount();
    if (live && reuseLiveAccounts) return live;
  }
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
  reuseLiveAccounts = false;
  turnAuthenticationFailedUntil = Date.now() + AUTH_CACHE_TTL_MS;
  authCache = undefined;
  // Failures share the active probe. If success already fenced it, queue one
  // replacement after its cleanup, rather than spawning concurrent CLIs.
  if (authRead && authReadGeneration !== authGeneration) authRefreshPending = true;
  void readClaudeAuthStatus();
}

/** A model answered, so a cached "no login" is stale. */
export function noteClaudeAuthenticationWorked(): void {
  reuseLiveAccounts = true;
  // Success also fences a probe that has not published any cache entry yet.
  // Keep its slot until cleanup completes so another read cannot spawn a
  // second CLI while the obsolete probe is still running.
  authGeneration += 1;
  authRefreshPending = false;
  turnAuthenticationFailedUntil = 0;
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
