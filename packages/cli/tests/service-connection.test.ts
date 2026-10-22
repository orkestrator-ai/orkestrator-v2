import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  overrides: { generation?: string; pid?: number; browserUrl?: string } = {},
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
