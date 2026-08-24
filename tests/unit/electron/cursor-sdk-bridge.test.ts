import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_CURSOR_SDK_AUTH_FILE,
  cursorSdkAuthStatus,
  cursorSdkBridgeEnabled,
  cursorSdkCredentialPath,
  cursorSdkLogout,
  cursorSdkStoredApiKey,
  syncContainerCursorSdkCredentials,
  writeCursorSdkCredentials,
} from "../../../apps/backend/src/core/cursor-sdk-bridge";
import type { CommandContext } from "../../../apps/backend/src/core/commands-context";

let dataDir: string;
const previousEnvKey = process.env.CURSOR_API_KEY;

function contextWith(experimentalCursorSdkBridge?: boolean): CommandContext {
  return {
    storage: {
      getDataDir: () => dataDir,
      loadConfig: async () => ({ global: { experimentalCursorSdkBridge }, repositories: {} }),
    },
  } as unknown as CommandContext;
}

async function storeCredentials(value: Record<string, unknown>): Promise<void> {
  await writeCursorSdkCredentials(contextWith(), JSON.stringify(value));
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "cursor-sdk-bridge-"));
  delete process.env.CURSOR_API_KEY;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  if (previousEnvKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousEnvKey;
});

describe("engine selection", () => {
  test("is off unless the setting is explicitly true", async () => {
    expect(await cursorSdkBridgeEnabled(contextWith(undefined))).toBe(false);
    expect(await cursorSdkBridgeEnabled(contextWith(false))).toBe(false);
    expect(await cursorSdkBridgeEnabled(contextWith(true))).toBe(true);
  });
});

describe("credential resolution", () => {
  test("reports no credential when nothing is configured", async () => {
    expect(await cursorSdkAuthStatus(contextWith(), undefined)).toEqual({
      authenticated: false,
      source: "none",
    });
  });

  test("prefers an inherited environment key, matching the bridge's own order", async () => {
    process.env.CURSOR_API_KEY = "from-env";
    await storeCredentials({ version: 1, apiKey: "from-login" });
    expect(await cursorSdkAuthStatus(contextWith(), "from-config")).toEqual({
      authenticated: true,
      source: "api-key-env",
    });
  });

  test("prefers a stored API key over a stored login", async () => {
    await storeCredentials({ version: 1, apiKey: "from-login" });
    expect(await cursorSdkAuthStatus(contextWith(), "from-config")).toEqual({
      authenticated: true,
      source: "api-key-config",
    });
  });

  test("reports a stored login with its identity and expiry", async () => {
    const expiresAtMs = Date.now() + 60_000;
    await storeCredentials({
      version: 1,
      apiKey: "from-login",
      email: "user@example.com",
      apiKeyExpiresAtMs: expiresAtMs,
    });
    expect(await cursorSdkAuthStatus(contextWith(), undefined)).toEqual({
      authenticated: true,
      source: "stored-login",
      email: "user@example.com",
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  });

  test("an expired login reads as signed out, so the UI offers the fix", async () => {
    await storeCredentials({
      version: 1,
      apiKey: "stale",
      apiKeyExpiresAtMs: Date.now() - 1_000,
    });
    expect(await cursorSdkAuthStatus(contextWith(), undefined)).toMatchObject({
      authenticated: false,
      source: "none",
    });
    expect(await cursorSdkStoredApiKey(contextWith())).toBeUndefined();
  });

  test("a corrupt credential file reads as signed out rather than throwing", async () => {
    await mkdir(path.dirname(cursorSdkCredentialPath(contextWith())), { recursive: true });
    await writeFile(cursorSdkCredentialPath(contextWith()), "{not json");
    expect(await cursorSdkAuthStatus(contextWith(), undefined)).toMatchObject({
      authenticated: false,
    });
  });

  test("a file with no key is not a credential", async () => {
    await storeCredentials({ version: 1, apiKey: "   " });
    expect(await cursorSdkAuthStatus(contextWith(), undefined)).toMatchObject({
      authenticated: false,
    });
  });

  test("writes the credential file owner-only", async () => {
    await storeCredentials({ version: 1, apiKey: "k" });
    const { mode } = await import("node:fs").then((fs) =>
      fs.promises.stat(cursorSdkCredentialPath(contextWith())),
    );
    expect(mode & 0o077).toBe(0);
  });

  test("signing out removes the stored login", async () => {
    await storeCredentials({ version: 1, apiKey: "k" });
    await cursorSdkLogout(contextWith());
    expect(await cursorSdkStoredApiKey(contextWith())).toBeUndefined();
    // Idempotent: signing out twice is not an error.
    await cursorSdkLogout(contextWith());
  });
});

describe("container credential delivery", () => {
  test("pipes the key over stdin rather than putting it in a command", async () => {
    const execs: string[] = [];
    const pipes: Array<{ command: string; stdin: string }> = [];
    await syncContainerCursorSdkCredentials("container-1", "secret-key", {
      exec: async (_id, command) => {
        execs.push(command);
        return "";
      },
      pipe: async (_id, command, stdin) => {
        pipes.push({ command, stdin });
      },
    });

    expect(execs).toHaveLength(0);
    expect(pipes).toHaveLength(1);
    // The key must never appear in the command itself, which is visible in a
    // process listing inside the container.
    expect(pipes[0]!.command).not.toContain("secret-key");
    expect(pipes[0]!.command).toContain("chmod 600");
    expect(JSON.parse(pipes[0]!.stdin)).toMatchObject({ version: 1, apiKey: "secret-key" });
  });

  test("removes the file when there is no credential to deliver", async () => {
    const execs: string[] = [];
    await syncContainerCursorSdkCredentials("container-1", undefined, {
      exec: async (_id, command) => {
        execs.push(command);
        return "";
      },
      pipe: async () => {
        throw new Error("should not write a credential");
      },
    });
    // A stale credential left behind would keep working after it was revoked here.
    expect(execs).toEqual([`rm -f ${CONTAINER_CURSOR_SDK_AUTH_FILE}`]);
  });

  test("writes only the fields the SDK needs, not whatever the host file held", async () => {
    let written = "";
    await syncContainerCursorSdkCredentials("c", "k", {
      exec: async () => "",
      pipe: async (_id, _command, stdin) => {
        written = stdin;
      },
    });
    expect(Object.keys(JSON.parse(written)).sort()).toEqual([
      "apiKey",
      "backendUrl",
      "createdAtMs",
      "version",
    ]);
  });
});

describe("the credential location", () => {
  test("lives under Orkestrator's data directory, not the SDK default", async () => {
    const credentialPath = cursorSdkCredentialPath(contextWith());
    expect(credentialPath.startsWith(dataDir)).toBe(true);
    expect(credentialPath.endsWith(path.join("cursor-sdk", "auth.json"))).toBe(true);
    await storeCredentials({ version: 1, apiKey: "k" });
    expect(JSON.parse(await readFile(credentialPath, "utf8")).apiKey).toBe("k");
  });
});
