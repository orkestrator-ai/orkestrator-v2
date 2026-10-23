import { randomUUID } from "node:crypto";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  isSelectableOpenCodeProvider,
  normalizeOpenCodeModelProviders,
} from "@orkestrator/protocol/native-agent";
import {
  MAX_OPENCODE_API_KEY_LENGTH,
  MAX_OPENCODE_AUTH_INPUT_LENGTH,
  MAX_OPENCODE_AUTH_METHODS,
  MAX_OPENCODE_AUTH_PROMPTS,
  MAX_OPENCODE_AUTH_PROVIDER_ENTRIES,
  type OpenCodeProviderAuthEntry,
  type OpenCodeProviderAuthMethod,
  type OpenCodeProviderAuthPrompt,
  type OpenCodeProviderAuthSnapshot,
  type OpenCodeProviderLoginProgress,
} from "@orkestrator/protocol/opencode-provider-auth";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";
import { markLocalBridgesForLoginRefresh } from "./agent-accounts-active.js";
import type { CommandContext } from "./commands-context.js";
import { withHostOpenCodeServer, type HostOpenCodeServer } from "./host-model-catalog-refresh.js";
import { openCodeSdkFetch } from "./http-bridge-transport.js";

/**
 * Signs OpenCode model providers in from the app.
 *
 * Each operation starts a private OpenCode server from the bundled binary
 * (`withHostOpenCodeServer`) and calls its own auth routes, so OpenCode writes
 * the credential where it always does: the host's login store, which every
 * local environment's server shares. Nothing here reads, returns or logs a
 * credential; an API key passes straight through to `auth.set`.
 *
 * A running OpenCode server keeps the credentials it loaded for a directory
 * until that instance is disposed, so after any change every local OpenCode
 * server is flagged and replaced the next time it is used while idle
 * (`markLocalBridgesForLoginRefresh`). Containers copy the login in when they
 * start.
 */

/** OAuth device codes last about 15 minutes; give the whole sign-in a little more. */
const LOGIN_TOTAL_TIMEOUT_MS = 16 * 60_000;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_LABEL_LENGTH = 200;
const MAX_INSTRUCTIONS_LENGTH = 1_000;
const MAX_ERROR_LENGTH = 500;
const MAX_LOGIN_CODE_LENGTH = 2_048;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const PROMPT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/;

type ServerRunner = <T>(
  context: CommandContext,
  use: (server: HostOpenCodeServer) => Promise<T>,
) => Promise<T>;

export interface OpenCodeProviderLoginDependencies {
  withServer: ServerRunner;
  createClient: typeof createOpencodeClient;
  /** Flags every live local OpenCode server so it reloads credentials once idle. */
  onLoginChanged: () => void;
  loginTimeoutMs: number;
}

const defaultDependencies: OpenCodeProviderLoginDependencies = {
  withServer: (context, use) => withHostOpenCodeServer(context, use, "provider-sign-in"),
  createClient: createOpencodeClient,
  onLoginChanged: () => markLocalBridgesForLoginRefresh("opencode"),
  loginTimeoutMs: LOGIN_TOTAL_TIMEOUT_MS,
};

function bounded(value: unknown, max: number): string | undefined {
  const text = nonEmptyString(value)?.trim();
  return text ? text.slice(0, max) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * OpenCode's error body for a failed auth route, by name only. Its message can
 * echo provider responses, so only the fixed reasons are passed on.
 */
function sdkFailure(operation: string, error: unknown): Error {
  const name = nonEmptyString(asRecord(error)?.name);
  const reason =
    name === "ProviderAuthOauthCallbackFailed"
      ? "the provider did not confirm the sign-in"
      : name === "ProviderAuthOauthCodeMissing"
        ? "no sign-in code was given"
        : name === "ProviderAuthOauthMissing"
          ? "the sign-in expired or was not started"
          : name === "ProviderAuthValidationFailed"
            ? "OpenCode rejected the details entered"
            : undefined;
  return new Error(reason ? `${operation} failed: ${reason}.` : `${operation} failed.`);
}

function assertResponse(response: { error?: unknown }, operation: string): void {
  if (response.error) throw sdkFailure(operation, response.error);
}

function signInClient(
  dependencies: OpenCodeProviderLoginDependencies,
  server: HostOpenCodeServer,
): OpencodeClient {
  return dependencies.createClient({
    baseUrl: server.baseUrl,
    directory: server.directory,
    headers: server.headers,
    // OpenCode answers an OAuth callback only once the user approves, which
    // can take longer than Bun's five-minute idle default. The sign-in's own
    // deadline and cancellation abort it instead.
    fetch: openCodeSdkFetch,
  });
}

export function assertOpenCodeProviderId(value: string): string {
  const id = value.trim();
  if (!PROVIDER_ID_PATTERN.test(id)) throw new Error("Invalid OpenCode provider id");
  return id;
}

function normalizePrompt(value: unknown): OpenCodeProviderAuthPrompt[] {
  const prompt = asRecord(value);
  const key = nonEmptyString(prompt?.key);
  const message = bounded(prompt?.message, MAX_LABEL_LENGTH);
  if (!prompt || !key || !PROMPT_KEY_PATTERN.test(key) || !message) return [];
  if (prompt.type !== "text" && prompt.type !== "select") return [];
  const when = asRecord(prompt.when);
  const whenKey = nonEmptyString(when?.key);
  const whenValue = typeof when?.value === "string" ? when.value.slice(0, MAX_LABEL_LENGTH) : null;
  const op = when?.op === "eq" || when?.op === "neq" ? when.op : undefined;
  const normalizedWhen: OpenCodeProviderAuthPrompt["when"] =
    whenKey && whenValue !== null && op ? { key: whenKey, op, value: whenValue } : undefined;
  const placeholder = bounded(prompt.placeholder, MAX_LABEL_LENGTH);
  if (prompt.type === "text") {
    return [
      {
        type: "text",
        key,
        message,
        ...(placeholder ? { placeholder } : {}),
        ...(normalizedWhen ? { when: normalizedWhen } : {}),
      },
    ];
  }
  const options = (Array.isArray(prompt.options) ? prompt.options : [])
    .slice(0, 32)
    .flatMap((candidate) => {
      const option = asRecord(candidate);
      const label = bounded(option?.label, MAX_LABEL_LENGTH);
      const optionValue = typeof option?.value === "string" ? option.value.slice(0, 256) : null;
      if (!label || optionValue === null) return [];
      const hint = bounded(option?.hint, MAX_LABEL_LENGTH);
      return [{ label, value: optionValue, ...(hint ? { hint } : {}) }];
    });
  if (options.length === 0) return [];
  return [
    { type: "select", key, message, options, ...(normalizedWhen ? { when: normalizedWhen } : {}) },
  ];
}

/** OpenCode lists methods only for providers with a sign-in plugin; every other one takes an API key. */
function normalizeMethods(value: unknown): OpenCodeProviderAuthMethod[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ index: 0, type: "api", label: "API key", prompts: [] }];
  }
  return value.slice(0, MAX_OPENCODE_AUTH_METHODS).flatMap((candidate, index) => {
    const method = asRecord(candidate);
    if (method?.type !== "api" && method?.type !== "oauth") return [];
    return [
      {
        index,
        type: method.type,
        label:
          bounded(method.label, MAX_LABEL_LENGTH) ??
          (method.type === "api" ? "API key" : "Sign in"),
        prompts: (Array.isArray(method.prompts) ? method.prompts : [])
          .slice(0, MAX_OPENCODE_AUTH_PROMPTS)
          .flatMap(normalizePrompt),
      },
    ];
  });
}

/**
 * Field by field from OpenCode's provider list and auth methods. The list
 * carries each provider's stored key and options, which never leave here.
 */
export function normalizeOpenCodeProviderAuth(
  providerList: unknown,
  authMethods: unknown,
  allowedProviders: readonly string[],
): OpenCodeProviderAuthSnapshot {
  const list = asRecord(providerList);
  const methods = asRecord(authMethods) ?? {};
  const connected = new Set(
    (Array.isArray(list?.connected) ? list.connected : []).flatMap((candidate) => {
      const id = (nonEmptyString(candidate) ?? nonEmptyString(asRecord(candidate)?.id))?.trim();
      return id && PROVIDER_ID_PATTERN.test(id) ? [id] : [];
    }),
  );
  const seen = new Set<string>();
  const providers = (Array.isArray(list?.all) ? list.all : []).flatMap(
    (candidate): OpenCodeProviderAuthEntry[] => {
      const provider = asRecord(candidate);
      const id = nonEmptyString(provider?.id)?.trim();
      if (!id || !PROVIDER_ID_PATTERN.test(id) || seen.has(id)) return [];
      seen.add(id);
      const isConnected = connected.has(id);
      return [
        {
          id,
          label: bounded(provider?.name, MAX_LABEL_LENGTH) ?? id,
          connected: isConnected,
          // Configuration takes precedence over stored-login source labels.
          // The public API has no credential-presence read, so configured
          // providers also offer an explicit remove-stored-login action.
          storedLogin: isConnected && (provider?.source === "api" || provider?.source === "custom"),
          ...(provider?.source === "config" ? { canRemoveStoredLogin: true } : {}),
          allowed:
            allowedProviders.length > 0 && isSelectableOpenCodeProvider(id, allowedProviders),
          methods: normalizeMethods(methods[id]),
        },
      ];
    },
  );
  const rank = (provider: OpenCodeProviderAuthEntry) =>
    (provider.allowed ? 0 : 2) + (provider.connected ? 0 : 1);
  providers.sort(
    (a, b) =>
      rank(a) - rank(b) || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
  return { providers: providers.slice(0, MAX_OPENCODE_AUTH_PROVIDER_ENTRIES) };
}

function validateInputs(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_OPENCODE_AUTH_PROMPTS) throw new Error("Too many sign-in details");
  const inputs: Record<string, string> = {};
  for (const [key, input] of entries) {
    if (!PROMPT_KEY_PATTERN.test(key) || typeof input !== "string") {
      throw new Error("Invalid sign-in details");
    }
    if (input.length > MAX_OPENCODE_AUTH_INPUT_LENGTH)
      throw new Error("A sign-in detail is too long");
    inputs[key] = input;
  }
  return entries.length > 0 ? inputs : undefined;
}

interface LoginOperation {
  progress: OpenCodeProviderLoginProgress;
  controller: AbortController;
  submitCode?: (code: string) => void;
  cancelled?: boolean;
}

let current: LoginOperation | undefined;
let mutation: symbol | undefined;
let listFlight: Promise<OpenCodeProviderAuthSnapshot> | undefined;

function snapshotProgress(): OpenCodeProviderLoginProgress {
  return current ? { ...current.progress } : { state: "idle" };
}

export function openCodeProviderLoginProgress(): OpenCodeProviderLoginProgress {
  return snapshotProgress();
}

function reserveMutation(): () => void {
  if (mutation) {
    throw new Error(
      "Another OpenCode sign-in is in progress or a login change is finishing. Finish or cancel it first.",
    );
  }
  const reservation = Symbol();
  mutation = reservation;
  return () => {
    if (mutation === reservation) mutation = undefined;
  };
}

export function createOpenCodeProviderLogin(
  overrides: Partial<OpenCodeProviderLoginDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  async function listProviders(context: CommandContext): Promise<OpenCodeProviderAuthSnapshot> {
    // One server answers every settings pane that asks at once.
    listFlight ??= (async () => {
      const allowedProviders = normalizeOpenCodeModelProviders(
        (await context.storage.loadConfig()).global.openCodeModelProviders,
      );
      return dependencies.withServer(context, async (server) => {
        const client = signInClient(dependencies, server);
        const options = { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
        const [list, auth] = await Promise.all([
          client.provider.list({}, options),
          client.provider.auth({}, options),
        ]);
        assertResponse(list, "Reading OpenCode providers");
        assertResponse(auth, "Reading OpenCode sign-in methods");
        return normalizeOpenCodeProviderAuth(list.data, auth.data, allowedProviders);
      });
    })().finally(() => {
      listFlight = undefined;
    });
    return listFlight;
  }

  async function setApiKey(
    context: CommandContext,
    providerId: string,
    key: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const id = assertOpenCodeProviderId(providerId);
    const trimmed = key.trim();
    if (!trimmed) throw new Error("Enter an API key");
    if (trimmed.length > MAX_OPENCODE_API_KEY_LENGTH) throw new Error("The API key is too long");
    const inputs = validateInputs(metadata);
    const release = reserveMutation();
    try {
      await dependencies.withServer(context, async (server) => {
        const response = await signInClient(dependencies, server).auth.set(
          {
            providerID: id,
            auth: { type: "api", key: trimmed, ...(inputs ? { metadata: inputs } : {}) },
          },
          { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        );
        assertResponse(response, "Saving the API key");
      });
      dependencies.onLoginChanged();
    } finally {
      release();
    }
  }

  async function signOut(context: CommandContext, providerId: string): Promise<void> {
    const id = assertOpenCodeProviderId(providerId);
    const release = reserveMutation();
    try {
      await dependencies.withServer(context, async (server) => {
        const response = await signInClient(dependencies, server).auth.remove(
          { providerID: id },
          { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        );
        assertResponse(response, "Signing out");
      });
      dependencies.onLoginChanged();
    } finally {
      release();
    }
  }

  /**
   * Start an OAuth sign-in and return at once; the caller polls
   * `openCodeProviderLoginProgress` for the link, like the Claude and Codex
   * account sign-in. The private server lives until the sign-in settles.
   */
  function startOAuth(
    context: CommandContext,
    input: {
      providerId: string;
      providerLabel?: string;
      method: number;
      inputs?: Record<string, string>;
    },
  ): OpenCodeProviderLoginProgress {
    const providerId = assertOpenCodeProviderId(input.providerId);
    if (
      !Number.isInteger(input.method) ||
      input.method < 0 ||
      input.method >= MAX_OPENCODE_AUTH_METHODS
    ) {
      throw new Error("Invalid sign-in method");
    }
    const inputs = validateInputs(input.inputs);
    const release = reserveMutation();
    const controller = new AbortController();
    const operation: LoginOperation = {
      controller,
      progress: {
        state: "pending",
        operationId: randomUUID(),
        providerId,
        providerLabel: bounded(input.providerLabel, MAX_LABEL_LENGTH) ?? providerId,
      },
    };
    current = operation;
    const deadline = setTimeout(
      () => controller.abort(new Error("The sign-in timed out.")),
      dependencies.loginTimeoutMs,
    );
    deadline.unref?.();

    const finish = (update: Partial<OpenCodeProviderLoginProgress>) => {
      clearTimeout(deadline);
      release();
      if (current !== operation || operation.progress.state !== "pending") return;
      if (operation.cancelled) {
        current = undefined;
        return;
      }
      const {
        url: _url,
        userCode: _code,
        instructions: _instructions,
        ...rest
      } = operation.progress;
      operation.progress = { ...rest, ...update, completedAt: new Date().toISOString() };
      operation.submitCode = undefined;
    };

    void dependencies
      .withServer(context, async (server) => {
        const client = signInClient(dependencies, server);
        const signal = controller.signal;
        const authorized = await client.provider.oauth.authorize(
          { providerID: providerId, method: input.method, ...(inputs ? { inputs } : {}) },
          { signal },
        );
        assertResponse(authorized, "Starting the sign-in");
        const data = asRecord(authorized.data);
        const url = nonEmptyString(data?.url);
        if (!url || !/^https?:\/\//i.test(url))
          throw new Error("OpenCode returned no sign-in link.");
        const needsCode = data?.method === "code";
        const instructions = bounded(data?.instructions, MAX_INSTRUCTIONS_LENGTH);
        const userCode = instructions?.match(DEVICE_CODE_PATTERN)?.[0];
        let code: string | undefined;
        if (needsCode) {
          code = await new Promise<string>((resolve, reject) => {
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            operation.submitCode = resolve;
            operation.progress = {
              ...operation.progress,
              url,
              needsCode,
              ...(instructions ? { instructions } : {}),
            };
          });
          operation.progress = { ...operation.progress, codeSubmitted: true };
        } else {
          operation.progress = {
            ...operation.progress,
            url,
            needsCode: false,
            ...(instructions ? { instructions } : {}),
            ...(userCode ? { userCode } : {}),
          };
        }
        const completed = await client.provider.oauth.callback(
          { providerID: providerId, method: input.method, ...(code ? { code } : {}) },
          { signal },
        );
        assertResponse(completed, "Completing the sign-in");
        if (completed.data !== true) throw new Error("OpenCode did not confirm the sign-in.");
      })
      .then(
        () => {
          finish({ state: "succeeded" });
          dependencies.onLoginChanged();
        },
        (error: unknown) => {
          const reason = controller.signal.aborted ? controller.signal.reason : error;
          finish({ state: "failed", error: messageOf(reason).slice(0, MAX_ERROR_LENGTH) });
        },
      );
    return snapshotProgress();
  }

  function submitCode(code: string): OpenCodeProviderLoginProgress {
    const trimmed = code.trim();
    if (!trimmed) throw new Error("Enter the sign-in code");
    if (trimmed.length > MAX_LOGIN_CODE_LENGTH) throw new Error("The sign-in code is too long");
    if (!current?.submitCode || current.progress.state !== "pending") {
      throw new Error("No OpenCode sign-in is waiting for a code");
    }
    const submit = current.submitCode;
    current.submitCode = undefined;
    current.progress = { ...current.progress, codeSubmitted: true };
    submit(trimmed);
    return snapshotProgress();
  }

  function cancel(operationId?: string): OpenCodeProviderLoginProgress {
    if (
      current?.progress.state === "pending" &&
      (!operationId || current.progress.operationId === operationId)
    ) {
      // Keep the reservation and pending snapshot until the server stops.
      current.cancelled = true;
      current.submitCode = undefined;
      current.controller.abort(new Error("Sign-in cancelled."));
    }
    return snapshotProgress();
  }

  return { listProviders, setApiKey, signOut, startOAuth, submitCode, cancel };
}

export const openCodeProviderLogin = createOpenCodeProviderLogin();

export const __testing = {
  reset(): void {
    current?.controller.abort(new Error("reset"));
    current = undefined;
    mutation = undefined;
    listFlight = undefined;
  },
};
