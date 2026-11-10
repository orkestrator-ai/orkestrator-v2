import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BridgeSessionStore, hashCwd } from "./persistence.js";

/**
 * `loadRecord` (BR-2): one session's record, read without the listing,
 * migration, adoption and sweep `load()` performs, and answering exactly what
 * `load()` would answer for that session.
 */

const temporaryDirectories: string[] = [];
const NOW = Date.parse("2026-11-03T09:00:00.000Z");
const RETENTION_MS = 24 * 60 * 60 * 1000;
const savedStateDir = process.env.CODEX_BRIDGE_STATE_DIR;

afterEach(async () => {
  if (savedStateDir === undefined) delete process.env.CODEX_BRIDGE_STATE_DIR;
  else process.env.CODEX_BRIDGE_STATE_DIR = savedStateDir;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "bridge-session-record-"));
  temporaryDirectories.push(codexHome);
  return codexHome;
}

function storeFor(codexHome: string): BridgeSessionStore {
  return new BridgeSessionStore({
    codexHome,
    cwd: "/workspace",
    now: () => NOW,
    retentionMs: RETENTION_MS,
  });
}

function recordsDirFor(stateDir: string): string {
  return join(stateDir, `bridge-sessions-${hashCwd("/workspace")}`);
}

function recordPathFor(stateDir: string, bridgeSessionId: string): string {
  return join(
    recordsDirFor(stateDir),
    `${createHash("sha256").update(bridgeSessionId).digest("hex")}.json`,
  );
}

async function writeJson(path: string, contents: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

function validRecord(bridgeSessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    bridgeSessionId,
    threadId: `thread-${bridgeSessionId}`,
    cwdHash: hashCwd("/workspace"),
    config: { mode: "build" },
    lastAccessed: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("BridgeSessionStore.loadRecord", () => {
  test("reads one record file out of fifty, with no listing, chmod or write", async () => {
    const codexHome = await temporaryHome();
    const stateDir = join(codexHome, "orkestrator-bridge");
    for (let index = 0; index < 50; index += 1) {
      await writeJson(recordPathFor(stateDir, `session-${index}`), validRecord(`session-${index}`));
    }
    const store = storeFor(codexHome);
    const load = spyOn(store, "load");
    const spies = {
      readFile: spyOn(fsPromises, "readFile"),
      readdir: spyOn(fsPromises, "readdir"),
      chmod: spyOn(fsPromises, "chmod"),
      mkdir: spyOn(fsPromises, "mkdir"),
      writeFile: spyOn(fsPromises, "writeFile"),
      rename: spyOn(fsPromises, "rename"),
      link: spyOn(fsPromises, "link"),
      rm: spyOn(fsPromises, "rm"),
    };
    try {
      const record = await store.loadRecord("session-17");

      expect(record?.threadId).toBe("thread-session-17");
      expect(spies.readFile.mock.calls.map(([path]) => path)).toEqual([
        recordPathFor(stateDir, "session-17"),
      ]);
      for (const name of ["readdir", "chmod", "mkdir", "writeFile", "rename", "link", "rm"]) {
        expect({ name, calls: spies[name as keyof typeof spies].mock.calls.length }).toEqual({
          name,
          calls: 0,
        });
      }
      expect(load).not.toHaveBeenCalled();
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
      load.mockRestore();
    }
  });

  test("answers what load() answers for every kind of record", async () => {
    const codexHome = await temporaryHome();
    const stateDir = join(codexHome, "orkestrator-bridge");
    const write = (id: string, contents: unknown) =>
      writeJson(recordPathFor(stateDir, id), contents);
    await write("valid", validRecord("valid", { config: { mode: "plan", model: "gpt-5.5" } }));
    await write("tombstoned", {
      bridgeSessionId: "tombstoned",
      deleted: true,
      deletedAt: new Date(NOW).toISOString(),
    });
    await write("expired-tombstone", {
      bridgeSessionId: "expired-tombstone",
      deleted: true,
      deletedAt: new Date(NOW - 2 * RETENTION_MS).toISOString(),
    });
    await write(
      "expired",
      validRecord("expired", { lastAccessed: new Date(NOW - 2 * RETENTION_MS).toISOString() }),
    );
    await write("other-cwd", validRecord("other-cwd", { cwdHash: hashCwd("/elsewhere") }));
    await write("bad-config", validRecord("bad-config", { config: { mode: "neither" } }));
    await write("corrupt", "{not json");
    await write("someone-else", validRecord("not-someone-else"));

    const ids = [
      "valid",
      "tombstoned",
      "expired-tombstone",
      "expired",
      "other-cwd",
      "bad-config",
      "corrupt",
      "someone-else",
      "never-written",
    ];
    const store = storeFor(codexHome);
    const before = await Promise.all(ids.map((id) => store.loadRecord(id)));
    const loaded = await store.load();
    const after = await Promise.all(ids.map((id) => store.loadRecord(id)));
    const expected = ids.map(
      (id) => loaded.find((record) => record.bridgeSessionId === id) ?? null,
    );

    expect(before).toEqual(expected);
    expect(after).toEqual(expected);
    expect(
      Object.fromEntries(ids.map((id, index) => [id, expected[index]?.threadId ?? null])),
    ).toEqual({
      valid: "thread-valid",
      tombstoned: null,
      "expired-tombstone": null,
      expired: null,
      "other-cwd": null,
      "bad-config": null,
      corrupt: null,
      "someone-else": null,
      "never-written": null,
    });
  });

  test("finds a record an account kept in its own home, as load() would adopt it", async () => {
    const root = await temporaryHome();
    const host = join(root, "host-codex");
    const account = join(root, "account-codex");
    const shared = join(host, "orkestrator-bridge");
    const accountDir = join(account, "orkestrator-bridge");
    await writeJson(recordPathFor(accountDir, "account-only"), validRecord("account-only"));
    await writeJson(recordPathFor(accountDir, "closed"), validRecord("closed"));
    await writeJson(recordPathFor(shared, "closed"), {
      bridgeSessionId: "closed",
      deleted: true,
      deletedAt: new Date(NOW).toISOString(),
    });

    process.env.CODEX_BRIDGE_STATE_DIR = shared;
    const store = storeFor(account);
    const before = [await store.loadRecord("account-only"), await store.loadRecord("closed")];
    // Nothing was moved by the read.
    expect(await Bun.file(recordPathFor(accountDir, "account-only")).exists()).toBe(true);

    const loaded = await store.load();
    expect(before).toEqual([
      loaded.find((record) => record.bridgeSessionId === "account-only") ?? null,
      null,
    ]);
    expect(before[0]?.threadId).toBe("thread-account-only");
  });
});
