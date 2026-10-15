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
      provider === "grok" ? "Open a terminal and run grok login." : "Sign in with the agent CLI.",
  };
}

function grokHome(): string {
  return process.env.GROK_HOME?.trim() || join(homedir(), ".grok");
}

/** Where Grok keeps its login. `GROK_AUTH_FILE` exists for tests. */
export function grokAuthFile(): string {
  return process.env.GROK_AUTH_FILE?.trim() || join(grokHome(), "auth.json");
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
): Promise<boolean> {
  if (provider !== "grok") return false;
  const env = process.env;
  if (env.XAI_API_KEY?.trim() || env.GROK_AUTH_PROVIDER_COMMAND?.trim()) return false;
  if (authMethodEnv && env[authMethodEnv]?.trim()) return false;
  if (await fileExists(grokAuthFile())) return false;
  const config = await fs.readFile(join(grokHome(), "config.toml"), "utf8").catch(() => "");
  return !/^\s*auth_provider_command\s*=/m.test(config);
}

export async function assertAcpSignedIn(
  provider: string,
  authMethodEnv: string | undefined,
): Promise<void> {
  if (await acpSignInMissing(provider, authMethodEnv)) {
    throw new CredentialError(GROK_SIGN_IN_REQUIRED_MESSAGE);
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
): Promise<NativeAgentReadiness | undefined> {
  if (!(await acpSignInMissing(provider, authMethodEnv))) return undefined;
  return {
    state: "authentication-required",
    message: GROK_SIGN_IN_REQUIRED_MESSAGE,
    signIn: acpSignInRoute(provider),
  };
}
