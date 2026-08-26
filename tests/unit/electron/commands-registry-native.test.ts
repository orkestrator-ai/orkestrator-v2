import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry, createContext, createEnvironment, createTempDir, fs, path } =
  await createCommandFixtures();

/**
 * `get_cursor_account_usage` resolves the credential entirely in the backend.
 * These cover the resolution branches through the real command boundary; the
 * network is stubbed, because the endpoint behind it is Cursor's and the point
 * here is which key gets used, not what Cursor answers.
 */
describe("get_cursor_account_usage", () => {
  const originalCursorApiKey = process.env.CURSOR_API_KEY;

  beforeEach(() => {
    delete process.env.CURSOR_API_KEY;
  });

  afterEach(() => {
    if (originalCursorApiKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = originalCursorApiKey;
  });

  test("answers with a structured, non-retryable failure when no credential exists", async () => {
    const dataDir = await createTempDir("ork-cursor-usage-no-key-");
    const commands = createCommandRegistry();
    const { context } = createContext(createEnvironment(), { dataDir });
    const fetchSpy = spyOn(globalThis, "fetch");

    const result = await commands.get("get_cursor_account_usage")?.({}, context);

    expect(result).toEqual({
      ok: false,
      code: "AUTH_FAILED",
      message: "Add a Cursor API key or sign in under Settings › Cursor to view account usage.",
      retryable: false,
    });
    // Nothing to authenticate with means nothing to send.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test("prefers the configured key over the stored Cursor SDK login", async () => {
    const dataDir = await createTempDir("ork-cursor-usage-configured-");
    await fs.mkdir(path.join(dataDir, "cursor-sdk"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "cursor-sdk", "auth.json"),
      JSON.stringify({ apiKey: "key_from_sdk_login" }),
    );
    const seen: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (authorization) seen.push(authorization);
      return new Response(JSON.stringify({ accessToken: "exchanged" }), { status: 200 });
    }) as unknown as typeof fetch);

    const commands = createCommandRegistry();
    const { context } = createContext(createEnvironment(), {
      dataDir,
      globalConfig: { cursorApiKey: "key_from_settings" },
    });

    await commands.get("get_cursor_account_usage")?.({}, context);

    expect(seen[0]).toBe("Bearer key_from_settings");
    expect(seen).not.toContain("Bearer key_from_sdk_login");
    fetchSpy.mockRestore();
  });

  test("falls back to the stored Cursor SDK login when nothing is configured", async () => {
    const dataDir = await createTempDir("ork-cursor-usage-sdk-fallback-");
    await fs.mkdir(path.join(dataDir, "cursor-sdk"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "cursor-sdk", "auth.json"),
      JSON.stringify({ apiKey: "key_from_sdk_login_fallback" }),
    );
    const seen: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (authorization) seen.push(authorization);
      return new Response(JSON.stringify({ accessToken: "exchanged" }), { status: 200 });
    }) as unknown as typeof fetch);

    const commands = createCommandRegistry();
    const { context } = createContext(createEnvironment(), { dataDir });

    await commands.get("get_cursor_account_usage")?.({}, context);

    expect(seen[0]).toBe("Bearer key_from_sdk_login_fallback");
    fetchSpy.mockRestore();
  });

  test("uses an inherited CURSOR_API_KEY when the config has none", async () => {
    process.env.CURSOR_API_KEY = "key_from_host_env";
    const dataDir = await createTempDir("ork-cursor-usage-env-");
    const seen: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (authorization) seen.push(authorization);
      return new Response(JSON.stringify({ accessToken: "exchanged" }), { status: 200 });
    }) as unknown as typeof fetch);

    const commands = createCommandRegistry();
    const { context } = createContext(createEnvironment(), { dataDir });

    await commands.get("get_cursor_account_usage")?.({}, context);

    expect(seen[0]).toBe("Bearer key_from_host_env");
    fetchSpy.mockRestore();
  });
});
