import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BRIDGE_SESSION_REGISTRY_VERSION,
  BridgeSessionStore,
  hashCwd,
} from "./persistence.js";

const temporaryDirectories: string[] = [];

async function makeStore(
  options: { now?: () => number; retentionMs?: number } = {},
) {
  const codexHome = await mkdtemp(join(tmpdir(), "bridge-session-store-"));
  temporaryDirectories.push(codexHome);
  return {
    codexHome,
    store: new BridgeSessionStore({
      codexHome,
      cwd: "/workspace",
      ...options,
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("BridgeSessionStore", () => {
  test("round-trips a valid record and removes it", async () => {
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const { store } = await makeStore({ now: () => now });
    const record = store.toRecord({
      bridgeSessionId: "session-1",
      threadId: "thread-1",
      cwd: "/workspace",
      config: { mode: "build", sandbox: "danger-full-access" },
      title: "A session",
      titleSource: "explicit",
      lastAcceptedRequestId: "request-1",
    });

    await store.upsert(record);
    expect(await store.load()).toEqual([record]);

    await store.remove("session-1");
    expect(await store.load()).toEqual([]);
  });

  test("serializes concurrent upserts without losing either session", async () => {
    const { store } = await makeStore();
    const makeRecord = (id: string) =>
      store.toRecord({
        bridgeSessionId: id,
        threadId: `thread-${id}`,
        cwd: "/workspace",
        config: { mode: "plan", sandbox: "read-only" },
      });

    await Promise.all([
      store.upsert(makeRecord("a")),
      store.upsert(makeRecord("b")),
    ]);
    expect(
      (await store.load()).map((entry) => entry.bridgeSessionId).sort(),
    ).toEqual(["a", "b"]);
  });

  test("retains simultaneous records written by separate processes", async () => {
    const { codexHome, store } = await makeStore();
    const releasePath = join(codexHome, "release-writers");
    const moduleUrl = new URL("./persistence.ts", import.meta.url).href;

    const childScript = (id: string) => `
      import { BridgeSessionStore } from ${JSON.stringify(moduleUrl)};
      const store = new BridgeSessionStore({
        codexHome: ${JSON.stringify(codexHome)},
        cwd: "/workspace",
      });
      await Bun.write(${JSON.stringify(join(codexHome, "ready-"))} + ${JSON.stringify(id)}, "ready");
      while (!(await Bun.file(${JSON.stringify(releasePath)}).exists())) {
        await Bun.sleep(5);
      }
      await store.upsert(store.toRecord({
        bridgeSessionId: ${JSON.stringify(id)},
        threadId: ${JSON.stringify(`thread-${id}`)},
        cwd: "/workspace",
        config: { mode: "build" },
      }));
    `;

    const ids = Array.from({ length: 8 }, (_, index) => `child-${index}`);
    const children = ids.map((id) =>
      Bun.spawn([process.execPath, "-e", childScript(id)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    await Promise.all(
      ids.map((id) => waitForFile(join(codexHome, `ready-${id}`))),
    );

    await writeFile(releasePath, "release", "utf8");
    expect(await Promise.all(children.map((child) => child.exited))).toEqual(
      ids.map(() => 0),
    );
    expect(
      (await store.load()).map((entry) => entry.bridgeSessionId).sort(),
    ).toEqual(ids.sort());
  });

  test("migrates the aggregate v2 registry without overwriting a newer record", async () => {
    const { codexHome, store } = await makeStore();
    const legacyPath = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/workspace")}.json`,
    );
    await mkdir(dirname(legacyPath), { recursive: true });
    const legacy = store.toRecord({
      bridgeSessionId: "shared",
      threadId: "thread-legacy",
      cwd: "/workspace",
      config: { mode: "plan" },
    });
    const newer = {
      ...legacy,
      threadId: "thread-newer",
      config: { mode: "build" as const },
    };
    await store.upsert(newer);
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: BRIDGE_SESSION_REGISTRY_VERSION,
        sessions: [legacy],
      }),
      "utf8",
    );

    expect(await store.load()).toEqual([newer]);
    expect(await Bun.file(legacyPath).exists()).toBe(false);
  });

  test("same-id upsert/remove contention cannot revive a legacy record", async () => {
    const { codexHome, store } = await makeStore();
    const otherStore = new BridgeSessionStore({ codexHome, cwd: "/workspace" });
    const legacyPath = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/workspace")}.json`,
    );
    await mkdir(dirname(legacyPath), { recursive: true });
    const ids = Array.from({ length: 20 }, (_, index) => `shared-${index}`);
    const legacyRecords = ids.map((id) =>
      store.toRecord({
        bridgeSessionId: id,
        threadId: `legacy-${id}`,
        cwd: "/workspace",
        config: { mode: "plan" },
      }),
    );
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: BRIDGE_SESSION_REGISTRY_VERSION,
        sessions: legacyRecords,
      }),
      "utf8",
    );

    await Promise.all(
      ids.flatMap((id) => {
        const newer = store.toRecord({
          bridgeSessionId: id,
          threadId: `newer-${id}`,
          cwd: "/workspace",
          config: { mode: "build" },
        });
        return [store.upsert(newer), otherStore.remove(id)];
      }),
    );

    const loaded = await store.load();
    expect(loaded.every((record) => record.threadId.startsWith("newer-"))).toBe(
      true,
    );
    expect(loaded.some((record) => record.threadId.startsWith("legacy-"))).toBe(
      false,
    );
  });

  test("rejects malformed, expired, foreign-cwd, and old-version records", async () => {
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const { codexHome, store } = await makeStore({
      now: () => now,
      retentionMs: 1_000,
    });
    const path = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/workspace")}.json`,
    );
    await mkdir(dirname(path), { recursive: true });
    const valid = {
      bridgeSessionId: "valid",
      threadId: "thread-valid",
      cwdHash: hashCwd("/workspace"),
      config: { mode: "build" },
      lastAccessed: new Date(now).toISOString(),
    };
    const registry = {
      version: BRIDGE_SESSION_REGISTRY_VERSION,
      sessions: [
        valid,
        { ...valid, bridgeSessionId: "", threadId: "" },
        { ...valid, bridgeSessionId: "bad-config", config: { mode: "unsafe" } },
        { ...valid, bridgeSessionId: "bad-title", titleSource: "model" },
        {
          ...valid,
          bridgeSessionId: "foreign",
          cwdHash: hashCwd("/elsewhere"),
        },
        {
          ...valid,
          bridgeSessionId: "expired",
          lastAccessed: new Date(now - 1_001).toISOString(),
        },
      ],
    };
    await writeFile(path, JSON.stringify(registry), "utf8");

    expect((await store.load()).map((entry) => entry.bridgeSessionId)).toEqual([
      "valid",
    ]);

    await rm(
      join(
        codexHome,
        "orkestrator-bridge",
        `bridge-sessions-${hashCwd("/workspace")}`,
      ),
      { recursive: true, force: true },
    );
    await writeFile(
      path,
      JSON.stringify({ ...registry, version: registry.version + 1 }),
      "utf8",
    );
    expect(await store.load()).toEqual([]);

    await writeFile(path, "{not json", "utf8");
    expect(await store.load()).toEqual([]);
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
