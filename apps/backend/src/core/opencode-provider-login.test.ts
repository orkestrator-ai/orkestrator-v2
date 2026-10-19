import { afterEach, describe, expect, mock, test } from "bun:test";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  AUTH_SECRET_CANARIES,
  CANARY_LOGIN_URL,
  captureOutput,
  expectNoCanary,
  expectNothingSecretLogged,
  expectOnlyLoginSecrets,
} from "../../../../tests/helpers/auth-secret-canaries.js";
import type { CommandContext } from "./commands-context.js";
import {
  __testing,
  createOpenCodeProviderLogin,
  normalizeOpenCodeProviderAuth,
  openCodeProviderLoginProgress,
  type OpenCodeProviderLoginDependencies,
} from "./opencode-provider-login.js";

const SECRET_KEY = AUTH_SECRET_CANARIES.openAiApiKey;

const context = {
  storage: {
    loadConfig: async () => ({ global: { openCodeModelProviders: ["opencode-go"] } }),
  },
} as unknown as CommandContext;

const providerList = {
  connected: ["opencode-go", "openai", "lmstudio"],
  default: {},
  all: [
    { id: "anthropic", name: "Anthropic", source: "custom", key: undefined, models: {} },
    { id: "lmstudio", name: "LM Studio", source: "config", options: { apiKey: SECRET_KEY } },
    { id: "openai", name: "OpenAI", source: "custom", models: {} },
    { id: "opencode-go", name: "OpenCode Go", source: "api", key: SECRET_KEY, models: {} },
    { id: "../escape", name: "Bad id", source: "custom" },
  ],
};

const authMethods = {
  openai: [
    { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
    { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
    { type: "api", label: "Manually enter API Key" },
  ],
  "github-copilot": [
    {
      type: "oauth",
      label: "Login with GitHub Copilot",
      prompts: [
        {
          type: "select",
          key: "deploymentType",
          message: "Select GitHub deployment type",
          options: [
            { label: "GitHub.com", value: "github.com", hint: "Public" },
            { label: "GitHub Enterprise", value: "enterprise" },
          ],
        },
        {
          type: "text",
          key: "enterpriseUrl",
          message: "Enter your GitHub Enterprise URL or domain",
          when: { key: "deploymentType", op: "eq", value: "enterprise" },
        },
      ],
    },
  ],
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}

function harness(
  options: {
    authorize?: unknown;
    callback?: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  } & Partial<OpenCodeProviderLoginDependencies> = {},
) {
  const calls: Array<{ route: string; input: unknown }> = [];
  const servers: string[] = [];
  const client = {
    provider: {
      list: async () => ({ data: providerList }),
      auth: async () => ({ data: authMethods }),
      oauth: {
        authorize: async (input: unknown) => {
          calls.push({ route: "authorize", input });
          return (
            options.authorize ?? {
              data: { url: CANARY_LOGIN_URL, method: "auto", instructions: "" },
            }
          );
        },
        callback: async (input: Record<string, unknown>, request: { signal: AbortSignal }) => {
          calls.push({ route: "callback", input });
          return options.callback ? options.callback(input, request.signal) : { data: true };
        },
      },
    },
    auth: {
      set: async (input: unknown) => {
        calls.push({ route: "set", input });
        return { data: true };
      },
      remove: async (input: unknown) => {
        calls.push({ route: "remove", input });
        return { data: true };
      },
    },
  };
  const onLoginChanged = mock(() => {});
  const login = createOpenCodeProviderLogin({
    withServer: async (_context, use) => {
      servers.push("started");
      try {
        return await use({ baseUrl: "http://127.0.0.1:1", directory: "/probe", headers: {} });
      } finally {
        servers.push("stopped");
      }
    },
    createClient: (() => client) as unknown as typeof createOpencodeClient,
    onLoginChanged,
    ...options,
  });
  return { login, calls, servers, onLoginChanged };
}

afterEach(() => {
  __testing.reset();
});

describe("normalizeOpenCodeProviderAuth", () => {
  test("lists providers field by field, never their keys or options", () => {
    const snapshot = normalizeOpenCodeProviderAuth(providerList, authMethods, ["opencode-go"]);
    expectNoCanary(snapshot, "provider snapshot");
    expect(snapshot.providers.map((provider) => provider.id)).toEqual([
      "opencode-go",
      "lmstudio",
      "openai",
      "anthropic",
    ]);
    const [go, lmstudio, openai, anthropic] = snapshot.providers;
    expect(go).toEqual({
      id: "opencode-go",
      label: "OpenCode Go",
      connected: true,
      storedLogin: true,
      allowed: true,
      methods: [{ index: 0, type: "api", label: "API key", prompts: [] }],
    });
    // Connected by configuration: nothing to sign out of here.
    expect(lmstudio).toMatchObject({ connected: true, storedLogin: false, allowed: false });
    // A plugin login lives in OpenCode's store.
    expect(openai).toMatchObject({ connected: true, storedLogin: true });
    expect(openai!.methods.map((method) => [method.index, method.type])).toEqual([
      [0, "oauth"],
      [1, "oauth"],
      [2, "api"],
    ]);
    expect(anthropic).toMatchObject({ connected: false, storedLogin: false });
  });

  test("keeps OpenCode's sign-in prompts, including conditional ones", () => {
    const snapshot = normalizeOpenCodeProviderAuth(
      { connected: [], all: [{ id: "github-copilot", name: "GitHub Copilot" }] },
      authMethods,
      [],
    );
    expect(snapshot.providers[0]!.allowed).toBe(false);
    expect(snapshot.providers[0]!.methods[0]!.prompts).toEqual([
      {
        type: "select",
        key: "deploymentType",
        message: "Select GitHub deployment type",
        options: [
          { label: "GitHub.com", value: "github.com", hint: "Public" },
          { label: "GitHub Enterprise", value: "enterprise" },
        ],
      },
      {
        type: "text",
        key: "enterpriseUrl",
        message: "Enter your GitHub Enterprise URL or domain",
        when: { key: "deploymentType", op: "eq", value: "enterprise" },
      },
    ]);
  });
});

describe("OpenCode provider login", () => {
  test("lists providers through one private server", async () => {
    const { login, servers } = harness();
    const [first, second] = await Promise.all([
      login.listProviders(context),
      login.listProviders(context),
    ]);
    expect(first).toBe(second);
    expect(servers).toEqual(["started", "stopped"]);
    expectNoCanary(first, "provider list");
  });

  test("saves an API key straight through and flags running servers", async () => {
    const { login, calls, servers, onLoginChanged } = harness();
    const { output } = await captureOutput(() =>
      login.setApiKey(context, "opencode-go", `  ${SECRET_KEY}  `, { accountId: "acct" }),
    );
    expect(calls).toEqual([
      {
        route: "set",
        input: {
          providerID: "opencode-go",
          auth: { type: "api", key: SECRET_KEY, metadata: { accountId: "acct" } },
        },
      },
    ]);
    expect(servers).toEqual(["started", "stopped"]);
    expect(onLoginChanged).toHaveBeenCalledTimes(1);
    expectNoCanary(output, "API key save output");
  });

  test("refuses bad input before starting a server", async () => {
    const { login, servers } = harness();
    await expect(login.setApiKey(context, "../escape", SECRET_KEY)).rejects.toThrow(
      "Invalid OpenCode provider id",
    );
    await expect(login.setApiKey(context, "opencode-go", "   ")).rejects.toThrow(
      "Enter an API key",
    );
    await expect(
      login.setApiKey(context, "opencode-go", SECRET_KEY, { "bad key": "x" }),
    ).rejects.toThrow("Invalid sign-in details");
    expect(() => login.startOAuth(context, { providerId: "openai", method: -1 })).toThrow(
      "Invalid sign-in method",
    );
    expect(servers).toEqual([]);
  });

  test("signs out through OpenCode's own route", async () => {
    const { login, calls, onLoginChanged } = harness();
    await login.signOut(context, "openai");
    expect(calls).toEqual([{ route: "remove", input: { providerID: "openai" } }]);
    expect(onLoginChanged).toHaveBeenCalledTimes(1);
  });

  test("runs an automatic OAuth sign-in to completion", async () => {
    const approved = deferred<unknown>();
    const { login, calls, servers, onLoginChanged } = harness({
      authorize: {
        data: { url: CANARY_LOGIN_URL, method: "auto", instructions: "Enter code: ABCD-EFGH" },
      },
      callback: () => approved.promise,
    });
    const { output } = await captureOutput(async () => {
      const started = login.startOAuth(context, {
        providerId: "openai",
        providerLabel: "OpenAI",
        method: 1,
      });
      expect(started).toMatchObject({ state: "pending", providerId: "openai" });
      await until(() => openCodeProviderLoginProgress().url !== undefined);
      const waiting = openCodeProviderLoginProgress();
      expect(waiting).toMatchObject({
        state: "pending",
        providerLabel: "OpenAI",
        url: CANARY_LOGIN_URL,
        userCode: "ABCD-EFGH",
        instructions: "Enter code: ABCD-EFGH",
        needsCode: false,
      });
      expectOnlyLoginSecrets(waiting, "pending progress");
      expect(() => login.startOAuth(context, { providerId: "openai", method: 0 })).toThrow(
        "Another OpenCode sign-in is in progress",
      );
      await expect(login.setApiKey(context, "openai", SECRET_KEY)).rejects.toThrow(
        "Another OpenCode sign-in is in progress",
      );
      approved.resolve({ data: true });
      await until(() => openCodeProviderLoginProgress().state === "succeeded");
    });
    const done = openCodeProviderLoginProgress();
    expect(done.url).toBeUndefined();
    expect(done.userCode).toBeUndefined();
    expect(done.completedAt).toBeDefined();
    expect(calls.map((call) => call.route)).toEqual(["authorize", "callback"]);
    expect(calls[1]!.input).toEqual({ providerID: "openai", method: 1 });
    expect(servers).toEqual(["started", "stopped"]);
    expect(onLoginChanged).toHaveBeenCalledTimes(1);
    expectNothingSecretLogged(output, "OAuth sign-in");
  });

  test("sends the pasted code for a code sign-in", async () => {
    const { login, calls } = harness({
      authorize: { data: { url: CANARY_LOGIN_URL, method: "code", instructions: "Paste it" } },
    });
    login.startOAuth(context, { providerId: "poe", method: 0, inputs: { region: "eu" } });
    await until(() => openCodeProviderLoginProgress().needsCode === true);
    expect(() => login.submitCode("   ")).toThrow("Enter the sign-in code");
    login.submitCode(` ${AUTH_SECRET_CANARIES.oauthCode} `);
    await until(() => openCodeProviderLoginProgress().state === "succeeded");
    expect(calls).toEqual([
      { route: "authorize", input: { providerID: "poe", method: 0, inputs: { region: "eu" } } },
      {
        route: "callback",
        input: { providerID: "poe", method: 0, code: AUTH_SECRET_CANARIES.oauthCode },
      },
    ]);
    expectNoCanary(openCodeProviderLoginProgress(), "finished progress");
  });

  test("cancelling returns to idle and stops the server", async () => {
    const { login, servers, onLoginChanged } = harness({
      callback: (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    });
    const { operationId } = login.startOAuth(context, { providerId: "openai", method: 0 });
    await until(() => openCodeProviderLoginProgress().url !== undefined);
    expect(login.cancel("another-operation").state).toBe("pending");
    expect(login.cancel(operationId)).toEqual({ state: "idle" });
    await until(() => servers.length === 2);
    expect(openCodeProviderLoginProgress()).toEqual({ state: "idle" });
    expect(onLoginChanged).not.toHaveBeenCalled();
  });

  test("reports a refused sign-in by OpenCode's error name only", async () => {
    const { login, onLoginChanged } = harness({
      callback: async () => ({
        error: {
          name: "ProviderAuthOauthCallbackFailed",
          data: { message: `refused ${AUTH_SECRET_CANARIES.accessToken}` },
        },
      }),
    });
    const { output } = await captureOutput(async () => {
      login.startOAuth(context, { providerId: "openai", method: 0 });
      await until(() => openCodeProviderLoginProgress().state === "failed");
    });
    expect(openCodeProviderLoginProgress().error).toBe(
      "Completing the sign-in failed: the provider did not confirm the sign-in.",
    );
    expectNoCanary(openCodeProviderLoginProgress(), "failed progress");
    expectNothingSecretLogged(output, "failed sign-in");
    expect(onLoginChanged).not.toHaveBeenCalled();
  });

  test("gives up once the sign-in deadline passes", async () => {
    const { login } = harness({
      loginTimeoutMs: 20,
      callback: (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    });
    login.startOAuth(context, { providerId: "openai", method: 0 });
    await until(() => openCodeProviderLoginProgress().state === "failed");
    expect(openCodeProviderLoginProgress().error).toBe("The sign-in timed out.");
  });

  test("refuses a sign-in link that is not a web address", async () => {
    const { login } = harness({
      authorize: { data: { url: "javascript:alert(1)", method: "auto", instructions: "" } },
    });
    login.startOAuth(context, { providerId: "openai", method: 0 });
    await until(() => openCodeProviderLoginProgress().state === "failed");
    expect(openCodeProviderLoginProgress().error).toBe("OpenCode returned no sign-in link.");
  });
});
