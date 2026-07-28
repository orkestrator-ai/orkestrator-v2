import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
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

function recordsDirFor(codexHome: string): string {
  return join(
    codexHome,
    "orkestrator-bridge",
    `bridge-sessions-${hashCwd("/workspace")}`,
  );
}

function recordPathFor(codexHome: string, bridgeSessionId: string): string {
  return join(
    recordsDirFor(codexHome),
    `${createHash("sha256").update(bridgeSessionId).digest("hex")}.json`,
  );
}

/** Writes a per-session record file directly, so invalid shapes can be exercised. */
async function writeRecordFile(
  codexHome: string,
  bridgeSessionId: string,
  contents: unknown,
): Promise<string> {
  const path = recordPathFor(codexHome, bridgeSessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
  return path;
}

function validRecordFields(bridgeSessionId: string, now: number) {
  return {
    bridgeSessionId,
    threadId: `thread-${bridgeSessionId}`,
    cwdHash: hashCwd("/workspace"),
    config: { mode: "build" },
    lastAccessed: new Date(now).toISOString(),
  };
}

async function captureWarnings<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warnings: number }> {
  const original = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings += 1;
  };
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("BridgeSessionStore", () => {
  test("creates registry directories and records with private permissions", async () => {
    const { codexHome, store } = await makeStore();
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "private",
        threadId: "thread-private",
        cwd: "/workspace",
        config: { mode: "build" },
      }),
    );

    expect((await stat(join(codexHome, "orkestrator-bridge"))).mode & 0o777)
      .toBe(0o700);
    expect((await stat(recordsDirFor(codexHome))).mode & 0o777).toBe(0o700);
    expect((await stat(recordPathFor(codexHome, "private"))).mode & 0o777)
      .toBe(0o600);
  });

  test("tightens permissions on existing directories and records during load", async () => {
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const { codexHome, store } = await makeStore({ now: () => now });
    const recordPath = await writeRecordFile(
      codexHome,
      "existing",
      validRecordFields("existing", now),
    );
    await chmod(join(codexHome, "orkestrator-bridge"), 0o755);
    await chmod(recordsDirFor(codexHome), 0o755);
    await chmod(recordPath, 0o644);

    expect((await store.load()).map((entry) => entry.bridgeSessionId)).toEqual([
      "existing",
    ]);
    expect((await stat(join(codexHome, "orkestrator-bridge"))).mode & 0o777)
      .toBe(0o700);
    expect((await stat(recordsDirFor(codexHome))).mode & 0o777).toBe(0o700);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
  });

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
      confirmedModelsByTurn: { "turn-1": "gpt-rerouted" },
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

  test("tightens permissions while migrating an aggregate registry", async () => {
    const { codexHome, store } = await makeStore();
    const legacyPath = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/workspace")}.json`,
    );
    await mkdir(dirname(legacyPath), { recursive: true, mode: 0o755 });
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: BRIDGE_SESSION_REGISTRY_VERSION,
        sessions: [
          store.toRecord({
            bridgeSessionId: "legacy-private",
            threadId: "thread-legacy-private",
            cwd: "/workspace",
            config: { mode: "plan" },
          }),
        ],
      }),
      { encoding: "utf8", mode: 0o644 },
    );

    expect((await store.load()).map((entry) => entry.bridgeSessionId)).toEqual([
      "legacy-private",
    ]);
    expect((await stat(join(codexHome, "orkestrator-bridge"))).mode & 0o777)
      .toBe(0o700);
    expect((await stat(recordsDirFor(codexHome))).mode & 0o777).toBe(0o700);
    expect(
      (await stat(recordPathFor(codexHome, "legacy-private"))).mode & 0o777,
    ).toBe(0o600);
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

    await writeFile(
      path,
      JSON.stringify({
        version: BRIDGE_SESSION_REGISTRY_VERSION,
        sessions: { valid },
      }),
      "utf8",
    );
    expect(await store.load()).toEqual([]);
  });

  test("skips corrupt, foreign-cwd and expired per-session record files", async () => {
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const { codexHome, store } = await makeStore({
      now: () => now,
      retentionMs: 1_000,
    });

    await writeRecordFile(codexHome, "valid", validRecordFields("valid", now));
    await writeRecordFile(codexHome, "corrupt", "{not json");
    await writeRecordFile(codexHome, "empty-file", "");
    await writeRecordFile(codexHome, "foreign", {
      ...validRecordFields("foreign", now),
      cwdHash: hashCwd("/elsewhere"),
    });
    await writeRecordFile(codexHome, "expired", {
      ...validRecordFields("expired", now),
      lastAccessed: new Date(now - 1_001).toISOString(),
    });
    await writeRecordFile(codexHome, "undated", {
      ...validRecordFields("undated", now),
      lastAccessed: "whenever",
    });
    await writeRecordFile(codexHome, "primitive", 42);

    expect((await store.load()).map((entry) => entry.bridgeSessionId)).toEqual([
      "valid",
    ]);
  });

  test("accepts every legal turn config and rejects each malformed field", async () => {
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const { codexHome, store } = await makeStore({ now: () => now });

    const legal: Record<string, unknown> = {
      "mode-build": { mode: "build" },
      "mode-plan": { mode: "plan" },
      model: { mode: "build", model: "gpt-5" },
      effort: { mode: "build", reasoningEffort: "high" },
      tier: { mode: "build", serviceTier: "fast" },
      // null is meaningful: it clears a previously set tier rather than inheriting.
      "tier-null": { mode: "build", serviceTier: null },
      cwd: { mode: "build", cwd: "/workspace" },
      "sandbox-read-only": { mode: "build", sandbox: "read-only" },
      "sandbox-workspace-write": { mode: "build", sandbox: "workspace-write" },
      "sandbox-danger": { mode: "build", sandbox: "danger-full-access" },
      "approval-never": { mode: "build", approvalPolicy: "never" },
      "approval-on-request": { mode: "build", approvalPolicy: "on-request" },
      "approval-untrusted": { mode: "build", approvalPolicy: "untrusted" },
      "network-on": { mode: "build", networkAccessEnabled: true },
      "network-off": { mode: "build", networkAccessEnabled: false },
    };
    const illegal: Record<string, unknown> = {
      "bad-mode": { mode: "review" },
      "missing-mode": {},
      "null-config": null,
      "primitive-config": "build",
      "bad-model": { mode: "build", model: 5 },
      "bad-effort": { mode: "build", reasoningEffort: { level: "high" } },
      "bad-tier": { mode: "build", serviceTier: 1 },
      "bad-cwd": { mode: "build", cwd: ["/workspace"] },
      "bad-sandbox": { mode: "build", sandbox: "workspace-read" },
      "bad-approval": { mode: "build", approvalPolicy: "always" },
      "bad-network": { mode: "build", networkAccessEnabled: "true" },
    };

    for (const [id, config] of Object.entries({ ...legal, ...illegal })) {
      await writeRecordFile(codexHome, id, {
        ...validRecordFields(id, now),
        config,
      });
    }

    const loaded = (await store.load()).map((entry) => entry.bridgeSessionId);
    expect(loaded.sort()).toEqual(Object.keys(legal).sort());
  });

  test("treats a record as deleted only when the tombstone carries a real date", async () => {
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const { codexHome, store } = await makeStore({ now: () => now });

    // A half-written tombstone must not silently hide a live session: without a
    // usable deletedAt there is nothing to retire it against, so the record wins.
    await writeRecordFile(codexHome, "no-date", {
      ...validRecordFields("no-date", now),
      deleted: true,
    });
    await writeRecordFile(codexHome, "bad-date", {
      ...validRecordFields("bad-date", now),
      deleted: true,
      deletedAt: "not a date",
    });
    await writeRecordFile(codexHome, "not-flagged", {
      ...validRecordFields("not-flagged", now),
      deleted: "true",
      deletedAt: new Date(now).toISOString(),
    });
    await writeRecordFile(codexHome, "real", {
      bridgeSessionId: "real",
      deleted: true,
      deletedAt: new Date(now).toISOString(),
    });

    expect(
      (await store.load()).map((entry) => entry.bridgeSessionId).sort(),
    ).toEqual(["bad-date", "no-date", "not-flagged"]);
  });

  test("re-creating a removed session id round-trips through the tombstone", async () => {
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const { store } = await makeStore({ now: () => now });
    const record = store.toRecord({
      bridgeSessionId: "session-1",
      threadId: "thread-1",
      cwd: "/workspace",
      config: { mode: "build" },
    });

    await store.upsert(record);
    await store.remove("session-1");
    expect(await store.load()).toEqual([]);

    const revived = { ...record, threadId: "thread-2" };
    await store.upsert(revived);
    expect(await store.load()).toEqual([revived]);
  });

  test("warns and cleans up when the atomic rename cannot publish a record", async () => {
    const { codexHome, store } = await makeStore();
    const recordsDir = recordsDirFor(codexHome);
    // A non-empty directory sitting on the record path makes rename fail after
    // the temp file has already been written.
    await mkdir(recordPathFor(codexHome, "blocked"), { recursive: true });
    await writeFile(join(recordPathFor(codexHome, "blocked"), "x"), "x", "utf8");

    const { warnings } = await captureWarnings(() =>
      store.upsert(
        store.toRecord({
          bridgeSessionId: "blocked",
          threadId: "thread-blocked",
          cwd: "/workspace",
          config: { mode: "build" },
        }),
      ),
    );

    expect(warnings).toBe(1);
    expect(
      (await readdir(recordsDir)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("a failing legacy migration warns instead of failing load", async () => {
    const { codexHome, store } = await makeStore();
    const legacyPath = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/workspace")}.json`,
    );
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: BRIDGE_SESSION_REGISTRY_VERSION,
        sessions: [
          store.toRecord({
            bridgeSessionId: "legacy",
            threadId: "thread-legacy",
            cwd: "/workspace",
            config: { mode: "plan" },
          }),
        ],
      }),
      "utf8",
    );

    // Stands in for the non-EEXIST `link` failure migrateLegacy deliberately
    // rethrows. It must not escape: load() runs before the engine starts and
    // nothing retries it, so a throw here leaves app-server unstarted forever.
    Object.defineProperty(store, "migrateLegacy", {
      value: () =>
        Promise.reject(
          Object.assign(new Error("EPERM: operation not permitted, link"), {
            code: "EPERM",
          }),
        ),
    });

    const { result, warnings } = await captureWarnings(() => store.load());
    expect(warnings).toBe(1);
    // The in-memory legacy entries are still served for this run even though they
    // could not be republished as per-session records.
    expect(result.map((entry) => entry.bridgeSessionId)).toEqual(["legacy"]);
  });

  test("a read-only records directory is tightened before migration", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const { codexHome, store } = await makeStore();
    const recordsDir = recordsDirFor(codexHome);
    await mkdir(recordsDir, { recursive: true });
    const legacyPath = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/workspace")}.json`,
    );
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: BRIDGE_SESSION_REGISTRY_VERSION,
        sessions: [
          store.toRecord({
            bridgeSessionId: "legacy",
            threadId: "thread-legacy",
            cwd: "/workspace",
            config: { mode: "plan" },
          }),
        ],
      }),
      "utf8",
    );
    await chmod(recordsDir, 0o555);

    try {
      const { result, warnings } = await captureWarnings(() => store.load());
      expect(warnings).toBe(0);
      expect(result.map((entry) => entry.bridgeSessionId)).toEqual(["legacy"]);
      expect((await stat(recordsDir)).mode & 0o777).toBe(0o700);
    } finally {
      await chmod(recordsDir, 0o755);
    }
  });

  test("collects expired tombstones and abandoned temp files", async () => {
    let clock = Date.now();
    const { codexHome, store } = await makeStore({
      now: () => clock,
      retentionMs: 1_000,
    });
    const recordsDir = recordsDirFor(codexHome);
    const ids = Array.from({ length: 5 }, (_, index) => `session-${index}`);

    for (const id of ids) {
      await store.upsert(
        store.toRecord({
          bridgeSessionId: id,
          threadId: `thread-${id}`,
          cwd: "/workspace",
          config: { mode: "build" },
        }),
      );
      await store.remove(id);
    }
    await writeFile(join(recordsDir, "orphan.json.123.abc.tmp"), "{}", "utf8");
    expect((await readdir(recordsDir)).length).toBe(ids.length + 1);

    clock += 2 * 60 * 60 * 1000;
    expect(await store.load()).toEqual([]);
    // Without collection every session ever created would leave a file here.
    expect(await readdir(recordsDir)).toEqual([]);
  });

  test("keeps tombstones and temp files that are still within their windows", async () => {
    const { codexHome, store } = await makeStore({ retentionMs: 60 * 60 * 1000 });
    const recordsDir = recordsDirFor(codexHome);

    await store.upsert(
      store.toRecord({
        bridgeSessionId: "fresh",
        threadId: "thread-fresh",
        cwd: "/workspace",
        config: { mode: "build" },
      }),
    );
    await store.remove("fresh");
    const temporary = join(recordsDir, "inflight.json.123.abc.tmp");
    await writeFile(temporary, "{}", { encoding: "utf8", mode: 0o644 });

    expect(await store.load()).toEqual([]);
    // A live tombstone still shields against legacy resurrection, and a temp file
    // this young may belong to a writer that is mid-rename in another process.
    expect((await readdir(recordsDir)).sort()).toEqual(
      [
        "inflight.json.123.abc.tmp",
        `${createHash("sha256").update("fresh").digest("hex")}.json`,
      ].sort(),
    );
    expect((await stat(temporary)).mode & 0o777).toBe(0o600);
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
