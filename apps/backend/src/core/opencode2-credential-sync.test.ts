import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { mirrorOpenCodeLoginToOpenCode2 } from "./opencode2-credential-sync.js";
import { FakeOpenCode2Server } from "./opencode2/fake-server.test-support.js";
import { openCode2HostPaths } from "./opencode2/server.js";

// Fake values only.
const FAKE_KEY = "sk-fake-mirror-sync-key";

let root: string | undefined;
let server: FakeOpenCode2Server | undefined;
afterEach(async () => {
  server?.stop();
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup(options: { database: boolean }) {
  root = await mkdtemp(path.join(tmpdir(), "ork-oc2-sync-"));
  const dataDir = path.join(root, "data");
  if (options.database) {
    const { database } = openCode2HostPaths(dataDir);
    await mkdir(path.dirname(database), { recursive: true });
    await writeFile(database, "");
  }
  const authFile = path.join(root, "auth.json");
  server = new FakeOpenCode2Server();
  const fake = server;
  const used: string[] = [];
  const context = {
    storage: {
      getDataDir: () => dataDir,
      loadConfig: async () => ({ global: { openCodeProtocol: "v2" } }),
    },
    runtime: { localServers: { openCode2: { live: () => [] } } },
  } as unknown as CommandContext;
  const dependencies = {
    authFile,
    withServer: async <T>(_context: CommandContext, use: (client: never) => Promise<T>) => {
      used.push("server");
      return use(fake.client() as never);
    },
  };
  return { context, authFile, server: fake, used, dependencies };
}

describe("mirrorOpenCodeLoginToOpenCode2", () => {
  test("without a 2.x database there is nothing to mirror: its first start imports auth.json", async () => {
    const { context, used, dependencies } = await setup({ database: false });
    expect(await mirrorOpenCodeLoginToOpenCode2(context, "opencode-go", dependencies)).toBe(
      "skipped",
    );
    expect(used).toEqual([]);
  });

  test("copies the provider's new entry, then its removal", async () => {
    const { context, authFile, server, dependencies } = await setup({ database: true });
    await writeFile(authFile, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    expect(await mirrorOpenCodeLoginToOpenCode2(context, "opencode-go", dependencies)).toBe(
      "written",
    );
    expect(server.credentials).toMatchObject([
      { integrationID: "opencode-go", active: true, value: { type: "key", key: FAKE_KEY } },
    ]);
    await writeFile(authFile, JSON.stringify({}));
    expect(await mirrorOpenCodeLoginToOpenCode2(context, "opencode-go", dependencies)).toBe(
      "removed",
    );
    expect(server.credentials).toEqual([]);
  });

  test("an unreadable store fails the mirror instead of signing 2.x out", async () => {
    const { context, authFile, server, dependencies, used } = await setup({ database: true });
    server.credentials.push({
      id: "cred_keep",
      integrationID: "opencode-go",
      label: "API key",
      active: true,
      value: {},
    });
    await writeFile(authFile, "{broken");
    await expect(
      mirrorOpenCodeLoginToOpenCode2(context, "opencode-go", dependencies),
    ).rejects.toThrow();
    expect(used).toEqual([]);
    expect(server.credentials.map((credential) => credential.id)).toEqual(["cred_keep"]);
  });
});

test("legacy sign-in skips an offline 2.x mirror even with an existing database and missing binary", async () => {
  const { context, dependencies, used } = await setup({ database: true });
  context.storage.loadConfig = async () => ({ global: { openCodeProtocol: "legacy" } }) as never;
  dependencies.withServer = async () => {
    throw new Error("missing opencode2 binary");
  };
  expect(await mirrorOpenCodeLoginToOpenCode2(context, "openai", dependencies)).toBe("skipped");
  expect(used).toEqual([]);
});
