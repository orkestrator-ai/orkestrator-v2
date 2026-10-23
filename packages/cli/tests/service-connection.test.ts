import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackendInstanceDescriptor } from "@orkestrator/protocol/backend-instance";
import {
  awaitServiceConnection,
  currentDescriptorGeneration,
} from "../src/client/service-connection.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const TOKEN = "service-token-0123456789abcdef";

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-service-connection-"));
  roots.push(root);
  return root;
}

async function publish(
  dataDir: string,
  overrides: Partial<BackendInstanceDescriptor> = {},
): Promise<string> {
  const authFile = path.join(dataDir, "gateway-auth.json");
  await writeFile(authFile, `${JSON.stringify({ token: TOKEN })}\n`, { mode: 0o600 });
  await writeFile(
    path.join(dataDir, "backend-instance.json"),
    JSON.stringify({
      version: 1,
      type: "orkestrator-backend-instance",
      installationId: "install-1",
      generation: overrides.generation ?? "gen-2",
      pid: overrides.pid ?? process.pid,
      startedAt: new Date().toISOString(),
      url: "http://127.0.0.1:40000",
      browserUrl: overrides.browserUrl ?? "https://host.tailnet.ts.net",
      authFile,
      dataDir,
      appVersion: "2.26.3-beta",
      publicApiSchemaVersion: 1,
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return authFile;
}

/** Observation options that never really sleep: the deadline passes at once. */
function instant() {
  let clock = 0;
  return {
    timeoutMs: 1_000,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

describe("service connection", () => {
  test.each([
    { url: "http://100.64.0.10:4317", endpoints: [], expected: "http://100.64.0.10:4317" },
    { url: "http://100.64.0.10:4317", expected: "http://100.64.0.10:4317" },
    { url: "http://127.0.0.1:40000", expected: null },
    {
      url: "http://127.0.0.1:40000",
      endpoints: [{ role: "control" as const, url: "http://127.0.0.1:40000" }],
      expected: null,
    },
    {
      url: "http://127.0.0.1:34125",
      endpoints: [{ role: "client" as const, url: "http://127.0.0.1:34125" }],
      expected: null,
    },
  ])(
    "resolves a primary address by endpoint semantics: %j",
    async ({ expected, ...descriptor }) => {
      const dataDir = await dataDirectory();
      await publish(dataDir, {
        ...descriptor,
        endpoints: descriptor.endpoints ? [...descriptor.endpoints] : undefined,
        browserUrl: undefined,
      });
      expect((await awaitServiceConnection(dataDir, null, instant()))?.browserUrl).toBe(expected);
    },
  );

  test.each(["permissions", "missing", "malformed", "invalid"])(
    "keeps readiness and auth path on %s credentials",
    async (failure) => {
      const dataDir = await dataDirectory();
      const authFile = await publish(dataDir);
      if (failure === "permissions")
        await (await import("node:fs/promises")).chmod(authFile, 0o644);
      if (failure === "missing") await rm(authFile);
      if (failure === "malformed") await writeFile(authFile, "{broken-json");
      if (failure === "invalid") await writeFile(authFile, '{"token":"short"}');
      const result = await awaitServiceConnection(dataDir, null, instant());
      expect(result).toMatchObject({
        browserUrl: "https://host.tailnet.ts.net",
        authFile,
        token: null,
      });
      expect(result?.credentialError).toBeString();
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    },
  );

  test.each(["SIGINT", "SIGTERM"])("propagates %s while waiting", async (name) => {
    const dataDir = await dataDirectory();
    const controller = new AbortController();
    await expect(
      awaitServiceConnection(dataDir, null, {
        timeoutMs: 1000,
        signal: controller.signal,
        sleep: async () => {
          controller.abort(name);
        },
      }),
    ).rejects.toMatchObject({ code: "observation-interrupted" });
  });

  test("ignores a descriptor from another data directory", async () => {
    const dataDir = await dataDirectory();
    await publish(dataDir, { dataDir: path.join(dataDir, "other") });
    expect(await awaitServiceConnection(dataDir, null, instant())).toBeNull();
  });
  test("reads the address and token once a new generation is published", async () => {
    const dataDir = await dataDirectory();
    const authFile = await publish(dataDir);
    expect(await awaitServiceConnection(dataDir, "gen-1", instant())).toEqual({
      browserUrl: "https://host.tailnet.ts.net",
      authFile,
      token: TOKEN,
    });
  });

  test("ignores the generation that was running before the install", async () => {
    const dataDir = await dataDirectory();
    await publish(dataDir, { generation: "gen-1" });
    expect(await currentDescriptorGeneration(dataDir)).toBe("gen-1");
    expect(await awaitServiceConnection(dataDir, "gen-1", instant())).toBeNull();
  });

  test("ignores a descriptor whose process has exited", async () => {
    const dataDir = await dataDirectory();
    await publish(dataDir, { pid: 2_147_483_646 });
    expect(await awaitServiceConnection(dataDir, null, instant())).toBeNull();
  });

  test("returns null when nothing is published in time", async () => {
    const dataDir = await dataDirectory();
    expect(await currentDescriptorGeneration(dataDir)).toBeNull();
    expect(await awaitServiceConnection(dataDir, null, instant())).toBeNull();
  });
});
