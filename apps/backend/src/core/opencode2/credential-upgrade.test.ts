import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import {
  openCode2LegacyReconcileMarker,
  reconcileLegacyOpenCodeLoginsBestEffort,
  reconcileLegacyOpenCodeLoginsOnce,
} from "./credential-upgrade.js";
import { openCode2RefreshFingerprint, openCode2RefreshLineageFile } from "./credentials.js";

// Fake values only; nothing here is a real credential.
const FILE_KEY = "sk-fake-file-key";
const STORE_KEY = "sk-fake-store-key";

let server: FakeOpenCode2Server | undefined;
let dir: string | undefined;
afterEach(async () => {
  server?.stop();
  server = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fixture(contents: unknown) {
  dir = await mkdtemp(path.join(tmpdir(), "ork-oc2-upgrade-"));
  const dataDir = path.join(dir, "data");
  const authFile = path.join(dir, "opencode", "auth.json");
  await mkdir(path.dirname(authFile), { recursive: true });
  if (contents !== undefined) await writeFile(authFile, JSON.stringify(contents));
  server = new FakeOpenCode2Server();
  return { dataDir, authFile, lineageFile: openCode2RefreshLineageFile(dataDir), fake: server };
}

function seed(fake: FakeOpenCode2Server, integrationID: string, value: unknown) {
  fake.credentials.push({
    id: `cred_${fake.credentials.length}`,
    integrationID,
    label: "x",
    active: true,
    value,
  });
}

function byIntegration(fake: FakeOpenCode2Server) {
  return Object.fromEntries(fake.credentials.map((entry) => [entry.integrationID, entry.value]));
}

describe("the one-time reconcile of a database from before 1.x was retired", () => {
  test("the database matches auth.json once, and is not reconciled again", async () => {
    const { dataDir, authFile, lineageFile, fake } = await fixture({
      // Signed in through 1.x while the preview was off: absent from the database.
      anthropic: { type: "api", key: FILE_KEY },
      // Changed through 1.x since the database imported it.
      "opencode-go": { type: "api", key: FILE_KEY },
    });
    // Signed out through 1.x since: still in the database.
    seed(fake, "openai", { type: "key", key: STORE_KEY });
    seed(fake, "opencode-go", { type: "key", key: STORE_KEY });
    // A login auth.json cannot hold stays.
    seed(fake, "amazon-bedrock", { type: "external", profile: "default" });

    const outcome = await reconcileLegacyOpenCodeLoginsOnce(fake.client(), {
      authFile,
      dataDir,
      lineageFile,
    });
    expect(outcome).toBe("reconciled");
    expect(byIntegration(fake)).toEqual({
      anthropic: { type: "key", key: FILE_KEY },
      "opencode-go": { type: "key", key: FILE_KEY },
      "amazon-bedrock": { type: "external", profile: "default" },
    });
    expect(fake.credentials.filter((entry) => entry.integrationID === "opencode-go")).toHaveLength(
      1,
    );
    expect(existsSync(openCode2LegacyReconcileMarker(dataDir))).toBe(true);

    // Later changes are the database's own; a second start leaves them.
    seed(fake, "xai", { type: "key", key: STORE_KEY });
    expect(
      await reconcileLegacyOpenCodeLoginsOnce(fake.client(), { authFile, dataDir, lineageFile }),
    ).toBe("already-reconciled");
    expect(byIntegration(fake).xai).toEqual({ type: "key", key: STORE_KEY });
    // The marker and logs carry no credential.
    expect(await readFile(openCode2LegacyReconcileMarker(dataDir), "utf8")).not.toContain(FILE_KEY);
  });

  test("an OAuth login 2.x refreshed since is kept when it is the file's own login", async () => {
    const { dataDir, authFile, lineageFile, fake } = await fixture({
      openai: { type: "oauth", refresh: "r1", access: "a1", expires: 100, accountId: "acct" },
      anthropic: { type: "oauth", refresh: "same", access: "old", expires: 100 },
      xai: { type: "oauth", refresh: "file", access: "file", expires: 100 },
    });
    const refreshed = {
      type: "oauth",
      methodID: "chatgpt-browser",
      refresh: "r2",
      access: "a2",
      expires: 900,
      metadata: { accountID: "acct" },
    };
    seed(fake, "openai", refreshed);
    const anthropic = {
      type: "oauth",
      methodID: "oauth",
      refresh: "same",
      access: "new",
      expires: 900,
    };
    seed(fake, "anthropic", anthropic);
    // A newer login that cannot be shown to be the file's: the file wins, as before.
    seed(fake, "xai", {
      type: "oauth",
      methodID: "device",
      refresh: "db",
      access: "db",
      expires: 900,
    });

    await reconcileLegacyOpenCodeLoginsOnce(fake.client(), { authFile, dataDir, lineageFile });
    expect(byIntegration(fake)).toEqual({
      openai: refreshed,
      anthropic,
      xai: { type: "oauth", methodID: "device", refresh: "file", access: "file", expires: 100 },
    });
    // What the database holds now is its lineage, so the refresh export can move the file forward.
    const lineage = await readFile(lineageFile, "utf8");
    expect(lineage).toContain(openCode2RefreshFingerprint("r2"));
    expect(lineage).toContain(openCode2RefreshFingerprint("file"));
  });

  test("an unreadable auth.json changes nothing and is retried at the next start", async () => {
    const { dataDir, authFile, lineageFile, fake } = await fixture(undefined);
    await writeFile(authFile, "{not json");
    seed(fake, "openai", { type: "key", key: STORE_KEY });
    await reconcileLegacyOpenCodeLoginsBestEffort(fake.client(), {
      authFile,
      dataDir,
      lineageFile,
    });
    expect(byIntegration(fake)).toEqual({ openai: { type: "key", key: STORE_KEY } });
    expect(existsSync(openCode2LegacyReconcileMarker(dataDir))).toBe(false);

    await writeFile(authFile, JSON.stringify({ openai: { type: "api", key: FILE_KEY } }));
    expect(
      await reconcileLegacyOpenCodeLoginsOnce(fake.client(), { authFile, dataDir, lineageFile }),
    ).toBe("reconciled");
    expect(byIntegration(fake)).toEqual({ openai: { type: "key", key: FILE_KEY } });
  });

  test("concurrent first users share one reconcile of the same data directory", async () => {
    const { dataDir, authFile, lineageFile, fake } = await fixture({
      anthropic: { type: "api", key: FILE_KEY },
    });
    // Two servers on one database: each caller has its own client.
    const posts: string[] = [];
    const counted = () => {
      const client = fake.client();
      const api = client.api.bind(client);
      client.api = ((method: string, route: string, ...rest: unknown[]) => {
        if (method === "POST") posts.push(route);
        return (api as (...args: unknown[]) => Promise<unknown>)(method, route, ...rest);
      }) as typeof client.api;
      return client;
    };
    const outcomes = await Promise.all([
      reconcileLegacyOpenCodeLoginsOnce(counted(), { authFile, dataDir, lineageFile }),
      reconcileLegacyOpenCodeLoginsOnce(counted(), { authFile, dataDir, lineageFile }),
    ]);
    expect(outcomes).toEqual(["reconciled", "reconciled"]);
    expect(posts).toEqual(["/api/credential"]);
    expect(fake.credentials).toHaveLength(1);
    // Settled: the next caller reads the marker rather than joining a run.
    expect(
      await reconcileLegacyOpenCodeLoginsOnce(counted(), { authFile, dataDir, lineageFile }),
    ).toBe("already-reconciled");
  });

  test("a missing auth.json signs the database out of what the file could hold", async () => {
    const { dataDir, authFile, fake } = await fixture(undefined);
    seed(fake, "openai", { type: "key", key: STORE_KEY });
    expect(await reconcileLegacyOpenCodeLoginsOnce(fake.client(), { authFile, dataDir })).toBe(
      "reconciled",
    );
    expect(fake.credentials).toEqual([]);
  });
});
