import { randomUUID } from "node:crypto";
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
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { pushedLoginHostFile } from "./agent-accounts-containers.js";
import type { CommandContext } from "./commands-context.js";
import type { OpenCodeLoginOperation } from "./opencode-provider-login-slot.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./opencode2/client.js";
import {
  exportOpenCode2Logins,
  openCode2RefreshLineageFile,
  keepActiveOpenCode2Credential,
  removeOpenCode2Credentials,
} from "./opencode2/credentials.js";
import {
  withOpenCode2HostDatabaseServer,
  type WithOpenCode2HostDatabaseServer,
} from "./opencode2-host-database-server.js";

const log = createLogger("native-agent.opencode");

/**
 * Signs OpenCode model providers in from the app, through the OpenCode 2.x
 * server's own integration routes (`/api/integration/:id/connect/*`).
 *
 * Each operation runs against a 2.x server on the host 2.x database
 * (`withOpenCode2HostDatabaseServer`): a running host server for the short
 * requests, a private one for an OAuth sign-in, whose attempt and callback
 * listener live in the server that started it. 2.x writes the credential to
 * that database, which every host 2.x server shares and reads per use, so
 * nothing has to be restarted. Containers are handed the host's logins from
 * OpenCode's `auth.json`, so after each change the provider's entry there is
 * brought in step with the database (`exportOpenCode2Logins`); see
 * `opencode2/credentials.ts`.
 *
 * Nothing here returns or logs a credential; an API key passes straight
 * through to the connect route.
 */

/** OAuth device codes last about 15 minutes; give the whole sign-in a little more. */
const LOGIN_TOTAL_TIMEOUT_MS = 16 * 60_000;
const REQUEST_TIMEOUT_MS = 45_000;
const ATTEMPT_POLL_INTERVAL_MS = 1_000;
/** The integration list names every provider 2.x knows, with its sign-in forms. */
const MAX_INTEGRATION_LIST_BYTES = 4 * 1024 * 1024;
/** Provider rows carry their settings, API keys included. */
const MAX_PROVIDER_LIST_BYTES = 2 * 1024 * 1024;
const MAX_LABEL_LENGTH = 200;
const MAX_INSTRUCTIONS_LENGTH = 1_000;
const MAX_ERROR_LENGTH = 500;
const MAX_LOGIN_CODE_LENGTH = 2_048;
const MAX_SELECT_OPTIONS = 32;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const PROMPT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/;

export interface OpenCodeProviderLoginDependencies {
  withServer: WithOpenCode2HostDatabaseServer;
  /** The `auth.json` containers are handed; undefined when this profile has none. */
  loginExportFile: (context: CommandContext) => string | undefined;
  exportLogins: typeof exportOpenCode2Logins;
  loginTimeoutMs: number;
  pollIntervalMs: number;
}

const defaultDependencies: OpenCodeProviderLoginDependencies = {
  withServer: withOpenCode2HostDatabaseServer,
  loginExportFile: (context) => pushedLoginHostFile(context, "opencode"),
  exportLogins: exportOpenCode2Logins,
  loginTimeoutMs: LOGIN_TOTAL_TIMEOUT_MS,
  pollIntervalMs: ATTEMPT_POLL_INTERVAL_MS,
};

/** Shown when the host took the change and the copy containers are handed could not be written. */
export const OPENCODE_LOGIN_EXPORT_FAILED_MESSAGE =
  "Saved for OpenCode on this machine, but the copy containers use could not be updated. Try again.";

function bounded(value: unknown, max: number): string | undefined {
  const text = nonEmptyString(value)?.trim();
  return text ? text.slice(0, max) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function route(providerId: string, suffix = ""): string {
  return `/api/integration/${encodeURIComponent(providerId)}${suffix}`;
}

/**
 * A refused or failed 2.x call, by the server's error tag only. Its message
 * can echo provider responses, so only the fixed reasons are passed on.
 */
function failure(operation: string, error: unknown): Error {
  if (error instanceof OpenCode2RequestError) {
    const reason =
      error.tag === "IntegrationNotFoundError"
        ? "OpenCode offers no sign-in for this provider"
        : error.tag === "IntegrationAttemptNotFoundError"
          ? "the sign-in expired or was not started"
          : error.tag === "InvalidRequestError"
            ? "OpenCode rejected the details entered"
            : undefined;
    return new Error(reason ? `${operation} failed: ${reason}.` : `${operation} failed.`);
  }
  if (error instanceof ProviderUnavailableError) {
    return new Error(`${operation} failed: OpenCode did not answer.`);
  }
  return error instanceof Error ? error : new Error(`${operation} failed.`);
}

async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw failure(operation, error);
  }
}

export function assertOpenCodeProviderId(value: string): string {
  const id = value.trim();
  if (!PROVIDER_ID_PATTERN.test(id)) throw new Error("Invalid OpenCode provider id");
  return id;
}

/** A 2.x `Form.When` the pane can evaluate: a string compared for (in)equality. */
function normalizeWhen(value: unknown): OpenCodeProviderAuthPrompt["when"] {
  for (const candidate of Array.isArray(value) ? value : []) {
    const when = asRecord(candidate);
    const key = nonEmptyString(when?.key);
    if (!key || !PROMPT_KEY_PATTERN.test(key) || typeof when?.value !== "string") continue;
    if (when.op !== "eq" && when.op !== "neq") continue;
    return { key, op: when.op, value: when.value.slice(0, MAX_LABEL_LENGTH) };
  }
  return undefined;
}

/**
 * One 2.x form field as a prompt. Only required, visible string fields are
 * asked: the pane requires an answer to every prompt it shows, and 2.x fills
 * an optional or hidden field from its own default.
 */
function normalizeField(value: unknown): OpenCodeProviderAuthPrompt[] {
  const field = asRecord(value);
  const key = nonEmptyString(field?.key);
  if (!field || !key || !PROMPT_KEY_PATTERN.test(key)) return [];
  if (field.type !== "string" || field.hidden === true || field.required !== true) return [];
  const message = bounded(field.title, MAX_LABEL_LENGTH) ?? key;
  const when = normalizeWhen(field.when);
  const placeholder = bounded(field.placeholder, MAX_LABEL_LENGTH);
  const options = (Array.isArray(field.options) ? field.options : [])
    .slice(0, MAX_SELECT_OPTIONS)
    .flatMap((candidate) => {
      const option = asRecord(candidate);
      const label = bounded(option?.label, MAX_LABEL_LENGTH);
      const optionValue = typeof option?.value === "string" ? option.value.slice(0, 256) : null;
      if (!label || optionValue === null) return [];
      const hint = bounded(option?.description, MAX_LABEL_LENGTH);
      return [{ label, value: optionValue, ...(hint ? { hint } : {}) }];
    });
  // A field that also takes a custom value is typed, not picked.
  if (options.length > 0 && field.custom !== true) {
    return [{ type: "select", key, message, options, ...(when ? { when } : {}) }];
  }
  return [
    {
      type: "text",
      key,
      message,
      ...(placeholder ? { placeholder } : {}),
      ...(when ? { when } : {}),
    },
  ];
}

/**
 * A 2.x integration's key and OAuth methods, indexed by their position in
 * its method list (which the start route maps back). Environment, command
 * and external methods have no sign-in to drive from here.
 */
function normalizeMethods(value: unknown): OpenCodeProviderAuthMethod[] {
  return (Array.isArray(value) ? value : [])
    .slice(0, MAX_OPENCODE_AUTH_METHODS)
    .flatMap((candidate, index): OpenCodeProviderAuthMethod[] => {
      const method = asRecord(candidate);
      if (method?.type !== "key" && method?.type !== "oauth") return [];
      if (method.type === "oauth" && !nonEmptyString(method.id)) return [];
      const prompts = (Array.isArray(method.form) ? method.form : [])
        .flatMap(normalizeField)
        .slice(0, MAX_OPENCODE_AUTH_PROMPTS);
      return [
        {
          index,
          type: method.type === "key" ? "api" : "oauth",
          label:
            bounded(method.label, MAX_LABEL_LENGTH) ??
            (method.type === "key" ? "API key" : "Sign in"),
          prompts,
        },
      ];
    });
}

/** A connection 2.x reports as usable; one that needs signing in again is not. */
function usableConnection(value: unknown): boolean {
  const status = asRecord(asRecord(value)?.status);
  return status?.status !== "needs_auth";
}

/**
 * Field by field from 2.x's integration list (`GET /api/integration`) and
 * enabled providers (`GET /api/provider`). Provider rows carry their settings,
 * API keys included, so only id, name and activation are read from them.
 */
export function normalizeOpenCodeProviderAuth(
  integrations: unknown,
  providers: unknown,
  allowedProviders: readonly string[],
): OpenCodeProviderAuthSnapshot {
  const enabled = new Map<string, string | undefined>();
  for (const candidate of Array.isArray(providers) ? providers : []) {
    const provider = asRecord(candidate);
    const id = nonEmptyString(provider?.id)?.trim();
    if (!id || !PROVIDER_ID_PATTERN.test(id) || provider?.activation === "disabled") continue;
    enabled.set(id, bounded(provider?.name, MAX_LABEL_LENGTH));
  }
  const allowed = (id: string) =>
    allowedProviders.length > 0 && isSelectableOpenCodeProvider(id, allowedProviders);
  const seen = new Set<string>();
  const entries = (Array.isArray(integrations) ? integrations : []).flatMap(
    (candidate): OpenCodeProviderAuthEntry[] => {
      const integration = asRecord(candidate);
      const id = nonEmptyString(integration?.id)?.trim();
      if (!id || !PROVIDER_ID_PATTERN.test(id) || seen.has(id)) return [];
      seen.add(id);
      const connections = Array.isArray(integration?.connections) ? integration.connections : [];
      return [
        {
          id,
          label: bounded(integration?.name, MAX_LABEL_LENGTH) ?? id,
          connected: connections.some(usableConnection) || enabled.has(id),
          // 2.x reports each stored credential as a connection, so presence is exact.
          storedLogin: connections.some(
            (connection) => asRecord(connection)?.type === "credential",
          ),
          allowed: allowed(id),
          methods: normalizeMethods(integration?.methods),
        },
      ];
    },
  );
  // A provider of the user's own configuration is enabled without an integration.
  for (const [id, label] of enabled) {
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      label: label ?? id,
      connected: true,
      storedLogin: false,
      allowed: allowed(id),
      methods: [],
    });
  }
  const rank = (provider: OpenCodeProviderAuthEntry) =>
    (provider.allowed ? 0 : 2) + (provider.connected ? 0 : 1);
  entries.sort(
    (a, b) =>
      rank(a) - rank(b) || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
  return { providers: entries.slice(0, MAX_OPENCODE_AUTH_PROVIDER_ENTRIES) };
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

/** Abortable sleep; rejects with the signal's reason. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function openCodeProviderLoginProgress(
  context: CommandContext,
): OpenCodeProviderLoginProgress {
  return context.runtime.localServers.openCodeProviderLogin.progress();
}

export function createOpenCodeProviderLogin(
  overrides: Partial<OpenCodeProviderLoginDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  /** Bring the hand-off file in step with the store for `providerId`. */
  async function exportOrExplain(
    context: CommandContext,
    client: OpenCode2Client,
    providerId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const file = dependencies.loginExportFile(context);
    if (!file) return;
    try {
      await dependencies.exportLogins(client, file, [providerId], signal, {
        lineageFile: openCode2RefreshLineageFile(context.storage.getDataDir()),
      });
    } catch (error) {
      log.warn("login.export-failed", { error: formatLogError(error, { message: false }) });
      throw new Error(OPENCODE_LOGIN_EXPORT_FAILED_MESSAGE);
    }
  }

  async function listProviders(context: CommandContext): Promise<OpenCodeProviderAuthSnapshot> {
    return context.runtime.localServers.openCodeProviderLogin.listProviders(async () => {
      const allowedProviders = normalizeOpenCodeModelProviders(
        (await context.storage.loadConfig()).global.openCodeModelProviders,
      );
      return dependencies.withServer(context, async (client) => {
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const [integrations, providers] = await Promise.all([
          call("Reading OpenCode sign-in methods", () =>
            client.api<unknown>("GET", "/api/integration", "OpenCode integration list", {
              maxBytes: MAX_INTEGRATION_LIST_BYTES,
              signal,
            }),
          ),
          call("Reading OpenCode providers", () =>
            client.api<unknown>("GET", "/api/provider", "OpenCode provider list", {
              maxBytes: MAX_PROVIDER_LIST_BYTES,
              signal,
            }),
          ),
        ]);
        return normalizeOpenCodeProviderAuth(integrations, providers, allowedProviders);
      });
    });
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
    const release = context.runtime.localServers.openCodeProviderLogin.reserveMutation();
    try {
      await dependencies.withServer(context, async (client) => {
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        await call("Saving the API key", async () => {
          await client.api("POST", route(id, "/connect/key"), "OpenCode key connect", {
            body: { key: trimmed, ...(inputs ? { answer: inputs } : {}) },
            signal,
          });
          // The connect adds a credential beside any earlier one; keep only it.
          await keepActiveOpenCode2Credential(client, id, signal);
        });
        await exportOrExplain(context, client, id, signal);
      });
    } finally {
      release();
    }
  }

  async function signOut(context: CommandContext, providerId: string): Promise<void> {
    const id = assertOpenCodeProviderId(providerId);
    const release = context.runtime.localServers.openCodeProviderLogin.reserveMutation();
    try {
      await dependencies.withServer(context, async (client) => {
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        await call("Signing out", () => removeOpenCode2Credentials(client, id, signal));
        await exportOrExplain(context, client, id, signal);
      });
    } finally {
      release();
    }
  }

  /** The OAuth method id at `index` of the integration's method list. */
  async function oauthMethodId(
    client: OpenCode2Client,
    providerId: string,
    index: number,
    signal: AbortSignal,
  ): Promise<string> {
    const integration = asRecord(
      await call("Starting the sign-in", () =>
        client.api<unknown>("GET", route(providerId), "OpenCode integration read", {
          maxBytes: MAX_INTEGRATION_LIST_BYTES,
          signal,
        }),
      ),
    );
    const method = asRecord(
      (Array.isArray(integration?.methods) ? integration.methods : [])[index],
    );
    const id = nonEmptyString(method?.id);
    if (method?.type !== "oauth" || !id) throw new Error("Invalid sign-in method");
    return id;
  }

  /** Poll an attempt until 2.x has stored its credential; failed and expired throw. */
  async function settleAttempt(
    client: OpenCode2Client,
    providerId: string,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      const status = asRecord(
        await call("Completing the sign-in", () =>
          client.api<unknown>(
            "GET",
            route(providerId, `/connect/oauth/${encodeURIComponent(attemptId)}`),
            "OpenCode sign-in status",
            { signal },
          ),
        ),
      );
      if (status?.status === "complete") return;
      if (status?.status === "failed") {
        throw new Error("Completing the sign-in failed: the provider did not confirm the sign-in.");
      }
      if (status?.status === "expired") {
        throw new Error("Completing the sign-in failed: the sign-in expired.");
      }
      if (status?.status !== "pending") throw new Error("OpenCode reported no sign-in state.");
      await pause(dependencies.pollIntervalMs, signal);
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
    const slot = context.runtime.localServers.openCodeProviderLogin;
    const release = slot.reserveMutation();
    const controller = new AbortController();
    const operation: OpenCodeLoginOperation = {
      controller,
      progress: {
        state: "pending",
        operationId: randomUUID(),
        providerId,
        providerLabel: bounded(input.providerLabel, MAX_LABEL_LENGTH) ?? providerId,
      },
    };
    slot.begin(operation);
    const deadline = setTimeout(
      () => controller.abort(new Error("The sign-in timed out.")),
      dependencies.loginTimeoutMs,
    );
    deadline.unref?.();

    const finish = (update: Partial<OpenCodeProviderLoginProgress>) => {
      clearTimeout(deadline);
      release();
      if (!slot.isCurrent(operation) || operation.progress.state !== "pending") return;
      if (operation.cancelled) {
        slot.clear();
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
      .withServer(
        context,
        async (client) => {
          const signal = controller.signal;
          const methodID = await oauthMethodId(client, providerId, input.method, signal);
          const attempt = asRecord(
            await call("Starting the sign-in", () =>
              client.api<unknown>(
                "POST",
                route(providerId, "/connect/oauth"),
                "OpenCode sign-in start",
                { body: { methodID, ...(inputs ? { answer: inputs } : {}) }, signal },
              ),
            ),
          );
          const attemptId = nonEmptyString(attempt?.attemptID);
          const url = nonEmptyString(attempt?.url);
          if (!attemptId) throw new Error("OpenCode did not start the sign-in.");
          try {
            if (!url || !/^https?:\/\//i.test(url)) {
              throw new Error("OpenCode returned no sign-in link.");
            }
            const needsCode = attempt?.mode === "code";
            const instructions = bounded(attempt?.instructions, MAX_INSTRUCTIONS_LENGTH);
            const userCode = instructions?.match(DEVICE_CODE_PATTERN)?.[0];
            if (needsCode) {
              const code = await new Promise<string>((resolve, reject) => {
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
              await call("Completing the sign-in", () =>
                client.api(
                  "POST",
                  route(providerId, `/connect/oauth/${encodeURIComponent(attemptId)}/complete`),
                  "OpenCode sign-in complete",
                  { body: { code }, signal },
                ),
              );
            } else {
              operation.progress = {
                ...operation.progress,
                url,
                needsCode: false,
                ...(instructions ? { instructions } : {}),
                ...(userCode ? { userCode } : {}),
              };
            }
            await settleAttempt(client, providerId, attemptId, signal);
          } catch (error) {
            // Stop the attempt (and its callback listener) before the server goes.
            await client
              .api(
                "DELETE",
                route(providerId, `/connect/oauth/${encodeURIComponent(attemptId)}`),
                "OpenCode sign-in cancel",
                { signal: AbortSignal.timeout(5_000) },
              )
              .catch(() => undefined);
            throw error;
          }
          // 2.x holds the login now; what follows keeps it to one and hands it on.
          await call("Completing the sign-in", () =>
            keepActiveOpenCode2Credential(
              client,
              providerId,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ),
          );
          await exportOrExplain(
            context,
            client,
            providerId,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          );
        },
        { private: true },
      )
      .then(
        () => finish({ state: "succeeded" }),
        (error: unknown) => {
          const reason = controller.signal.aborted ? controller.signal.reason : error;
          finish({ state: "failed", error: messageOf(reason).slice(0, MAX_ERROR_LENGTH) });
        },
      );
    return slot.progress();
  }

  function submitCode(context: CommandContext, code: string): OpenCodeProviderLoginProgress {
    const trimmed = code.trim();
    if (!trimmed) throw new Error("Enter the sign-in code");
    if (trimmed.length > MAX_LOGIN_CODE_LENGTH) throw new Error("The sign-in code is too long");
    return context.runtime.localServers.openCodeProviderLogin.submitCode(trimmed);
  }

  function cancel(context: CommandContext, operationId?: string): OpenCodeProviderLoginProgress {
    return context.runtime.localServers.openCodeProviderLogin.cancel(operationId);
  }

  return { listProviders, setApiKey, signOut, startOAuth, submitCode, cancel };
}

/** The production dependencies; its state lives on the context's runtime. */
export const openCodeProviderLogin = createOpenCodeProviderLogin();
