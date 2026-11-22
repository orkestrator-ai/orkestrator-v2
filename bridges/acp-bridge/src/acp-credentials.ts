/**
 * Whether the ACP agent has any login to run with, checked without starting it.
 *
 * Grok's ACP `authenticate` does not fail when nobody is signed in: it starts
 * an interactive grok.com sign-in and waits, so a session create or a cold
 * attach would hang until its RPC timeout and report nothing actionable. Grok
 * signs in from `$GROK_HOME/auth.json`, an `XAI_API_KEY` fallback, or an
 * external auth-provider command, so only the absence of all three is treated
 * as a confirmed missing login. Anything else is left to `authenticate`.
 *
 * Takes the provider rather than importing it: `acp-context.ts` imports this
 * module, and the reverse edge would make the check depend on evaluation order.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  NativeAgentReadiness,
  NativeAgentSignInRoute,
} from "@orkestrator/protocol/native-agent";

import {
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_SIGN_IN_HINT,
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
} from "./antigravity-acp.js";

export const GROK_SIGN_IN_REQUIRED_MESSAGE =
  "Grok Build isn't signed in. Run grok login in a terminal to keep working.";

/** No login exists, so starting the agent would only wait on a sign-in nobody sees. */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export function acpSignInRoute(provider: string): NativeAgentSignInRoute {
  return {
    kind: "terminal",
    hint:
      provider === "grok"
        ? "Open a terminal and run grok login."
        : provider === ANTIGRAVITY_PROVIDER_ID
          ? ANTIGRAVITY_SIGN_IN_HINT
          : "Sign in with the agent CLI.",
  };
}

/**
 * Antigravity's login cannot be checked from files: agy 1.5 keeps a Google
 * sign-in in the OS keyring (a file only without one). The answer comes from
 * the agent itself: a session request without a login fails with
 * `Authentication required`, which `acp-context.ts` records here, and any
 * session request that succeeds clears it. A recorded refusal holds for
 * `ANTIGRAVITY_SIGN_IN_RECHECK_MS`, after which the next attach or prompt asks
 * agy again, so a login made in a terminal unlocks the tab without a restart.
 */
export const ANTIGRAVITY_SIGN_IN_RECHECK_MS = 60_000;
let antigravitySignInRefusedAt: number | undefined;

export function noteAcpSignInRefused(provider: string, now = Date.now()): void {
  if (provider === ANTIGRAVITY_PROVIDER_ID) antigravitySignInRefusedAt = now;
}

export function noteAcpSignedIn(provider: string): void {
  if (provider === ANTIGRAVITY_PROVIDER_ID) antigravitySignInRefusedAt = undefined;
}

export function antigravitySignInRecentlyRefused(now = Date.now()): boolean {
  return (
    antigravitySignInRefusedAt !== undefined &&
    now - antigravitySignInRefusedAt < ANTIGRAVITY_SIGN_IN_RECHECK_MS
  );
}

/** For tests: forget a recorded refusal. */
export function resetAcpSignInStateForTests(): void {
  antigravitySignInRefusedAt = undefined;
}

type AcpEnvironment = Record<string, string | undefined>;

function grokHome(env: AcpEnvironment): string {
  return env.GROK_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".grok");
}

/** Where Grok keeps its login. `GROK_AUTH_FILE` exists for tests. */
export function grokAuthFile(env: AcpEnvironment = process.env): string {
  return env.GROK_AUTH_FILE?.trim() || join(grokHome(env), "auth.json");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when Grok demonstrably has nothing to sign in with. A configured
 * auth method (`authMethodEnv`) is the user's explicit choice and is trusted.
 */
export async function acpSignInMissing(
  provider: string,
  authMethodEnv: string | undefined,
  env: AcpEnvironment = process.env,
): Promise<boolean> {
  if (provider === ANTIGRAVITY_PROVIDER_ID) {
    // An explicitly configured method (an API key, say) is the user's choice.
    if (authMethodEnv && env[authMethodEnv]?.trim()) return false;
    return antigravitySignInRecentlyRefused();
  }
  if (provider !== "grok") return false;
  if (env.XAI_API_KEY?.trim() || env.GROK_AUTH_PROVIDER_COMMAND?.trim()) return false;
  if (authMethodEnv && env[authMethodEnv]?.trim()) return false;
  if (await fileExists(grokAuthFile(env))) return false;
  const config = await fs.readFile(join(grokHome(env), "config.toml"), "utf8").catch(() => "");
  return !/^\s*auth_provider_command\s*=/m.test(config);
}

export async function assertAcpSignedIn(
  provider: string,
  authMethodEnv: string | undefined,
  env: AcpEnvironment = process.env,
): Promise<void> {
  if (await acpSignInMissing(provider, authMethodEnv, env)) {
    throw new CredentialError(acpSignInRequiredMessage(provider));
  }
}

/**
 * Prompt admission for every session on this bridge, re-read on each status
 * poll: a file check, so a `grok login` in a terminal unlocks the tab on the
 * next read. Omitted otherwise, because only a missing login is confirmed.
 */
export async function acpReadiness(
  provider: string,
  authMethodEnv: string | undefined,
  env: AcpEnvironment = process.env,
): Promise<NativeAgentReadiness | undefined> {
  if (!(await acpSignInMissing(provider, authMethodEnv, env))) return undefined;
  return {
    state: "authentication-required",
    message: acpSignInRequiredMessage(provider),
    signIn: acpSignInRoute(provider),
  };
}

export function acpSignInRequiredMessage(provider: string): string {
  return provider === ANTIGRAVITY_PROVIDER_ID
    ? ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE
    : GROK_SIGN_IN_REQUIRED_MESSAGE;
}
