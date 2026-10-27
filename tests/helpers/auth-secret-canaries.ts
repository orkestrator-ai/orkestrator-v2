/**
 * Guards for the rule that auth responses carry no credential and that the
 * one secret-adjacent value they may carry, the sign-in URL, is never logged.
 *
 * A test plants these canaries wherever its fake reads credentials from (an
 * environment variable, a credential store, an SDK answer), drives the real
 * route, and then checks two things:
 *
 * - the body matches the allowlisted shape exactly (`expectAuthStatusShape`,
 *   `expectSignInShape`), so a new field cannot appear without a test change;
 * - neither the body nor anything written to the console or stdio while the
 *   route ran contains a canary (`expectNoCanary`, `captureOutput`).
 *
 * The canaries are shaped like the real thing so a future pattern-based
 * scrubber would recognise them, but each carries a marker no real credential
 * has, so a match can only come from the test's own plant.
 */
import { format } from "node:util";
import { expect } from "bun:test";

const MARK = "ORKCANARY";

export const AUTH_SECRET_CANARIES = {
  anthropicApiKey: `sk-ant-api03-${MARK}-anthropic-api-key-000000000000`,
  claudeOAuthToken: `sk-ant-oat01-${MARK}-claude-oauth-token-0000000000`,
  openAiApiKey: `sk-proj-${MARK}-openai-api-key-00000000000000000`,
  accessToken: `eyJhbGciOiJIUzI1NiJ9.${MARK}.access-token-signature`,
  refreshToken: `rt_${MARK}_refresh_token_000000000000000000`,
  idToken: `eyJraWQiOiJpZCJ9.${MARK}-id-token.signature`,
  oauthCode: `${MARK}-oauth-authorization-code`,
  cursorApiKey: `key_${MARK}_cursor_api_key_000000000000000000`,
  xaiApiKey: `xai-${MARK}-grok-api-key-00000000000000000000`,
} as const;

export type AuthSecretCanary = keyof typeof AUTH_SECRET_CANARIES;

/** A login URL that is safe to return to the requester and must never be logged. */
export const CANARY_LOGIN_URL = `https://auth.example.test/authorize?state=${MARK}-login-state`;
/** A device or user code, returned beside the URL and never logged either. */
export const CANARY_USER_CODE = `${MARK}-USER-CODE`;

const AUTH_STATES = new Set(["signed-in", "signed-out", "needs-auth", "expired", "unknown"]);
const SIGN_IN_KINDS = new Set(["browser-url", "device-code", "terminal", "none"]);
const PROVIDER_METHODS = new Set(["api-key", "oauth", "subscription"]);

function keysWithin(value: object, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  expect(extra, `${where} carries fields outside the allowlist`).toEqual([]);
}

function expectOptionalString(value: unknown, where: string): void {
  if (value !== undefined) expect(typeof value, where).toBe("string");
}

/**
 * Fail unless `body` is exactly a `NativeAgentAuthStatus`: no field outside
 * the protocol type at any depth, every enum value known.
 */
export function expectAuthStatusShape(body: unknown): void {
  expect(body !== null && typeof body === "object" && !Array.isArray(body)).toBe(true);
  const status = body as Record<string, unknown>;
  keysWithin(
    status,
    ["state", "account", "providers", "signIn", "signOut", "pendingSignIn"],
    "auth status",
  );
  expect(AUTH_STATES.has(String(status.state))).toBe(true);
  if (status.account !== undefined) {
    const account = status.account as Record<string, unknown>;
    keysWithin(account, ["label", "plan", "expiresAt"], "auth status account");
    expect(typeof account.label).toBe("string");
    expectOptionalString(account.plan, "account.plan");
    expectOptionalString(account.expiresAt, "account.expiresAt");
  }
  if (status.providers !== undefined) {
    expect(Array.isArray(status.providers)).toBe(true);
    for (const candidate of status.providers as Array<Record<string, unknown>>) {
      keysWithin(candidate, ["id", "label", "state", "method"], "auth status provider");
      expect(typeof candidate.id).toBe("string");
      expect(typeof candidate.label).toBe("string");
      expect(AUTH_STATES.has(String(candidate.state))).toBe(true);
      if (candidate.method !== undefined) {
        expect(PROVIDER_METHODS.has(String(candidate.method))).toBe(true);
      }
    }
  }
  if (status.signIn !== undefined) {
    const signIn = status.signIn as Record<string, unknown>;
    keysWithin(signIn, ["kind", "hint"], "auth status signIn");
    expect(SIGN_IN_KINDS.has(String(signIn.kind))).toBe(true);
    expectOptionalString(signIn.hint, "signIn.hint");
  }
  if (status.pendingSignIn !== undefined && status.pendingSignIn !== null) {
    const pending = status.pendingSignIn as Record<string, unknown>;
    keysWithin(pending, ["url", "code", "expiresAt"], "pending sign-in");
    expect(typeof pending.url).toBe("string");
    expect(typeof pending.code).toBe("string");
    expect(typeof pending.expiresAt).toBe("number");
  }
  if (status.signOut !== undefined) expect(typeof status.signOut).toBe("boolean");
}

/**
 * Fail unless a sign-in answer holds only the URL to open and the code to
 * type. `extra` names a bridge's own additional keys, which must also be
 * strings (Cursor repeats the URL as `loginUrl`).
 */
export function expectSignInShape(body: unknown, extra: readonly string[] = []): void {
  expect(body !== null && typeof body === "object" && !Array.isArray(body)).toBe(true);
  const answer = body as Record<string, unknown>;
  keysWithin(answer, ["url", "code", ...extra], "sign-in answer");
  for (const value of Object.values(answer)) expect(typeof value).toBe("string");
}

/** Fail if any planted canary, or any extra needle, occurs in `value`. */
export function expectNoCanary(
  value: unknown,
  where: string,
  extraNeedles: readonly string[] = [],
): void {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const found = [...Object.values(AUTH_SECRET_CANARIES), ...extraNeedles].filter((needle) =>
    text.includes(needle),
  );
  expect(found, `${where} leaked a credential or login URL`).toEqual([]);
  // The marker catches a canary that was reformatted, truncated or encoded
  // into a larger string the needles above would not match whole.
  expect(text.includes(MARK), `${where} leaked part of a planted secret`).toBe(false);
}

/**
 * The response may carry the login URL and user code to the requester; any
 * other planted secret is a leak. Strips the two allowed values before
 * checking, so the marker check still covers everything else.
 */
export function expectOnlyLoginSecrets(value: unknown, where: string): void {
  const text = JSON.stringify(value ?? null)
    .split(CANARY_LOGIN_URL)
    .join("<login-url>")
    .split(CANARY_USER_CODE)
    .join("<user-code>");
  expectNoCanary(text, where);
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/**
 * Run `work` while recording everything written through `console` and
 * `process.stdout` / `process.stderr`, then restore the originals. Output is
 * captured, not forwarded, so a planted secret never reaches the test log
 * either.
 */
export async function captureOutput<T>(
  work: () => Promise<T> | T,
): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const originals = CONSOLE_METHODS.map((method) => [method, console[method]] as const);
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      lines.push(format(...args));
    };
  }
  const recordWrite = (chunk: unknown, ...rest: unknown[]): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
    const callback = rest.find((entry) => typeof entry === "function") as
      ((error?: Error | null) => void) | undefined;
    callback?.();
    return true;
  };
  process.stdout.write = recordWrite as typeof process.stdout.write;
  process.stderr.write = recordWrite as typeof process.stderr.write;
  try {
    const result = await work();
    return { result, output: lines.join("\n") };
  } finally {
    for (const [method, original] of originals) console[method] = original;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

/** Fail if captured output holds a canary, the login URL or the user code. */
export function expectNothingSecretLogged(output: string, where: string): void {
  expectNoCanary(output, `${where} output`, [CANARY_LOGIN_URL, CANARY_USER_CODE]);
}
