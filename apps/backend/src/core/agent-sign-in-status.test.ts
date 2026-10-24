import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { AgentAccountsSnapshot } from "@orkestrator/protocol/agent-accounts";
import {
  AUTH_SECRET_CANARIES,
  expectAuthStatusShape,
  expectNoCanary,
} from "../../../../tests/helpers/auth-secret-canaries.js";
import {
  providersFromCredentialStore,
  readAgentSignInStatus,
  SETTINGS_SIGN_IN_ROUTES,
  type AgentSignInStatusDependencies,
} from "./agent-sign-in-status.js";
import type { CursorSdkAuthStatus } from "./cursor-sdk-bridge.js";

const HOME = "/home/tester";

function accounts(
  signedIn: { claude: boolean; codex: boolean },
  activeCodex = "default",
): AgentAccountsSnapshot {
  return {
    active: { claude: "default", codex: activeCodex },
    accounts: [
      {
        id: "default",
        platform: "claude",
        label: "Host login",
        isDefault: true,
        isActive: true,
        signedIn: signedIn.claude,
        identity: { email: "dev@example.test", plan: "max" },
      },
      {
        id: "default",
        platform: "codex",
        label: "Host login",
        isDefault: true,
        isActive: activeCodex === "default",
        signedIn: true,
        identity: {},
      },
      {
        id: "added",
        platform: "codex",
        label: "work@example.test",
        isDefault: false,
        isActive: activeCodex === "added",
        signedIn: signedIn.codex,
        identity: { plan: "pro" },
      },
    ],
  };
}

function deps(
  overrides: Partial<AgentSignInStatusDependencies> & { files?: Record<string, string> } = {},
): AgentSignInStatusDependencies {
  const files = overrides.files ?? {};
  return {
    listAccounts: async () => accounts({ claude: true, codex: true }),
    cursorStatus: async (): Promise<CursorSdkAuthStatus> => ({
      authenticated: false,
      source: "none",
    }),
    env: {},
    home: HOME,
    readText: async (filePath) => files[filePath],
    ...overrides,
  };
}

/** A credential store shaped like Pi's and OpenCode's, every value a planted secret. */
const STORE = JSON.stringify({
  anthropic: {
    type: "oauth",
    access: AUTH_SECRET_CANARIES.accessToken,
    refresh: AUTH_SECRET_CANARIES.refreshToken,
  },
  openai: { type: "api", key: AUTH_SECRET_CANARIES.openAiApiKey },
  "../escape": { type: "api", key: AUTH_SECRET_CANARIES.anthropicApiKey },
  [AUTH_SECRET_CANARIES.xaiApiKey]: { type: "api" },
  notAnEntry: AUTH_SECRET_CANARIES.claudeOAuthToken,
});

describe("settings sign-in status, read without a session", () => {
  test.each([
    [true, "signed-in"],
    [false, "signed-out"],
  ] as const)("Claude reports the active account's login (%p)", async (signedIn, state) => {
    const status = await readAgentSignInStatus(
      "claude",
      deps({ listAccounts: async () => accounts({ claude: signedIn, codex: true }) }),
    );
    expectAuthStatusShape(status);
    expect(status).toEqual({
      state,
      account: { label: "Host login", plan: "max" },
      signIn: SETTINGS_SIGN_IN_ROUTES.claude,
      signOut: false,
    });
  });

  test("Codex follows the active account, not the host login", async () => {
    const status = await readAgentSignInStatus(
      "codex",
      deps({ listAccounts: async () => accounts({ claude: true, codex: false }, "added") }),
    );
    expect(status).toMatchObject({
      state: "signed-out",
      account: { label: "work@example.test", plan: "pro" },
    });
  });

  test.each([
    [{ authenticated: false, source: "none" }, "signed-out", undefined, false],
    [
      { authenticated: true, source: "stored-login", email: "c@example.test" },
      "signed-in",
      "c@example.test",
      true,
    ],
    [
      { authenticated: true, source: "api-key-env" },
      "signed-in",
      "API key from the environment",
      false,
    ],
  ] as const)(
    "Cursor reads the credential its bridge resolves %#",
    async (cursor, state, label, signOut) => {
      const status = await readAgentSignInStatus(
        "cursor",
        deps({ cursorStatus: async () => ({ ...cursor }) as CursorSdkAuthStatus }),
      );
      expectAuthStatusShape(status);
      expect(status.state).toBe(state);
      expect(status.account?.label).toBe(label);
      expect(status.signOut).toBe(signOut);
    },
  );

  test.each([
    [{}, {}, "signed-out"],
    [{ XAI_API_KEY: AUTH_SECRET_CANARIES.xaiApiKey }, {}, "signed-in"],
    [{}, { [path.join(HOME, ".grok", "auth.json")]: "{}" }, "signed-in"],
    [{ GROK_HOME: "/elsewhere" }, { "/elsewhere/auth.json": "{}" }, "signed-in"],
    [
      {},
      { [path.join(HOME, ".grok", "config.toml")]: 'auth_provider_command = "x"\n' },
      "signed-in",
    ],
  ] as const)("Grok matches its bridge's login checks %#", async (env, files, state) => {
    const status = await readAgentSignInStatus(
      "grok",
      deps({ env: { ...env }, files: { ...files } }),
    );
    expectAuthStatusShape(status);
    expectNoCanary(status, "Grok settings sign-in status");
    expect(status.state).toBe(state);
  });

  test.each([
    ["pi", path.join(HOME, ".pi", "agent", "auth.json"), {}],
    ["pi", "/custom/pi/auth.json", { PI_CODING_AGENT_DIR: "/custom/pi" }],
    ["opencode", path.join(HOME, ".local", "share", "opencode", "auth.json"), {}],
    ["opencode", "/xdg/opencode/auth.json", { XDG_DATA_HOME: "/xdg" }],
  ] as const)(
    "%s lists stored provider logins without their values (%s)",
    async (platform, file, env) => {
      const status = await readAgentSignInStatus(
        platform,
        deps({ env: { ...env }, files: { [file]: STORE } }),
      );
      expectAuthStatusShape(status);
      expectNoCanary(status, `${platform} settings sign-in status`);
      expect(status).toEqual({
        state: "signed-in",
        providers: [
          { id: "anthropic", label: "anthropic", state: "signed-in", method: "oauth" },
          { id: "openai", label: "openai", state: "signed-in", method: "api-key" },
        ],
        signIn: SETTINGS_SIGN_IN_ROUTES[platform],
        signOut: false,
      });
    },
  );

  test.each(["pi", "opencode"] as const)(
    "%s with no stored login is unconfirmed, never signed out",
    async (platform) => {
      // An environment variable or configuration may still hold a key.
      const status = await readAgentSignInStatus(platform, deps());
      expect(status.state).toBe("unknown");
      expect(status.providers).toBeUndefined();
    },
  );

  test("ignores unreadable and malformed credential stores", () => {
    expect(providersFromCredentialStore(undefined)).toEqual([]);
    expect(providersFromCredentialStore("not json")).toEqual([]);
    expect(providersFromCredentialStore("[1,2]")).toEqual([]);
    expect(providersFromCredentialStore("null")).toEqual([]);
  });
});
