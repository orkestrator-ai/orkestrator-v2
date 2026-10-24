/**
 * Each platform's sign-in state as the settings pane shows it: read on the
 * host, without a session or a bridge.
 *
 * A tab reads `NativeAgentAuthStatus` from its own bridge, which only exists
 * while an environment runs that platform. Settings has neither, so this reads
 * the same evidence the launchers hand to bridges:
 *
 * - Claude and Codex: the active account's login (`listAgentAccounts`), the
 *   one every new agent, container and terminal uses. Claude also recognizes
 *   environment credentials for the host account only.
 * - Cursor: the credential the bridge would resolve (`cursorSdkAuthStatus`).
 * - Grok: the checks its bridge makes before `authenticate`: a stored login,
 *   `XAI_API_KEY` or an auth-provider command (`acp-credentials.ts`).
 * - Pi and OpenCode: the provider entries in their credential stores. Neither
 *   can be confirmed signed out from here, because a provider's environment
 *   variable or configuration may also hold a key, so an empty store reads
 *   `unknown` rather than `signed-out`.
 *
 * Like every auth answer it is built field by field: the stores are parsed
 * for provider ids and credential types only, and no value, token or key is
 * read into the answer (see agent-accounts.md, "Credentials in auth answers").
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  DEFAULT_AGENT_ACCOUNT_ID,
  type AgentAccountsSnapshot,
} from "@orkestrator/protocol/agent-accounts";
import type {
  NativeAgentAuthState,
  NativeAgentAuthStatus,
  NativeAgentSignInRoute,
} from "@orkestrator/protocol/native-agent";
import { redactBridgeOutput } from "./bridge-output-redaction.js";
import type { CursorSdkAuthStatus } from "./cursor-sdk-bridge.js";

type ProviderEntry = NonNullable<NativeAgentAuthStatus["providers"]>[number];

/** Far larger than any real credential store; a bigger file is not parsed. */
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_PROVIDERS = 64;
/**
 * Provider ids are short lowercase slugs (`anthropic`, `github-copilot`). A key
 * is only ever a value, but a store edited by hand could hold one as a key, so
 * anything longer, or shaped like a credential, is dropped rather than shown.
 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function isProviderId(id: string): boolean {
  return PROVIDER_ID.test(id) && redactBridgeOutput(id) === id;
}

/** Where each platform signs in from Settings; the renderer owns the actions. */
export const SETTINGS_SIGN_IN_ROUTES: Readonly<Record<AgentPlatform, NativeAgentSignInRoute>> = {
  claude: { kind: "terminal", hint: "Sign the active Claude account in again from this card." },
  codex: {
    kind: "device-code",
    hint: "Sign in from a Codex tab, or add an account below and make it active.",
  },
  cursor: { kind: "browser-url" },
  grok: { kind: "terminal", hint: "Open a terminal and run grok login." },
  opencode: { kind: "terminal", hint: "Sign each model provider in under Provider Sign-in." },
  pi: { kind: "terminal", hint: "Open a Pi terminal tab and run /login." },
};

export interface AgentSignInStatusDependencies {
  listAccounts: () => Promise<AgentAccountsSnapshot>;
  cursorStatus: () => Promise<CursorSdkAuthStatus>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  readText?: (filePath: string) => Promise<string | undefined>;
}

async function readBoundedText(filePath: string): Promise<string | undefined> {
  const text = await readFile(filePath, "utf8").catch(() => undefined);
  return text !== undefined && text.length <= MAX_STORE_BYTES ? text : undefined;
}

function envPath(value: string | undefined, home: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed === "~" || trimmed.startsWith("~/")
    ? path.join(home, trimmed.slice(1))
    : path.resolve(trimmed);
}

/**
 * Provider ids and credential kinds from a `{ "<provider>": { "type": … } }`
 * store (Pi's and OpenCode's `auth.json`). Values are never copied.
 */
export function providersFromCredentialStore(text: string | undefined): ProviderEntry[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([id, entry]) => isProviderId(id) && entry && typeof entry === "object")
    .slice(0, MAX_PROVIDERS)
    .map(([id, entry]) => {
      const type = (entry as { type?: unknown }).type;
      const method =
        type === "oauth" ? "oauth" : type === "api" || type === "api_key" ? "api-key" : undefined;
      return { id, label: id, state: "signed-in" as const, ...(method ? { method } : {}) };
    });
}

function accountStatus(
  snapshot: AgentAccountsSnapshot,
  platform: "claude" | "codex",
  env: NodeJS.ProcessEnv,
): NativeAgentAuthStatus {
  const active = snapshot.accounts.find(
    (account) => account.platform === platform && account.id === snapshot.active[platform],
  );
  const environmentSource =
    platform === "claude" && active?.id === DEFAULT_AGENT_ACCOUNT_ID
      ? env.ANTHROPIC_API_KEY?.trim()
        ? "API key from the environment"
        : env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
          ? "OAuth token from the environment"
          : undefined
      : undefined;
  const state: NativeAgentAuthState = !active
    ? "unknown"
    : active.signedIn || environmentSource
      ? "signed-in"
      : "signed-out";
  const plan = environmentSource ? undefined : active?.identity.plan;
  return {
    state,
    ...(active
      ? { account: { label: environmentSource ?? active.label, ...(plan ? { plan } : {}) } }
      : {}),
    signIn: SETTINGS_SIGN_IN_ROUTES[platform],
    signOut: false,
  };
}

async function grokSignedIn(
  env: NodeJS.ProcessEnv,
  home: string,
  readText: (filePath: string) => Promise<string | undefined>,
): Promise<boolean> {
  if (
    env.XAI_API_KEY?.trim() ||
    env.GROK_AUTH_PROVIDER_COMMAND?.trim() ||
    env.GROK_AUTH_METHOD_ID?.trim()
  )
    return true;
  const grokHome = envPath(env.GROK_HOME, home) ?? path.join(home, ".grok");
  if ((await readText(path.join(grokHome, "auth.json"))) !== undefined) return true;
  const config = (await readText(path.join(grokHome, "config.toml"))) ?? "";
  return /^\s*auth_provider_command\s*=/m.test(config);
}

function providerStoreStatus(
  platform: "pi" | "opencode",
  providers: ProviderEntry[],
): NativeAgentAuthStatus {
  return {
    state: providers.length > 0 ? "signed-in" : "unknown",
    ...(providers.length > 0 ? { providers } : {}),
    signIn: SETTINGS_SIGN_IN_ROUTES[platform],
    signOut: false,
  };
}

export async function readAgentSignInStatus(
  platform: AgentPlatform,
  deps: AgentSignInStatusDependencies,
): Promise<NativeAgentAuthStatus> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const readText = deps.readText ?? readBoundedText;
  switch (platform) {
    case "claude":
    case "codex":
      return accountStatus(await deps.listAccounts(), platform, env);
    case "cursor": {
      const cursor = await deps.cursorStatus();
      const label =
        cursor.email ??
        (cursor.source === "api-key-config"
          ? "Saved API key"
          : cursor.source === "api-key-env" || cursor.source === "host-snapshot"
            ? "API key from the environment"
            : undefined);
      return {
        state: cursor.authenticated ? "signed-in" : "signed-out",
        ...(cursor.authenticated && label
          ? { account: { label, ...(cursor.expiresAt ? { expiresAt: cursor.expiresAt } : {}) } }
          : {}),
        signIn: SETTINGS_SIGN_IN_ROUTES.cursor,
        signOut: cursor.source === "stored-login",
      };
    }
    case "grok":
      return {
        state: (await grokSignedIn(env, home, readText)) ? "signed-in" : "signed-out",
        signIn: SETTINGS_SIGN_IN_ROUTES.grok,
        signOut: false,
      };
    case "pi": {
      // Host launches leave PI_AGENT_DIR unset, so Pi's own default applies.
      const agentDir = envPath(env.PI_CODING_AGENT_DIR, home) ?? path.join(home, ".pi", "agent");
      return providerStoreStatus(
        "pi",
        providersFromCredentialStore(await readText(path.join(agentDir, "auth.json"))),
      );
    }
    case "opencode": {
      // The bundled OpenCode 1.x store every local environment shares.
      const dataHome = envPath(env.XDG_DATA_HOME, home) ?? path.join(home, ".local", "share");
      return providerStoreStatus(
        "opencode",
        providersFromCredentialStore(await readText(path.join(dataHome, "opencode", "auth.json"))),
      );
    }
  }
}
