/**
 * OpenCode provider sign-in from the app.
 *
 * OpenCode keeps one login per model provider (OpenCode Go, OpenAI, …) in the
 * host's own store, so there are no accounts to switch: each provider is
 * connected by an API key or an OAuth sign-in, replaced, or signed out. The
 * backend drives the bundled OpenCode server's own auth routes and never
 * returns a credential. See docs/architecture/agent-accounts.md.
 */

/** Bounds on what the settings pane is sent. */
export const MAX_OPENCODE_AUTH_PROVIDER_ENTRIES = 512;
export const MAX_OPENCODE_AUTH_METHODS = 8;
export const MAX_OPENCODE_AUTH_PROMPTS = 8;
export const MAX_OPENCODE_API_KEY_LENGTH = 4_096;
export const MAX_OPENCODE_AUTH_INPUT_LENGTH = 1_024;

/** A value OpenCode asks for before it signs a provider in, e.g. an enterprise URL. */
export interface OpenCodeProviderAuthPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string; hint?: string }>;
  /** Asked only when another prompt's answer matches. */
  when?: { key: string; op: "eq" | "neq"; value: string };
}

export interface OpenCodeProviderAuthMethod {
  /** OpenCode's index for the method; providers without plugin methods get one API-key method at 0. */
  index: number;
  type: "api" | "oauth";
  label: string;
  prompts: OpenCodeProviderAuthPrompt[];
}

export interface OpenCodeProviderAuthEntry {
  id: string;
  label: string;
  /** OpenCode can use the provider: a stored login, an environment variable or configuration. */
  connected: boolean;
  /**
   * The login is in OpenCode's own store, so it can be replaced or signed out
   * here. Configuration can obscure this indicator; see canRemoveStoredLogin.
   */
  storedLogin: boolean;
  /** Source precedence hides credential presence; allow explicit removal without claiming a stored login exists. */
  canRemoveStoredLogin?: boolean;
  /** Listed in Settings → OpenCode → Model Providers. */
  allowed: boolean;
  methods: OpenCodeProviderAuthMethod[];
}

export interface OpenCodeProviderAuthSnapshot {
  /** Allowed and connected providers first, then the rest by name. */
  providers: OpenCodeProviderAuthEntry[];
}

export type OpenCodeProviderLoginState = "idle" | "pending" | "succeeded" | "failed";

/**
 * The single in-flight OAuth sign-in, as the settings pane and recovery card
 * poll it. `auto` methods finish by themselves once the user approves in the
 * browser (or enters `userCode`); `code` methods need the code the page shows.
 */
export interface OpenCodeProviderLoginProgress {
  state: OpenCodeProviderLoginState;
  operationId?: string;
  providerId?: string;
  providerLabel?: string;
  url?: string;
  /** OpenCode's own instruction text for the step, bounded. */
  instructions?: string;
  /** A device code found in the instructions, shown with a copy button. */
  userCode?: string;
  needsCode?: boolean;
  codeSubmitted?: boolean;
  error?: string;
  completedAt?: string;
}
