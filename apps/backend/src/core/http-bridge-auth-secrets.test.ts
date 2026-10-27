/**
 * The backend's auth boundary over every bridge keeps only the allowlisted
 * fields of `NativeAgentAuthStatus` and of a sign-in answer, so a bridge that
 * starts returning a credential cannot pass it on to the renderer, the
 * public API or a log. The bridges pin their own halves with the same
 * canaries (`tests/helpers/auth-secret-canaries.ts`).
 */
import { describe, expect, test } from "bun:test";
import {
  AUTH_SECRET_CANARIES,
  CANARY_LOGIN_URL,
  CANARY_USER_CODE,
  captureOutput,
  expectAuthStatusShape,
  expectNoCanary,
  expectNothingSecretLogged,
  expectOnlyLoginSecrets,
  expectSignInShape,
} from "../../../../tests/helpers/auth-secret-canaries.js";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  grokConnection,
  httpProvider,
  piConnection,
} from "./agent-provider-test-support.js";

const CONNECTIONS = [
  ["claude", claudeConnection],
  ["codex", codexConnection],
  ["cursor", cursorConnection],
  ["grok", grokConnection],
  ["pi", piConnection],
] as const;

/** Every credential field a provider holds, at every level of the answer. */
const TOKENS = {
  apiKey: AUTH_SECRET_CANARIES.anthropicApiKey,
  accessToken: AUTH_SECRET_CANARIES.accessToken,
  refreshToken: AUTH_SECRET_CANARIES.refreshToken,
  idToken: AUTH_SECRET_CANARIES.idToken,
};

describe.each(CONNECTIONS)("%s bridge auth boundary", (_agent, connection) => {
  test("drops credential fields a bridge adds to its auth status", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json({
          state: "signed-in",
          ...TOKENS,
          account: { label: "user@example.test", plan: "pro", ...TOKENS },
          providers: [{ id: "anthropic", label: "Anthropic", state: "signed-in", ...TOKENS }],
          signIn: { kind: "browser-url", url: CANARY_LOGIN_URL, ...TOKENS },
          signOut: true,
        }),
      connection,
    );

    const { result: status, output } = await captureOutput(() => provider.authStatus!());

    expectAuthStatusShape(status);
    expect(status).toEqual({
      state: "signed-in",
      account: { label: "user@example.test", plan: "pro" },
      providers: [{ id: "anthropic", label: "Anthropic", state: "signed-in" }],
      signIn: { kind: "browser-url" },
      signOut: true,
    });
    expectNoCanary(status, "auth status");
    expectNothingSecretLogged(output, "auth status");
  });

  test("passes on only the sign-in URL and code, and logs neither", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json({
          url: CANARY_LOGIN_URL,
          code: CANARY_USER_CODE,
          loginUrl: CANARY_LOGIN_URL,
          loginId: AUTH_SECRET_CANARIES.oauthCode,
          ...TOKENS,
        }),
      connection,
    );

    const { result: answer, output } = await captureOutput(() => provider.beginSignIn!());

    expect(answer).toEqual({ url: CANARY_LOGIN_URL, code: CANARY_USER_CODE });
    expectSignInShape(answer);
    expectOnlyLoginSecrets(answer, "sign-in answer");
    expectNothingSecretLogged(output, "sign-in");
  });

  test.each(["needs-auth", "signed-in"])(
    "rehydrates only bounded pending-login display fields while %s",
    async (state) => {
      const pendingSignIn = {
        url: CANARY_LOGIN_URL,
        code: CANARY_USER_CODE,
        expiresAt: Date.now() + 60_000,
      };
      const { provider } = httpProvider(
        () =>
          Response.json({
            state,
            pendingSignIn: { ...pendingSignIn, ...TOKENS, loginId: AUTH_SECRET_CANARIES.oauthCode },
          }),
        connection,
      );
      const { result: status, output } = await captureOutput(() => provider.authStatus!());
      expect(status.pendingSignIn).toEqual(pendingSignIn);
      expectAuthStatusShape(status);
      expectOnlyLoginSecrets(status, "pending sign-in");
      expectNothingSecretLogged(output, "pending sign-in");
    },
  );

  test.each(["expired", "unbounded", "invalid-url", "oversized-code"])(
    "drops a %s pending login",
    async (reason) => {
      const pendingSignIn = {
        url: CANARY_LOGIN_URL,
        code: CANARY_USER_CODE,
        expiresAt: Date.now() + 60_000,
      };
      if (reason === "expired") pendingSignIn.expiresAt = Date.now() - 1;
      if (reason === "unbounded") pendingSignIn.expiresAt = Date.now() + 60 * 60_000;
      if (reason === "invalid-url") pendingSignIn.url = "javascript:alert(1)";
      if (reason === "oversized-code") pendingSignIn.code = "a".repeat(513);
      const { provider } = httpProvider(
        () =>
          Response.json({
            state: "needs-auth",
            pendingSignIn,
          }),
        connection,
      );
      expect((await provider.authStatus!()).pendingSignIn ?? null).toBeNull();
    },
  );

  test("asks the bridge for a device code only when the caller does", async () => {
    const bodies: Array<string | null> = [];
    const { provider } = httpProvider(async (_input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : null);
      return Response.json({ url: CANARY_LOGIN_URL, code: CANARY_USER_CODE });
    }, connection);

    await provider.beginSignIn!({ deviceCode: true });
    await provider.beginSignIn!();

    expect(bodies).toEqual([JSON.stringify({ method: "device-code" }), null]);
  });

  test("cancels an in-tab sign-in, keeping only whether one was open", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    const { provider } = httpProvider((url, init) => {
      requests.push({ url, method: init.method });
      return Response.json({ cancelled: true, loginId: AUTH_SECRET_CANARIES.oauthCode, ...TOKENS });
    }, connection);

    const { result, output } = await captureOutput(() => provider.cancelSignIn!());

    expect(result).toEqual({ cancelled: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.endsWith("/global/auth/login/cancel")).toBe(true);
    expect(requests[0]!.method).toBe("POST");
    expectNothingSecretLogged(output, "sign-in cancel");
  });

  test("treats a bridge without a sign-in cancel route as nothing to cancel", async () => {
    const { provider } = httpProvider(() => new Response("Not Found", { status: 404 }), connection);
    await expect(provider.cancelSignIn!()).resolves.toEqual({ cancelled: false });
  });
});
