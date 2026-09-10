/**
 * Which credential the bridge would actually run under.
 *
 * This order is a contract, not an implementation detail: the settings pane
 * reports it from the backend's own parallel implementation, so if the two
 * disagree the app tells the user it is signed in with a credential the bridge
 * would never reach for. `tests/unit/electron/cursor-sdk-bridge.test.ts` pins
 * the backend half; this pins the bridge half.
 *
 * The credential runtime is injected directly so this owner never mutates
 * Bun's process-wide module registry or reaches the developer's Cursor store.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as realCursorSdk from "@cursor/sdk";
import {
  authStatus,
  beginLogin,
  logout,
  resolveCredential,
  useCursorCredentialRuntimeForTests,
} from "./credentials.js";
import { runLogin } from "./login-cli.js";

interface StoredCredential {
  apiKey: string;
  email?: string;
  apiKeyExpiresAtMs?: number;
}

/** What the fake store hands back, and what a login would write into it. */
let stored: StoredCredential | undefined;
let loadFails = false;
let logouts = 0;
let meCalls = 0;
const loginCalls: Array<Record<string, unknown>> = [];
let loginBehaviour: (options: Record<string, unknown>) => Promise<void> = async () => undefined;

class FakeCredentialStore {
  constructor(readonly path?: string) {}
  async load(): Promise<StoredCredential | undefined> {
    if (loadFails) throw new Error("unreadable credential store");
    return stored;
  }
  async save(value: StoredCredential): Promise<void> {
    stored = value;
  }
  async clear(): Promise<void> {
    stored = undefined;
  }
}

const previousApiKey = process.env.CURSOR_API_KEY;
let restoreCredentialRuntime: () => void;

beforeAll(() => {
  restoreCredentialRuntime = useCursorCredentialRuntimeForTests({
    store: new FakeCredentialStore(),
    auth: {
      login: (options: Record<string, unknown>) => {
        loginCalls.push(options);
        return loginBehaviour(options);
      },
      logout: async () => {
        logouts += 1;
        stored = undefined;
      },
    } as unknown as typeof realCursorSdk.Cursor.auth,
    me: (async () => {
      meCalls += 1;
      return undefined;
    }) as typeof realCursorSdk.Cursor.me,
  });
});

beforeEach(() => {
  stored = undefined;
  loadFails = false;
  logouts = 0;
  meCalls = 0;
  loginCalls.length = 0;
  loginBehaviour = async () => undefined;
  delete process.env.CURSOR_API_KEY;
});

afterAll(() => {
  restoreCredentialRuntime();
  if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousApiKey;
});

describe("resolveCredential", () => {
  test("reports no credential when nothing is configured", async () => {
    expect(await resolveCredential()).toEqual({ source: "none" });
  });

  test("prefers an inherited environment key over a stored login", async () => {
    process.env.CURSOR_API_KEY = "  env-key  ";
    stored = { apiKey: "stored-key" };
    // The order is made explicit here precisely so an environment cannot
    // silently fall back to an ambient key the user did not choose.
    expect(await resolveCredential()).toEqual({ apiKey: "env-key", source: "api-key-env" });
  });

  test("an empty environment key is not a credential", async () => {
    // The login child is spawned with `CURSOR_API_KEY: ""` so it mints a key
    // of its own rather than short-circuiting on an ambient one.
    process.env.CURSOR_API_KEY = "   ";
    stored = { apiKey: "stored-key" };
    expect(await resolveCredential()).toEqual({ apiKey: "stored-key", source: "stored-login" });
  });

  test("uses a stored login that has not expired", async () => {
    stored = { apiKey: "stored-key", apiKeyExpiresAtMs: Date.now() + 60_000 };
    expect(await resolveCredential()).toEqual({ apiKey: "stored-key", source: "stored-login" });
  });

  test("an expired stored login is no credential at all", async () => {
    stored = { apiKey: "stored-key", apiKeyExpiresAtMs: Date.now() - 1 };
    expect(await resolveCredential()).toEqual({ source: "none" });
  });

  test("an unreadable store reads as signed out rather than throwing", async () => {
    // Attach is the caller. A throw here would surface as an opaque 500 on the
    // prompt route instead of the sign-in prompt the user can act on.
    loadFails = true;
    expect(await resolveCredential()).toEqual({ source: "none" });
  });

  test("a store entry with no key is not a credential", async () => {
    stored = { apiKey: "" };
    expect(await resolveCredential()).toEqual({ source: "none" });
  });
});

describe("authStatus", () => {
  test("never discloses the key it found", async () => {
    stored = { apiKey: "super-secret", email: "dev@example.com" };
    const status = await authStatus();
    expect(status).toEqual({
      state: "signed-in",
      account: { label: "dev@example.com" },
      signIn: { kind: "browser-url" },
      signOut: true,
    });
    expect(JSON.stringify(status)).not.toContain("super-secret");
  });

  test("reports an inherited environment key without reading the store", async () => {
    process.env.CURSOR_API_KEY = "env-key";
    loadFails = true;
    expect(await authStatus()).toEqual({
      state: "signed-in",
      account: { label: "Cursor account" },
      signIn: { kind: "none", hint: "Remove CURSOR_API_KEY to sign out." },
      signOut: false,
    });
  });

  test("surfaces the expiry as an ISO timestamp the UI can render", async () => {
    const expiresAtMs = Date.now() + 86_400_000;
    stored = { apiKey: "k", apiKeyExpiresAtMs: expiresAtMs };
    expect(await authStatus()).toMatchObject({
      state: "signed-in",
      account: { expiresAt: new Date(expiresAtMs).toISOString() },
    });
  });

  test("caches the remote account lookup for repeated status reads", async () => {
    stored = { apiKey: "cache-test-key", email: "cache@example.com" };
    await authStatus();
    await authStatus();
    expect(meCalls).toBe(1);
  });

  test("an expired login reads as signed out, so the UI offers the fix", async () => {
    stored = { apiKey: "k", apiKeyExpiresAtMs: Date.now() - 1 };
    expect(await authStatus()).toEqual({
      state: "expired",
      signIn: { kind: "browser-url" },
      signOut: true,
    });
  });
});

describe("beginLogin", () => {
  test("publishes the URL before the flow completes, and never opens a browser by default", async () => {
    let finish: () => void = () => undefined;
    loginBehaviour = async (options) => {
      (options.onLoginUrl as (url: string) => void)("https://cursor.com/login/abc");
      stored = { apiKey: "minted", email: "dev@example.com" };
      await new Promise<void>((resolve) => (finish = resolve));
    };

    const handle = beginLogin();
    expect(await handle.loginUrl).toBe("https://cursor.com/login/abc");
    // A bridge serving a session may be inside a container, where a launch
    // would either fail or open a browser nobody is looking at.
    expect(loginCalls[0]).toMatchObject({ openBrowser: false, apiKeyName: "Orkestrator" });

    finish();
    expect(await handle.completion).toMatchObject({
      state: "signed-in",
      account: { label: "dev@example.com" },
    });
  });

  test("opens the browser only when the caller asks", async () => {
    loginBehaviour = async (options) => {
      (options.onLoginUrl as (url: string) => void)("https://cursor.com/login/abc");
    };
    const handle = beginLogin({ openBrowser: true });
    await handle.loginUrl;
    await handle.completion;
    expect(loginCalls[0]).toMatchObject({ openBrowser: true });
  });

  test("a failure before the URL exists rejects the URL rather than hanging on it", async () => {
    // Without this a caller awaiting `loginUrl` waits forever, which is the
    // whole request the settings pane is blocked on.
    loginBehaviour = async () => {
      throw new Error("device flow refused");
    };
    const handle = beginLogin();
    // Both handlers are attached before either is awaited. A rejection that
    // lands while only one of the two is observed is an unhandled rejection,
    // which is exactly the failure `runLogin` used to die on.
    const url = handle.loginUrl.catch((error: unknown) => error);
    const completion = handle.completion.catch((error: unknown) => error);
    expect(await url).toMatchObject({ message: "device flow refused" });
    expect(await completion).toMatchObject({ message: "device flow refused" });
  });

  test("cancelling aborts the signal the SDK was handed", async () => {
    let observed: AbortSignal | undefined;
    loginBehaviour = async (options) => {
      observed = options.signal as AbortSignal;
      (options.onLoginUrl as (url: string) => void)("https://cursor.com/login/abc");
    };
    const handle = beginLogin();
    await handle.loginUrl;
    await handle.completion;

    expect(observed?.aborted).toBe(false);
    handle.cancel();
    expect(observed?.aborted).toBe(true);
  });
});

describe("logout", () => {
  test("clears the bridge's own store, not the SDK default", async () => {
    stored = { apiKey: "k" };
    await logout();
    expect(logouts).toBe(1);
    expect(loginCalls).toHaveLength(0);
    expect(await resolveCredential()).toEqual({ source: "none" });
  });
});

/**
 * The one-shot `--login` child, driven through the same fake SDK.
 *
 * The backend reads exactly these lines to learn the URL and the outcome, so a
 * child that dies without emitting one leaves the settings pane reporting a
 * bare exit code in place of the reason.
 */
describe("runLogin", () => {
  function collect(): { lines: string[]; emit: (line: string) => void } {
    const lines: string[] = [];
    return { lines, emit: (line) => lines.push(line) };
  }

  test("emits the URL, then reports success with the stored identity", async () => {
    loginBehaviour = async (options) => {
      (options.onLoginUrl as (url: string) => void)("https://cursor.com/login/abc");
      stored = { apiKey: "minted", email: "dev@example.com" };
    };

    const { lines, emit } = collect();
    expect(await runLogin(emit)).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { loginUrl: "https://cursor.com/login/abc" },
      { ok: true, account: "dev@example.com" },
    ]);
    // The minted key goes only to the credential store.
    expect(lines.join("")).not.toContain("minted");
  });

  test("reports why a login that never published a URL failed", async () => {
    // Regression: `completion` rejects here too, and with nothing observing it
    // the child died on an unhandled rejection before emitting anything, so
    // the backend saw only a bare exit code.
    loginBehaviour = async () => {
      throw new Error("device flow refused");
    };

    const { lines, emit } = collect();
    expect(await runLogin(emit)).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ error: "device flow refused" }]);
  });

  test("reports a flow that finished without storing anything", async () => {
    loginBehaviour = async (options) => {
      (options.onLoginUrl as (url: string) => void)("https://cursor.com/login/abc");
    };

    const { lines, emit } = collect();
    expect(await runLogin(emit)).toBe(1);
    expect(JSON.parse(lines[1]!)).toEqual({
      error: "Cursor sign-in completed but no credential was stored",
    });
  });

  test("a failure after the URL is published still names its reason", async () => {
    loginBehaviour = async (options) => {
      (options.onLoginUrl as (url: string) => void)("https://cursor.com/login/abc");
      throw new Error("the user closed the browser");
    };

    const { lines, emit } = collect();
    expect(await runLogin(emit)).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual({ loginUrl: "https://cursor.com/login/abc" });
    expect(JSON.parse(lines[1]!)).toEqual({ error: "the user closed the browser" });
  });
});
