import { describe, expect, mock, spyOn, test } from "bun:test";

import {
  createSession,
  nextQueryCall,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  CLAUDE_SIGN_IN_REQUIRED_MESSAGE,
  claudeReadiness,
  normalizeClaudeAccount,
  noteClaudeAuthenticationFailure,
  noteClaudeAuthenticationWorked,
  readClaudeAuthStatus,
} from "./claude-sign-in.js";
import { getSession } from "./session-manager-core.js";
import { CLAUDE_LOGIN_REFUSED_MESSAGE } from "./session-auth-notice.js";
import {
  AUTH_SECRET_CANARIES,
  captureOutput,
  expectAuthStatusShape,
  expectNoCanary,
  expectNothingSecretLogged,
} from "../../../../tests/helpers/auth-secret-canaries.js";

// What `accountInfo()` answers with an empty config directory (Claude 0.3.309).
const SIGNED_OUT = { tokenSource: "none", apiProvider: "firstParty" } as const;
const NOT_LOGGED_IN = "Not logged in · Please run /login";

const LOCKED = {
  state: "authentication-required",
  message: CLAUDE_SIGN_IN_REQUIRED_MESSAGE,
  signIn: {
    kind: "terminal",
    hint: "Sign in to Claude from the sign-in card in this tab or from Settings → Claude.",
  },
};

/** Run one turn that Claude refuses for want of a login, then answer its account probe. */
async function refuseTurnForMissingLogin(sessionId?: string): Promise<string> {
  const session = sessionId ? { id: sessionId } : createSession("Signed out");
  if (!sessionId) track(session.id);
  const turn = sendPrompt(session.id, "hello");
  const call = await nextQueryCall();
  call.push({
    type: "assistant",
    uuid: "not-logged-in",
    error: "authentication_failed",
    message: {
      id: "not-logged-in-message",
      role: "assistant",
      content: [{ type: "text", text: NOT_LOGGED_IN }],
    },
  });
  call.push({ type: "result", subtype: "success", is_error: true, result: NOT_LOGGED_IN });
  call.finish();
  await expect(turn).rejects.toThrow();
  const probe = await nextQueryCall();
  // Control only: no prompt string, so no user message and no turn.
  expect(typeof probe.prompt).not.toBe("string");
  await waitFor(() => probe.isClosed());
  return session.id;
}

describe("Claude account normalization", () => {
  test("reads Claude's literal 'none' source as no login", () => {
    expect(normalizeClaudeAccount(SIGNED_OUT)).toEqual({
      state: "needs-auth",
      signIn: LOCKED.signIn,
      signOut: false,
    });
  });

  test.each([
    [{ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }, undefined],
    [
      { tokenSource: "claude.ai", subscriptionType: "max" },
      { label: "max", plan: "max" },
    ],
    [{ tokenSource: "none", apiProvider: "bedrock" }, { label: "bedrock" }],
  ] as const)("counts %o as signed in", (account, expected) => {
    const status = normalizeClaudeAccount(account);
    expect(status.state).toBe("signed-in");
    expect(status.account).toEqual(expected);
  });
});

describe("Claude prompt admission", () => {
  test("a refused warm signed-in CLI probes the current account and locks the composer", async () => {
    const initializationResult = mock(async () => ({
      account: { tokenSource: "claude.ai", subscriptionType: "max" },
    }));
    const accountInfo = mock(async () => SIGNED_OUT);
    queryControlOverrides.initializationResult = initializationResult;
    queryControlOverrides.accountInfo = accountInfo;
    const session = createSession("warm revoked login");
    track(session.id);
    const turn = sendPrompt(session.id, "hello", { includeLocalSettings: true });
    const call = await nextQueryCall();
    expect((await readClaudeAuthStatus()).state).toBe("signed-in");
    expect(initializationResult).toHaveBeenCalledTimes(1);
    expect(accountInfo).not.toHaveBeenCalled();

    call.push({
      type: "assistant",
      uuid: "warm-auth-failure",
      error: "authentication_failed",
      message: {
        id: "warm-auth-failure-message",
        role: "assistant",
        content: [{ type: "text", text: NOT_LOGGED_IN }],
      },
    });
    const probe = await nextQueryCall();
    await waitFor(() => probe.isClosed());

    expect(session.claudeRuntime?.state).toBe("open");
    expect(call.isClosed()).toBe(false);
    expect(accountInfo).toHaveBeenCalledTimes(1);
    expect(initializationResult).toHaveBeenCalledTimes(1);
    expect((await readClaudeAuthStatus()).state).toBe("needs-auth");
    expect(claudeReadiness()).toEqual(LOCKED);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now + 31_000);
    try {
      expect((await readClaudeAuthStatus()).state).toBe("needs-auth");
      expect(accountInfo).toHaveBeenCalledTimes(2);
      expect(initializationResult).toHaveBeenCalledTimes(1);
      expect((await nextQueryCall()).isClosed()).toBe(true);
    } finally {
      clock.mockRestore();
    }
    call.push({ type: "result", subtype: "success", is_error: true, result: NOT_LOGGED_IN });
    await expect(turn).rejects.toThrow();
  });

  test("a failure during a live account read falls through to the authoritative probe", async () => {
    let resolveAccount!: (value: unknown) => void;
    queryControlOverrides.initializationResult = mock(
      () =>
        new Promise((resolve) => {
          resolveAccount = resolve;
        }),
    );
    const accountInfo = mock(async () => SIGNED_OUT);
    queryControlOverrides.accountInfo = accountInfo;
    const session = createSession("auth failure during initialization read");
    track(session.id);
    const turn = sendPrompt(session.id, "hello", { includeLocalSettings: true });
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success" });
    await turn;
    const pending = readClaudeAuthStatus();
    noteClaudeAuthenticationFailure();
    resolveAccount({ account: { tokenSource: "claude.ai" } });

    expect((await pending).state).toBe("needs-auth");
    expect(accountInfo).toHaveBeenCalledTimes(1);
    expect(claudeReadiness()).toEqual(LOCKED);
    expect((await nextQueryCall()).isClosed()).toBe(true);
  });

  test("stays unknown until an account read has found no login", () => {
    expect(claudeReadiness()).toBeUndefined();
  });

  test("a refused turn re-reads the account and locks every session", async () => {
    queryControlOverrides.accountInfo = mock(async () => SIGNED_OUT);

    await refuseTurnForMissingLogin();

    await waitFor(() => claudeReadiness() !== undefined);
    expect(claudeReadiness()).toEqual(LOCKED);
    expect((await readClaudeAuthStatus()).state).toBe("needs-auth");
  });

  test("a refused turn with a credential present reads as expired without locking", async () => {
    // An expired login still has a source; the probe cannot tell it from a good one.
    queryControlOverrides.accountInfo = mock(async () => ({ tokenSource: "claude.ai" }));

    await refuseTurnForMissingLogin();

    expect((await readClaudeAuthStatus()).state).toBe("expired");
    expect(claudeReadiness()).toBeUndefined();
    // A model answering again proves the login works.
    noteClaudeAuthenticationWorked();
    expect((await readClaudeAuthStatus()).state).toBe("signed-in");
  });

  test("a failed account read never locks", async () => {
    queryControlOverrides.accountInfo = mock(async () => {
      throw new Error("probe failed");
    });

    noteClaudeAuthenticationFailure();
    const probe = await nextQueryCall();
    await waitFor(() => probe.isClosed());

    expect((await readClaudeAuthStatus()).state).toBe("unknown");
    expect(claudeReadiness()).toBeUndefined();
  });

  test("successful model evidence fences an unresolved signed-out probe", async () => {
    let resolveAccount!: (value: typeof SIGNED_OUT) => void;
    queryControlOverrides.accountInfo = mock(
      () =>
        new Promise((resolve) => {
          resolveAccount = resolve;
        }),
    );
    noteClaudeAuthenticationFailure();
    const probe = await nextQueryCall();
    const pending = readClaudeAuthStatus();
    noteClaudeAuthenticationWorked();
    expect(claudeReadiness()).toBeUndefined();
    resolveAccount(SIGNED_OUT);
    await pending;
    await waitFor(() => probe.isClosed());
    expect(claudeReadiness()).toBeUndefined();
  });

  test("concurrent auth failures and route reads share one active account probe", async () => {
    let resolveAccount!: (value: typeof SIGNED_OUT) => void;
    const accountInfo = mock(
      () =>
        new Promise<typeof SIGNED_OUT>((resolve) => {
          resolveAccount = resolve;
        }),
    );
    queryControlOverrides.accountInfo = accountInfo;
    noteClaudeAuthenticationFailure();
    const probe = await nextQueryCall();
    const pending = readClaudeAuthStatus();
    for (let i = 0; i < 10; i += 1) noteClaudeAuthenticationFailure();
    expect(readClaudeAuthStatus()).toBe(pending);
    expect(accountInfo).toHaveBeenCalledTimes(1);
    resolveAccount(SIGNED_OUT);
    await pending;
    await waitFor(() => probe.isClosed());
    expect(claudeReadiness()).toEqual(LOCKED);
    expect(accountInfo).toHaveBeenCalledTimes(1);
  });

  test("a failure after success queues one fresh probe after the obsolete probe closes", async () => {
    let resolveAccount!: (value: typeof SIGNED_OUT) => void;
    const accountInfo = mock(
      () =>
        new Promise<typeof SIGNED_OUT>((resolve) => {
          resolveAccount = resolve;
        }),
    );
    queryControlOverrides.accountInfo = accountInfo;
    noteClaudeAuthenticationFailure();
    const oldProbe = await nextQueryCall();
    const pending = readClaudeAuthStatus();
    noteClaudeAuthenticationWorked();
    for (let i = 0; i < 10; i += 1) noteClaudeAuthenticationFailure();
    expect(accountInfo).toHaveBeenCalledTimes(1);
    resolveAccount(SIGNED_OUT);
    await pending;
    const freshProbe = await nextQueryCall();
    expect(oldProbe.isClosed()).toBe(true);
    expect(accountInfo).toHaveBeenCalledTimes(2);
    expect(claudeReadiness()).toBeUndefined();
    const freshRead = readClaudeAuthStatus();
    resolveAccount(SIGNED_OUT);
    await freshRead;
    expect(freshProbe.isClosed()).toBe(true);
    expect(claudeReadiness()).toEqual(LOCKED);
  });

  test("a model answer clears a cached missing login", async () => {
    queryControlOverrides.accountInfo = mock(async () => SIGNED_OUT);
    await refuseTurnForMissingLogin();
    await waitFor(() => claudeReadiness() !== undefined);

    const session = createSession("Answered");
    track(session.id);
    const turn = sendPrompt(session.id, "hello");
    const call = await nextQueryCall();
    call.push({
      type: "assistant",
      uuid: "answer",
      message: { id: "answer-message", role: "assistant", content: [{ type: "text", text: "Hi" }] },
    });
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await turn;

    expect(claudeReadiness()).toBeUndefined();
  });

  test("a login refused mid-turn raises the session's auth notice until a model answers", async () => {
    // A credential is present, so readiness stays open: only the notice and
    // the transcript's sign-in card say what happened.
    queryControlOverrides.accountInfo = mock(async () => ({ tokenSource: "claude.ai" }));
    const sessionId = await refuseTurnForMissingLogin();

    expect(claudeReadiness()).toBeUndefined();
    expect(getSession(sessionId)?.authNotice).toEqual({
      state: "expired",
      message: CLAUDE_LOGIN_REFUSED_MESSAGE,
      occurrenceId: "not-logged-in",
    });

    const turn = sendPrompt(sessionId, "again");
    const call = await nextQueryCall();
    call.push({
      type: "assistant",
      uuid: "answer",
      message: { id: "answer-message", role: "assistant", content: [{ type: "text", text: "Hi" }] },
    });
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await turn;

    expect(getSession(sessionId)?.authNotice).toBeUndefined();
  });

  test("re-reads an expired lock in the background so a terminal login unlocks the tab", async () => {
    const accountInfo = mock(async (): Promise<Record<string, string>> => SIGNED_OUT);
    queryControlOverrides.accountInfo = accountInfo;
    await refuseTurnForMissingLogin();
    await waitFor(() => claudeReadiness() !== undefined);

    accountInfo.mockImplementation(async () => ({ tokenSource: "claude.ai" }));
    const now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now + 31_000);
    try {
      // The stale answer still stands while the re-read runs.
      expect(claudeReadiness()).toEqual(LOCKED);
      const probe = await nextQueryCall();
      await waitFor(() => probe.isClosed());
      await waitFor(() => claudeReadiness() === undefined);
    } finally {
      clock.mockRestore();
    }
    expect(accountInfo).toHaveBeenCalledTimes(2);
  });
});

describe("Claude auth status carries no credential", () => {
  test("drops every token the environment and the SDK hold, and logs none of them", async () => {
    const planted = {
      ANTHROPIC_API_KEY: AUTH_SECRET_CANARIES.anthropicApiKey,
      CLAUDE_CODE_OAUTH_TOKEN: AUTH_SECRET_CANARIES.claudeOAuthToken,
    };
    const previous = Object.fromEntries(
      [...Object.keys(planted), "CLAUDE_BRIDGE_NO_SERVER"].map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, planted);
    // Everything `accountInfo()` reports, plus fields a future SDK might add.
    queryControlOverrides.accountInfo = mock(async () => ({
      email: "user@example.test",
      organization: "Example Org",
      subscriptionType: "max",
      tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
      apiKeySource: "ANTHROPIC_API_KEY",
      apiProvider: "firstParty",
      accessToken: AUTH_SECRET_CANARIES.accessToken,
      refreshToken: AUTH_SECRET_CANARIES.refreshToken,
      apiKey: AUTH_SECRET_CANARIES.anthropicApiKey,
    }));
    try {
      process.env.CLAUDE_BRIDGE_NO_SERVER = "1";
      const { app } = await import("../index.js");
      const { result: status, output } = await captureOutput(() => readClaudeAuthStatus());
      expectAuthStatusShape(status);
      expect(status).toMatchObject({
        state: "signed-in",
        account: { label: "Example Org", plan: "max" },
      });
      expectNoCanary(status, "Claude auth status");
      expectNothingSecretLogged(output, "Claude auth status");
      const { result: responses, output: routeOutput } = await captureOutput(async () => {
        const headers = { Authorization: "Bearer test-auth-secret-token" };
        const { __testing } = await import("../index.js");
        __testing.setBridgeAuthForTesting("test-auth-secret-token");
        try {
          return await Promise.all([
            app.request("/global/auth", { headers }),
            app.request("/global/auth/login", { method: "POST", headers }),
            app.request("/global/auth/logout", { method: "POST", headers }),
          ]);
        } finally {
          __testing.setBridgeAuthForTesting(undefined);
        }
      });
      expect(responses.map((response) => response.status)).toEqual([200, 405, 405]);
      const [authBody, loginBody, logoutBody] = await Promise.all(
        responses.map((response) => response.json()),
      );
      expectAuthStatusShape(authBody);
      expect(authBody).toEqual(status);
      expect(loginBody).toEqual({
        error: "Claude signs in from the sign-in card in its tab or from Settings → Claude.",
      });
      expect(logoutBody).toEqual({ error: "Claude sign-out is available from a terminal tab." });
      expectNoCanary([authBody, loginBody, logoutBody], "Claude auth routes");
      expectNothingSecretLogged(routeOutput, "Claude auth routes");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test("a fresh probe after terminal reauthentication can clear expired without a model turn", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    queryControlOverrides.accountInfo = mock(async () => ({
      tokenSource: "claude.ai",
      subscriptionType: "max",
    }));
    noteClaudeAuthenticationFailure();
    const failedProbe = await nextQueryCall();
    await waitFor(() => failedProbe.isClosed());
    expect((await readClaudeAuthStatus()).state).toBe("expired");
    now += 30_001;
    queryControlOverrides.accountInfo = mock(async () => ({
      tokenSource: "claude.ai",
      subscriptionType: "team",
    }));
    const status = await readClaudeAuthStatus();
    expect(status).toMatchObject({ state: "signed-in", account: { plan: "team" } });
    expect(claudeReadiness()).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});
