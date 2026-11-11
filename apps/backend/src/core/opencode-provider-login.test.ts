import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
  createOpenCodeProviderLogin,
  normalizeOpenCodeProviderAuth,
  OPENCODE_LOGIN_EXPORT_FAILED_MESSAGE,
  openCodeProviderLoginProgress,
  type OpenCodeProviderLoginDependencies,
} from "./opencode-provider-login.js";
import { OpenCodeProviderLoginSlot } from "./opencode-provider-login-slot.js";
import { FakeOpenCode2Server } from "./opencode2/fake-server.test-support.js";

const SECRET_KEY = AUTH_SECRET_CANARIES.openAiApiKey;
const EXPORT_FILE = "/export/opencode/auth.json";

let slot = new OpenCodeProviderLoginSlot();
const context = {
  runtime: {
    localServers: {
      get openCodeProviderLogin() {
        return slot;
      },
    },
  },
  storage: {
    loadConfig: async () => ({ global: { openCodeModelProviders: ["opencode-go"] } }),
  },
} as unknown as CommandContext;

/** `GET /api/integration` rows as 2.2.6 answers them, without connections. */
const integrations = [
  {
    id: "anthropic",
    name: "Anthropic",
    methods: [{ type: "key" }, { type: "env", names: ["ANTHROPIC_API_KEY"] }],
  },
  {
    id: "azure",
    name: "Azure",
    methods: [
      {
        type: "key",
        label: "API key",
        form: [
          {
            key: "resourceName",
            title: "Enter Azure Resource Name",
            required: true,
            type: "string",
            placeholder: "e.g. my-models",
          },
        ],
      },
      { type: "env", names: ["AZURE_API_KEY"] },
    ],
  },
  {
    id: "claude-agent",
    name: "Claude Agent",
    methods: [{ id: "claude-login", type: "external", label: "Claude Code login" }],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    methods: [
      { type: "env", names: ["GITHUB_TOKEN"] },
      {
        id: "device",
        type: "oauth",
        label: "Login with GitHub Copilot",
        form: [
          {
            key: "deploymentType",
            title: "Select GitHub deployment type",
            required: true,
            type: "string",
            options: [
              { value: "github.com", label: "GitHub.com", description: "Public" },
              { value: "enterprise", label: "GitHub Enterprise" },
            ],
          },
          {
            key: "enterpriseUrl",
            title: "Enter your GitHub Enterprise URL or domain",
            required: true,
            when: [{ key: "deploymentType", op: "eq", value: "enterprise" }],
            type: "string",
            placeholder: "company.ghe.com",
          },
        ],
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    methods: [
      { type: "key" },
      { type: "env", names: ["OPENAI_API_KEY"] },
      { type: "oauth", id: "chatgpt-token-sharing", label: "Sign in with ChatGPT" },
      { type: "oauth", id: "chatgpt-browser", label: "Codex browser (legacy)" },
      { type: "oauth", id: "chatgpt-headless", label: "Codex device code (legacy)" },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode Console",
    methods: [
      {
        type: "oauth",
        id: "device",
        label: "OpenCode Console account",
        form: [{ key: "server", hidden: true, type: "string", default: "https://opencode.ai" }],
      },
    ],
  },
  { id: "opencode-go", name: "OpenCode Go", methods: [{ type: "key" }] },
  {
    id: "snowflake-cortex",
    name: "Snowflake Cortex",
    methods: [
      {
        id: "browser",
        type: "oauth",
        label: "Login with Snowflake",
        form: [
          { key: "account", title: "Snowflake account", required: true, type: "string" },
          { key: "role", title: "Snowflake role (optional)", type: "string" },
        ],
      },
    ],
  },
  { id: "../escape", name: "Bad id", methods: [{ type: "key" }] },
];

/** `GET /api/provider`: settings carry keys. */
const providers = [
  { id: "lmstudio", name: "LM Studio", activation: "enabled", settings: { apiKey: SECRET_KEY } },
  { id: "opencode-go", name: "OpenCode Go", activation: "auto", settings: { apiKey: SECRET_KEY } },
  { id: "off", name: "Off", activation: "disabled" },
];

const oauthValue = {
  type: "oauth",
  methodID: "chatgpt-browser",
  refresh: AUTH_SECRET_CANARIES.refreshToken,
  access: AUTH_SECRET_CANARIES.accessToken,
  expires: 1_900_000_000_000,
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
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}

let fake: FakeOpenCode2Server;

beforeEach(() => {
  fake = new FakeOpenCode2Server();
  fake.integrations = structuredClone(integrations);
  fake.providers = structuredClone(providers);
  fake.credentials.push({
    id: "cred_go",
    integrationID: "opencode-go",
    label: "OpenCode Go",
    active: true,
    value: { type: "key", key: SECRET_KEY },
  });
  fake.nextAttempt = {
    url: CANARY_LOGIN_URL,
    instructions: "Enter code: ABCD-EFGH",
    mode: "auto",
  };
});

afterEach(() => {
  slot.cancel();
  slot = new OpenCodeProviderLoginSlot();
  fake.stop();
});

function harness(overrides: Partial<OpenCodeProviderLoginDependencies> = {}) {
  const servers: string[] = [];
  const exportLogins = mock(
    async (_client: unknown, _file: string, _providerIds: readonly string[]) => undefined,
  );
  const login = createOpenCodeProviderLogin({
    withServer: async (_context, use, options) => {
      servers.push(options?.private ? "private" : "shared");
      try {
        return await use(fake.client());
      } finally {
        servers.push("stopped");
      }
    },
    loginExportFile: () => EXPORT_FILE,
    exportLogins,
    pollIntervalMs: 5,
    ...overrides,
  });
  return { login, servers, exportLogins };
}

const routes = () =>
  fake.calls
    .filter((call) => call.path.startsWith("/api/integration") || call.path.startsWith("/api/cred"))
    .map((call) => `${call.method} ${call.path}`);

describe("normalizeOpenCodeProviderAuth", () => {
  const connected = (integrationID: string, status?: unknown) => ({
    type: "credential",
    id: `cred_${integrationID}`,
    label: integrationID,
    method: "key",
    ...(status ? { status } : {}),
  });

  test("lists providers field by field, never their keys or settings", () => {
    const rows = integrations.map((row) =>
      row.id === "opencode-go"
        ? { ...row, connections: [connected("opencode-go")] }
        : row.id === "openai"
          ? {
              ...row,
              connections: [connected("openai", { status: "needs_auth", message: "expired" })],
            }
          : row.id === "anthropic"
            ? { ...row, connections: [{ type: "env", name: "ANTHROPIC_API_KEY" }] }
            : row,
    );
    const snapshot = normalizeOpenCodeProviderAuth(rows, providers, ["opencode-go"]);
    expectNoCanary(snapshot, "provider snapshot");
    expect(snapshot.providers.map((provider) => provider.id)).toEqual([
      "opencode-go",
      "anthropic",
      "lmstudio",
      "azure",
      "claude-agent",
      "github-copilot",
      "openai",
      "opencode",
      "snowflake-cortex",
    ]);
    const byId = new Map(snapshot.providers.map((provider) => [provider.id, provider]));
    expect(byId.get("opencode-go")).toEqual({
      id: "opencode-go",
      label: "OpenCode Go",
      connected: true,
      storedLogin: true,
      allowed: true,
      methods: [{ index: 0, type: "api", label: "API key", prompts: [] }],
    });
    // Connected by the environment: nothing stored to sign out of.
    expect(byId.get("anthropic")).toMatchObject({ connected: true, storedLogin: false });
    // The user's own configuration: enabled with no integration, so no sign-in.
    expect(byId.get("lmstudio")).toEqual({
      id: "lmstudio",
      label: "LM Studio",
      connected: true,
      storedLogin: false,
      allowed: false,
      methods: [],
    });
    // A stored login 2.x says needs signing in again is stored, not connected.
    expect(byId.get("openai")).toMatchObject({ connected: false, storedLogin: true });
    expect(byId.get("openai")!.methods.map((method) => [method.index, method.type])).toEqual([
      [0, "api"],
      [2, "oauth"],
      [3, "oauth"],
      [4, "oauth"],
    ]);
    // External methods are not driven from here.
    expect(byId.get("claude-agent")!.methods).toEqual([]);
    expect(snapshot.providers.some((provider) => provider.canRemoveStoredLogin)).toBe(false);
  });

  test("asks only the required, visible form fields, including conditional ones", () => {
    const snapshot = normalizeOpenCodeProviderAuth(integrations, [], []);
    const byId = new Map(snapshot.providers.map((provider) => [provider.id, provider]));
    expect(byId.get("github-copilot")!.allowed).toBe(false);
    expect(byId.get("github-copilot")!.methods).toEqual([
      {
        index: 1,
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
            placeholder: "company.ghe.com",
            when: { key: "deploymentType", op: "eq", value: "enterprise" },
          },
        ],
      },
    ]);
    expect(byId.get("azure")!.methods[0]!.prompts).toEqual([
      {
        type: "text",
        key: "resourceName",
        message: "Enter Azure Resource Name",
        placeholder: "e.g. my-models",
      },
    ]);
    // Hidden and optional fields take 2.x's own defaults.
    expect(byId.get("opencode")!.methods[0]!.prompts).toEqual([]);
    expect(byId.get("snowflake-cortex")!.methods[0]!.prompts.map((prompt) => prompt.key)).toEqual([
      "account",
    ]);
  });
});

describe("OpenCode provider login", () => {
  test("lists providers through one server", async () => {
    const { login, servers } = harness();
    const [first, second] = await Promise.all([
      login.listProviders(context),
      login.listProviders(context),
    ]);
    expect(first).toBe(second);
    expect(servers).toEqual(["shared", "stopped"]);
    expect(first.providers[0]).toMatchObject({ id: "opencode-go", storedLogin: true });
    expectNoCanary(first, "provider list");
  });

  test("saves an API key through the connect route and keeps it the provider's only one", async () => {
    const { login, servers, exportLogins } = harness();
    fake.credentials.push({
      id: "cred_azure_old",
      integrationID: "azure",
      label: "Azure",
      active: true,
      value: { type: "key", key: "old" },
    });
    const { output } = await captureOutput(() =>
      login.setApiKey(context, "azure", `  ${SECRET_KEY}  `, { resourceName: "res" }),
    );
    expect(fake.calls.find((call) => call.path.endsWith("/connect/key"))?.body).toEqual({
      key: SECRET_KEY,
      answer: { resourceName: "res" },
    });
    const azure = fake.credentials.filter((credential) => credential.integrationID === "azure");
    expect(azure).toHaveLength(1);
    expect(azure[0]).toMatchObject({
      active: true,
      value: { type: "key", key: SECRET_KEY, metadata: { resourceName: "res" } },
    });
    expect(servers).toEqual(["shared", "stopped"]);
    expect(exportLogins.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [EXPORT_FILE, ["azure"]],
    ]);
    expectNoCanary(output, "API key save output");
  });

  test("a refused key reports OpenCode's reason by tag only and hands nothing on", async () => {
    const { login, exportLogins } = harness();
    await expect(login.setApiKey(context, "azure", SECRET_KEY)).rejects.toThrow(
      "Saving the API key failed: OpenCode rejected the details entered.",
    );
    await expect(login.setApiKey(context, "nonexistent", SECRET_KEY)).rejects.toThrow(
      "Saving the API key failed: OpenCode offers no sign-in for this provider.",
    );
    expect(exportLogins).not.toHaveBeenCalled();
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

  test("signs out by removing every credential of the provider, then hands that on", async () => {
    const { login, exportLogins } = harness();
    fake.credentials.push({
      id: "cred_go_2",
      integrationID: "opencode-go",
      label: "OpenCode Go 2",
      active: false,
      value: { type: "key", key: "older" },
    });
    await login.signOut(context, "opencode-go");
    expect(fake.credentials).toEqual([]);
    expect(routes()).toEqual([
      "GET /api/credential",
      "DELETE /api/credential/cred_go",
      "DELETE /api/credential/cred_go_2",
    ]);
    expect(exportLogins.mock.calls.map((call) => call[2])).toEqual([["opencode-go"]]);
  });

  test("a failed hand-off is reported after the host saved the change, and can be retried", async () => {
    const { login } = harness({
      exportLogins: async () => {
        throw new Error(`could not write ${SECRET_KEY}`);
      },
    });
    const { output } = await captureOutput(async () => {
      await expect(login.setApiKey(context, "opencode-go", SECRET_KEY)).rejects.toThrow(
        OPENCODE_LOGIN_EXPORT_FAILED_MESSAGE,
      );
    });
    expect(fake.credentials).toMatchObject([{ integrationID: "opencode-go", active: true }]);
    expectNoCanary(output, "hand-off failure output");
    // The reservation is released, so a retry can repeat it.
    await expect(login.signOut(context, "opencode-go")).rejects.toThrow(
      OPENCODE_LOGIN_EXPORT_FAILED_MESSAGE,
    );
  });

  test("a profile without a hand-off file saves the change only", async () => {
    const { login, exportLogins } = harness({ loginExportFile: () => undefined });
    await login.setApiKey(context, "anthropic", SECRET_KEY);
    expect(exportLogins).not.toHaveBeenCalled();
  });

  test.each(["save", "remove", "oauth"] as const)(
    "a pending save excludes %s across login instances through server shutdown",
    async (other) => {
      const stop = deferred<void>();
      const first = harness({
        withServer: async (_context, use) => {
          try {
            return await use(fake.client());
          } finally {
            await stop.promise;
          }
        },
      });
      const second = harness();
      const saving = first.login.setApiKey(context, "opencode-go", "new");
      const attempt = async () => {
        if (other === "save") await second.login.setApiKey(context, "anthropic", "second");
        else if (other === "remove") await second.login.signOut(context, "opencode-go");
        else second.login.startOAuth(context, { providerId: "openai", method: 3 });
      };
      await expect(attempt()).rejects.toThrow("Another OpenCode sign-in");
      await until(() => first.exportLogins.mock.calls.length === 1);
      await expect(attempt()).rejects.toThrow("Another OpenCode sign-in");
      expect(second.servers).toEqual([]);
      stop.resolve();
      await saving;
      await attempt();
      expect(second.servers.length).toBeGreaterThan(0);
    },
  );

  test("removal reserves the slot, including failed server shutdown", async () => {
    const stop = deferred<void>();
    const { login } = harness({
      withServer: async () => {
        await stop.promise;
        throw new Error("server failed");
      },
    });
    const removal = login.signOut(context, "openai").catch((error: unknown) => error);
    await expect(harness().login.setApiKey(context, "openai", "new")).rejects.toThrow(
      "Another OpenCode sign-in",
    );
    stop.resolve();
    expect(await removal).toMatchObject({ message: "server failed" });
    await harness().login.setApiKey(context, "openai", "new");
  });

  test("runs an automatic OAuth sign-in on a private server to completion", async () => {
    const { login, servers, exportLogins } = harness();
    const { output } = await captureOutput(async () => {
      const started = login.startOAuth(context, {
        providerId: "openai",
        providerLabel: "OpenAI",
        method: 3,
      });
      expect(started).toMatchObject({ state: "pending", providerId: "openai" });
      await until(() => openCodeProviderLoginProgress(context).url !== undefined);
      const waiting = openCodeProviderLoginProgress(context);
      expect(waiting).toMatchObject({
        state: "pending",
        providerLabel: "OpenAI",
        url: CANARY_LOGIN_URL,
        userCode: "ABCD-EFGH",
        instructions: "Enter code: ABCD-EFGH",
        needsCode: false,
      });
      expectOnlyLoginSecrets(waiting, "pending progress");
      expect(() => login.startOAuth(context, { providerId: "openai", method: 2 })).toThrow(
        "Another OpenCode sign-in is in progress",
      );
      await expect(login.setApiKey(context, "openai", SECRET_KEY)).rejects.toThrow(
        "Another OpenCode sign-in is in progress",
      );
      const [attempt] = [...fake.attempts.values()];
      expect(attempt).toMatchObject({ integrationID: "openai", methodID: "chatgpt-browser" });
      // The provider approved: 2.x stores the login and reports the attempt complete.
      fake.completeAttempt(attempt!.id, oauthValue);
      await until(() => openCodeProviderLoginProgress(context).state === "succeeded");
    });
    const done = openCodeProviderLoginProgress(context);
    expect(done.url).toBeUndefined();
    expect(done.userCode).toBeUndefined();
    expect(done.completedAt).toBeDefined();
    expect(servers).toEqual(["private", "stopped"]);
    expect(fake.credentials.filter((credential) => credential.integrationID === "openai")).toEqual([
      expect.objectContaining({ active: true, value: oauthValue }),
    ]);
    expect(exportLogins.mock.calls.map((call) => call[2])).toEqual([["openai"]]);
    expectNothingSecretLogged(output, "OAuth sign-in");
  });

  test("sends the pasted code and the method's answers for a code sign-in", async () => {
    fake.nextAttempt = { url: CANARY_LOGIN_URL, instructions: "Paste it", mode: "code" };
    const { login } = harness();
    login.startOAuth(context, {
      providerId: "github-copilot",
      method: 1,
      inputs: { deploymentType: "github.com" },
    });
    await until(() => openCodeProviderLoginProgress(context).needsCode === true);
    const [attempt] = [...fake.attempts.values()];
    expect(attempt).toMatchObject({
      methodID: "device",
      answer: { deploymentType: "github.com" },
    });
    expect(() => login.submitCode(context, "   ")).toThrow("Enter the sign-in code");
    expect(login.submitCode(context, ` ${AUTH_SECRET_CANARIES.oauthCode} `).codeSubmitted).toBe(
      true,
    );
    await until(() => attempt!.code === AUTH_SECRET_CANARIES.oauthCode);
    fake.completeAttempt(attempt!.id, { ...oauthValue, methodID: "device" });
    await until(() => openCodeProviderLoginProgress(context).state === "succeeded");
    expectNoCanary(openCodeProviderLoginProgress(context), "finished progress");
  });

  test("cancelling stops the attempt, returns to idle and holds admission until the server stopped", async () => {
    const stop = deferred<void>();
    const { login, exportLogins } = harness({
      withServer: async (_context, use) => {
        try {
          return await use(fake.client());
        } finally {
          await stop.promise;
        }
      },
    });
    const { operationId } = login.startOAuth(context, { providerId: "openai", method: 3 });
    await until(() => openCodeProviderLoginProgress(context).url !== undefined);
    expect(fake.attempts.size).toBe(1);
    expect(login.cancel(context, "another-operation").state).toBe("pending");
    expect(login.cancel(context, operationId).state).toBe("pending");
    await until(() => fake.attempts.size === 0);
    await expect(login.signOut(context, "openai")).rejects.toThrow("Another OpenCode sign-in");
    stop.resolve();
    await until(() => openCodeProviderLoginProgress(context).state === "idle");
    expect(exportLogins).not.toHaveBeenCalled();
    await harness().login.signOut(context, "openai");
  });

  test("reports a failed sign-in with a fixed reason, never the provider's words", async () => {
    const { login, exportLogins } = harness();
    const { output } = await captureOutput(async () => {
      login.startOAuth(context, { providerId: "openai", method: 3 });
      await until(() => fake.attempts.size === 1);
      const [attempt] = [...fake.attempts.values()];
      attempt!.status = "failed";
      await until(() => openCodeProviderLoginProgress(context).state === "failed");
    });
    expect(openCodeProviderLoginProgress(context).error).toBe(
      "Completing the sign-in failed: the provider did not confirm the sign-in.",
    );
    expectNothingSecretLogged(output, "failed sign-in");
    expect(exportLogins).not.toHaveBeenCalled();
  });

  test("an expired attempt fails the sign-in", async () => {
    const { login } = harness();
    login.startOAuth(context, { providerId: "openai", method: 3 });
    await until(() => fake.attempts.size === 1);
    [...fake.attempts.values()][0]!.status = "expired";
    await until(() => openCodeProviderLoginProgress(context).state === "failed");
    expect(openCodeProviderLoginProgress(context).error).toBe(
      "Completing the sign-in failed: the sign-in expired.",
    );
  });

  test("gives up once the sign-in deadline passes, and stops the attempt", async () => {
    const { login } = harness({ loginTimeoutMs: 40 });
    login.startOAuth(context, { providerId: "openai", method: 3 });
    await until(() => openCodeProviderLoginProgress(context).state === "failed");
    expect(openCodeProviderLoginProgress(context).error).toBe("The sign-in timed out.");
    expect(fake.attempts.size).toBe(0);
  });

  test("refuses a sign-in link that is not a web address", async () => {
    fake.nextAttempt = { url: "javascript:alert(1)", instructions: "", mode: "auto" };
    const { login } = harness();
    login.startOAuth(context, { providerId: "openai", method: 3 });
    await until(() => openCodeProviderLoginProgress(context).state === "failed");
    expect(openCodeProviderLoginProgress(context).error).toBe("OpenCode returned no sign-in link.");
    expect(fake.attempts.size).toBe(0);
  });

  test("a method that is not an OAuth one is refused", async () => {
    const { login } = harness();
    login.startOAuth(context, { providerId: "openai", method: 0 });
    await until(() => openCodeProviderLoginProgress(context).state === "failed");
    expect(openCodeProviderLoginProgress(context).error).toBe("Invalid sign-in method");
    expect(fake.attempts.size).toBe(0);
  });
});
