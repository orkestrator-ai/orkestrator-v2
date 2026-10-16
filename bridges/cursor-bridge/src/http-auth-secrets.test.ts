/**
 * The sign-in routes never hand out the Cursor key, and never log the URL.
 *
 * The credential runtime is injected with canary credentials shaped like the
 * real thing (`tests/helpers/auth-secret-canaries.ts`), then the real router
 * answers `/global/auth`, `/global/auth/login` and `/global/auth/logout`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as realCursorSdk from "@cursor/sdk";
import { createServer, type Server } from "node:http";
import {
  AUTH_SECRET_CANARIES,
  CANARY_LOGIN_URL,
  captureOutput,
  expectAuthStatusShape,
  expectNoCanary,
  expectNothingSecretLogged,
  expectOnlyLoginSecrets,
  expectSignInShape,
} from "../../../tests/helpers/auth-secret-canaries.js";
import { authToken } from "./config.js";
import { useCursorCredentialRuntimeForTests } from "./credentials.js";
import { route } from "./http.js";

interface StoredCredential {
  apiKey: string;
  email?: string;
  apiKeyExpiresAtMs?: number;
}

let stored: StoredCredential | undefined;
let finishLogin: (() => void) | undefined;
let server: Server;
let baseUrl: string;
let restoreCredentialRuntime: () => void;
const previousApiKey = process.env.CURSOR_API_KEY;

beforeAll(() => {
  restoreCredentialRuntime = useCursorCredentialRuntimeForTests({
    store: {
      load: async () => stored,
      save: async (value: StoredCredential) => {
        stored = value;
      },
      clear: async () => {
        stored = undefined;
      },
    } as unknown as Parameters<typeof useCursorCredentialRuntimeForTests>[0]["store"],
    auth: {
      // Publishes the URL, then holds the flow open the way a user who has not
      // finished in the browser does. Completing it mints and stores a key.
      login: (options: { onLoginUrl: (url: string) => void }) => {
        options.onLoginUrl(CANARY_LOGIN_URL);
        return new Promise<void>((resolve) => {
          finishLogin = () => {
            stored = { apiKey: AUTH_SECRET_CANARIES.cursorApiKey, email: "user@example.test" };
            resolve();
          };
        });
      },
      logout: async () => {
        stored = undefined;
      },
    } as unknown as typeof realCursorSdk.Cursor.auth,
    // Everything `Cursor.me` answers, plus a key field a future SDK might add.
    me: (async () => ({
      apiKeyName: "Orkestrator",
      userEmail: "user@example.test",
      apiKey: AUTH_SECRET_CANARIES.cursorApiKey,
      accessToken: AUTH_SECRET_CANARIES.accessToken,
    })) as unknown as typeof realCursorSdk.Cursor.me,
  });
});

afterAll(() => {
  restoreCredentialRuntime();
  if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousApiKey;
});

beforeEach(async () => {
  stored = undefined;
  finishLogin = undefined;
  delete process.env.CURSOR_API_KEY;
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  finishLogin?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Bun's native client: the test preload's browser-like `fetch` applies CORS. */
async function call(path: string, method: "GET" | "POST" = "GET"): Promise<unknown> {
  const response = await Bun.fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${authToken}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("Cursor sign-in routes carry no credential", () => {
  test.each([
    ["a stored login", () => (stored = { apiKey: AUTH_SECRET_CANARIES.cursorApiKey })],
    ["an environment key", () => (process.env.CURSOR_API_KEY = AUTH_SECRET_CANARIES.cursorApiKey)],
  ])("GET /global/auth with %s", async (_name, plant) => {
    plant();
    const { result: body, output } = await captureOutput(() => call("/global/auth"));
    expectAuthStatusShape(body);
    expect(body).toMatchObject({ state: "signed-in", account: { label: "Orkestrator" } });
    expectNoCanary(body, "Cursor auth status");
    expectNothingSecretLogged(output, "Cursor auth status");
  });

  test("POST /global/auth/login returns the URL, not the key it goes on to mint", async () => {
    const { result: body, output } = await captureOutput(async () => {
      const started = await call("/global/auth/login", "POST");
      finishLogin!();
      // A second request answers from the completed flow's successor, so the
      // minted key had every chance to leak into this answer too.
      return { started, status: await call("/global/auth") };
    });
    expect(body.started).toEqual({ url: CANARY_LOGIN_URL, loginUrl: CANARY_LOGIN_URL });
    expectSignInShape(body.started, ["loginUrl"]);
    expectOnlyLoginSecrets(body.started, "Cursor sign-in");
    expectAuthStatusShape(body.status);
    expectNoCanary(body.status, "Cursor auth status after sign-in");
    expectNothingSecretLogged(output, "Cursor sign-in");
  });

  test("POST /global/auth/logout answers with the signed-out status only", async () => {
    stored = { apiKey: AUTH_SECRET_CANARIES.cursorApiKey };
    const { result: body, output } = await captureOutput(() => call("/global/auth/logout", "POST"));
    expectAuthStatusShape(body);
    expect(body).toMatchObject({ state: "signed-out" });
    expectNoCanary(body, "Cursor sign-out");
    expectNothingSecretLogged(output, "Cursor sign-out");
  });
});
