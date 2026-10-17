import { afterEach, beforeEach, spyOn, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentTestHostCursorCredentialPath,
  loadAgentTestHostCursorApiKey,
  resetAgentTestHostCursorApiKeyForTests,
} from "./agent-test-cursor-credential.js";
import type { CommandContext } from "./commands-context.js";
import { resolveCursorApiKey } from "./commands-validation.js";
import { cursorSdkAuthStatus } from "./cursor-sdk-bridge.js";

let dataDir: string;
const previousCursorApiKey = process.env.CURSOR_API_KEY;

async function writeSnapshot(contents: string): Promise<void> {
  const snapshot = agentTestHostCursorCredentialPath(dataDir);
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  await fs.writeFile(snapshot, contents, { mode: 0o600 });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-cursor-host-key-"));
  delete process.env.CURSOR_API_KEY;
});

afterEach(async () => {
  resetAgentTestHostCursorApiKeyForTests();
  if (previousCursorApiKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousCursorApiKey;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("agent-test host Cursor key", () => {
  test("reads as a snapshot key for an authorized profile", async () => {
    await writeSnapshot(JSON.stringify({ apiKey: " host-key " }));
    loadAgentTestHostCursorApiKey({
      dataDir,
      runtimeFlavor: "agent-test",
      credentialSources: new Set(["cursor"]),
    });

    expect(resolveCursorApiKey({} as never)).toEqual({
      apiKey: "host-key",
      source: "host-snapshot",
    });
    // A key the profile stored in its own settings still wins.
    expect(resolveCursorApiKey({ cursorApiKey: "profile-key" } as never)).toEqual({
      apiKey: "profile-key",
      source: "config",
    });
    const context = { storage: { getDataDir: () => dataDir } } as unknown as CommandContext;
    await expect(cursorSdkAuthStatus(context, undefined)).resolves.toEqual({
      authenticated: true,
      source: "host-snapshot",
    });
    await expect(cursorSdkAuthStatus(context, "profile-key")).resolves.toEqual({
      authenticated: true,
      source: "api-key-config",
    });
    // Never exported to the environment that terminals and children inherit.
    expect(process.env.CURSOR_API_KEY).toBeUndefined();
  });

  test("an inherited CURSOR_API_KEY keeps precedence", async () => {
    await writeSnapshot(JSON.stringify({ apiKey: "host-key" }));
    process.env.CURSOR_API_KEY = "shell-key";
    loadAgentTestHostCursorApiKey({
      dataDir,
      runtimeFlavor: "agent-test",
      credentialSources: new Set(["cursor"]),
    });

    expect(resolveCursorApiKey({} as never).apiKey).toBe("shell-key");
  });

  test("expires a snapshot at load time and while the backend stays running", async () => {
    const expiresAt = Date.now() + 60_000;
    await writeSnapshot(JSON.stringify({ apiKey: "expiring-key", apiKeyExpiresAtMs: expiresAt }));
    const clock = spyOn(Date, "now").mockReturnValue(expiresAt - 1);
    const options = {
      dataDir,
      runtimeFlavor: "agent-test",
      credentialSources: new Set(["cursor"] as const),
    };
    const context = { storage: { getDataDir: () => dataDir } } as unknown as CommandContext;
    try {
      loadAgentTestHostCursorApiKey(options);
      expect(resolveCursorApiKey({} as never).apiKey).toBe("expiring-key");
      await expect(cursorSdkAuthStatus(context, undefined)).resolves.toMatchObject({
        source: "host-snapshot",
        expiresAt: new Date(expiresAt).toISOString(),
      });
      clock.mockReturnValue(expiresAt);
      expect(resolveCursorApiKey({} as never)).toEqual({ source: "none" });
      await expect(cursorSdkAuthStatus(context, undefined)).resolves.toEqual({
        authenticated: false,
        source: "none",
      });
      loadAgentTestHostCursorApiKey(options);
      expect(resolveCursorApiKey({} as never)).toEqual({ source: "none" });
    } finally {
      clock.mockRestore();
    }
  });

  test("is ignored unless an agent-test profile authorizes Cursor", async () => {
    await writeSnapshot(JSON.stringify({ apiKey: "host-key" }));
    for (const options of [
      { runtimeFlavor: "agent-test", credentialSources: new Set(["claude"] as const) },
      { runtimeFlavor: "production", credentialSources: new Set(["cursor"] as const) },
    ]) {
      loadAgentTestHostCursorApiKey({ dataDir, ...options });
      expect(resolveCursorApiKey({} as never)).toEqual({ source: "none" });
    }
  });

  test("a missing or malformed snapshot is a signed-out profile", async () => {
    const options = {
      dataDir,
      runtimeFlavor: "agent-test",
      credentialSources: new Set(["cursor"] as const),
    };
    loadAgentTestHostCursorApiKey(options);
    expect(resolveCursorApiKey({} as never)).toEqual({ source: "none" });

    for (const contents of ["not json", "null", JSON.stringify({ apiKey: 7 }), "{}"]) {
      await writeSnapshot(contents);
      loadAgentTestHostCursorApiKey(options);
      expect(resolveCursorApiKey({} as never)).toEqual({ source: "none" });
    }
  });
});
