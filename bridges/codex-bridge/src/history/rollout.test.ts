import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildTranscriptCatalog,
  buildTranscriptCatalogCachedForTesting,
  clearTranscriptPathCache,
  getTranscriptPathCacheStats,
  invalidateTranscriptCatalogCache,
  setTranscriptCatalogBuilderForTesting,
  setTranscriptCatalogNowForTesting,
  setTranscriptCatalogTtlForTesting,
  setTranscriptPathCacheLimitsForTesting,
  createSharedTranscriptMetaLoader,
  extractPersistedMessageContent,
  extractPersistedMessageText,
  findTranscriptPath,
  getCodexHomeDir,
  getPersistedSessionMeta,
  getSessionMetaFromTranscriptPath,
  hydrateMessagesFromPersistedSession,
  getWorkingDirectory,
  listTranscriptPaths,
  listPersistedSessionsForCwd,
  listPersistedSessionsWithTitlesForCwd,
  mergePersistedSessionMeta,
  readTranscriptLines,
} from "./rollout.js";
import { persistSessionTitle } from "../session-titles.js";
import {
  clearTranscriptCache,
  getTranscriptCacheStats,
} from "../transcript-cache.js";

const temporaryDirectories: string[] = [];

async function temporaryRollout(threadId: string, lines: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rollout-test-"));
  temporaryDirectories.push(root);
  const path = join(root, "sessions", `${threadId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

function sessionMeta(threadId: string): unknown {
  return {
    type: "session_meta",
    payload: { id: threadId, cwd: "/workspace", timestamp: "2026-07-25T12:00:00.000Z" },
  };
}

/**
 * Writes a rollout, points `CODEX_HOME`/`CWD` at it for one hydration, and
 * restores both. One hydration per call: the transcript path cache is keyed
 * globally and only cleared in `afterEach`.
 */
async function hydrateRollout(
  threadId: string,
  lines: unknown[],
  /** Overridable so a rollout carrying no `cwd` can be told apart from one that does. */
  processCwd = "/workspace",
): Promise<Awaited<ReturnType<typeof hydrateMessagesFromPersistedSession>>> {
  const path = await temporaryRollout(threadId, lines);
  const previousHome = process.env.CODEX_HOME;
  const previousCwd = process.env.CWD;
  process.env.CODEX_HOME = dirname(dirname(path));
  process.env.CWD = processCwd;
  try {
    return await hydrateMessagesFromPersistedSession(threadId);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousCwd === undefined) delete process.env.CWD;
    else process.env.CWD = previousCwd;
  }
}

afterEach(async () => {
  clearTranscriptPathCache();
  clearTranscriptCache();
  setTranscriptPathCacheLimitsForTesting();
  invalidateTranscriptCatalogCache();
  setTranscriptCatalogBuilderForTesting();
  setTranscriptCatalogNowForTesting();
  setTranscriptCatalogTtlForTesting();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("rollout public helpers", () => {
  test("resolves Codex home and working-directory overrides with fallbacks", () => {
    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home-override";
      process.env.CWD = "/tmp/codex-cwd-override";
      expect(getCodexHomeDir()).toBe("/tmp/codex-home-override");
      expect(getWorkingDirectory()).toBe("/tmp/codex-cwd-override");
      expect(getWorkingDirectory("/tmp/explicit-cwd")).toBe("/tmp/explicit-cwd");

      delete process.env.CODEX_HOME;
      delete process.env.CWD;
      expect(getCodexHomeDir()).toBe(join(homedir(), ".codex"));
      expect(getWorkingDirectory()).toBe(process.cwd());
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  test("lists nested active and archived JSONL transcripts only", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-list-"));
    temporaryDirectories.push(root);
    const active = join(root, "sessions", "2026", "active.jsonl");
    const archived = join(root, "archived_sessions", "archived.jsonl");
    await mkdir(dirname(active), { recursive: true });
    await mkdir(dirname(archived), { recursive: true });
    await writeFile(active, "{}\n", "utf8");
    await writeFile(archived, "{}\n", "utf8");
    await writeFile(join(root, "sessions", "ignored.txt"), "not a rollout", "utf8");

    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      expect((await listTranscriptPaths()).sort()).toEqual([active, archived].sort());
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("finds supplied transcript paths without scanning global state", async () => {
    expect(await findTranscriptPath("thread-2", ["/a/thread-1.jsonl", "/b/thread-2.jsonl"]))
      .toBe("/b/thread-2.jsonl");
    expect(await findTranscriptPath("missing", ["/a/thread-1.jsonl"])).toBeNull();
  });

  test("an explicit array snapshot is never cached", async () => {
    expect(await findTranscriptPath("thread-9", ["/a/thread-9.jsonl"])).toBe("/a/thread-9.jsonl");
    // The caller may have scoped or filtered that listing, so it must not
    // become the answer for a later unscoped lookup.
    expect(getTranscriptPathCacheStats().entries).toBe(0);
  });
});

describe("findTranscriptPath path cache", () => {
  test("serves a still-present path from cache instead of walking again", async () => {
    const path = await temporaryRollout("thread-cached", [{ type: "session_meta" }]);
    let walks = 0;
    const listPaths = async () => {
      walks += 1;
      return [path];
    };

    expect(await findTranscriptPath("thread-cached", listPaths)).toBe(path);
    expect(await findTranscriptPath("thread-cached", listPaths)).toBe(path);
    expect(walks).toBe(1);
  });

  test("re-walks once a cached rollout no longer exists on disk", async () => {
    const path = await temporaryRollout("thread-vanishing", [{ type: "session_meta" }]);
    const replacement = await temporaryRollout("thread-vanishing", [{ type: "session_meta" }]);
    let walks = 0;
    const listPaths = async () => {
      walks += 1;
      return walks === 1 ? [path] : [replacement];
    };

    expect(await findTranscriptPath("thread-vanishing", listPaths)).toBe(path);
    await rm(path);
    // The stat revalidation fails, so the stale entry is dropped rather than
    // pinning a path that would fail every later read.
    expect(await findTranscriptPath("thread-vanishing", listPaths)).toBe(replacement);
    expect(walks).toBe(2);
  });

  test("a negative result is cached only for its short TTL", async () => {
    let walks = 0;
    const listPaths = async () => {
      walks += 1;
      return [] as readonly string[];
    };

    expect(await findTranscriptPath("thread-missing", listPaths)).toBeNull();
    expect(await findTranscriptPath("thread-missing", listPaths)).toBeNull();
    expect(walks).toBe(1);

    // A freshly spawned thread's rollout appears moments after the miss, so the
    // negative entry must expire rather than pin "no transcript" for the session.
    setTranscriptPathCacheLimitsForTesting({ negativeTtlMs: 0 });
    expect(await findTranscriptPath("thread-missing", listPaths)).toBeNull();
    expect(walks).toBe(2);
  });

  test("evicts least-recently-used entries past the cap", async () => {
    setTranscriptPathCacheLimitsForTesting({ maxEntries: 2 });
    const listPaths = async () => [] as readonly string[];

    await findTranscriptPath("thread-a", listPaths);
    await findTranscriptPath("thread-b", listPaths);
    await findTranscriptPath("thread-c", listPaths);

    expect(getTranscriptPathCacheStats().entries).toBe(2);
  });

  test("reading a missing session index yields no lines rather than throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-test-"));
    temporaryDirectories.push(root);
    // The session index is absent in a fresh Codex home; callers treat that as
    // "no persisted sessions", so it must not propagate as an error.
    expect(await readTranscriptLines(join(root, "session_index.jsonl"))).toEqual([]);
    expect(await readTranscriptLines(root)).toEqual([]);
  });

  test("clearTranscriptPathCache forces the next lookup to walk", async () => {
    let walks = 0;
    const listPaths = async () => {
      walks += 1;
      return [] as readonly string[];
    };

    await findTranscriptPath("thread-cleared", listPaths);
    clearTranscriptPathCache();
    await findTranscriptPath("thread-cleared", listPaths);
    expect(walks).toBe(2);
  });
});

describe("rollout public helpers (continued)", () => {

  test("reads JSONL lines and extracts defensive metadata", async () => {
    const path = await temporaryRollout("thread-1", [
      {
        type: "session_meta",
        payload: {
          id: "thread-1",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the bridge" }],
        },
      },
    ]);

    expect(await readTranscriptLines(path)).toHaveLength(2);
    expect(await getSessionMetaFromTranscriptPath(path)).toMatchObject({
      id: "thread-1",
      cwd: "/workspace",
      title: "Fix the bridge",
      titleSource: "prompt",
      transcriptPath: path,
    });
  });

  test("skips metadata beyond the bounded head without filling the transcript cache", async () => {
    const path = await temporaryRollout("oversized-head", [
      { type: "event_msg", payload: { message: "x".repeat(70 * 1024) } },
      {
        type: "session_meta",
        payload: {
          id: "oversized-head",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Recovered title" }],
        },
      },
    ]);

    expect(await getSessionMetaFromTranscriptPath(path)).toBeNull();
    expect(getTranscriptCacheStats()).toEqual({ entries: 0, bytes: 0 });
  });

  test("catalog aliases, malformed index lines, and generated title overrides are defensive", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-catalog-"));
    temporaryDirectories.push(root);
    const transcriptPath = join(root, "sessions", "filename-alias.jsonl");
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, `${[
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "canonical-thread",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Prompt title" }],
        },
      }),
    ].join("\n")}\n`, "utf8");
    await writeFile(
      join(root, "session_index.jsonl"),
      `{malformed\n${JSON.stringify({
        id: "canonical-thread",
        updated_at: "2026-07-25T12:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await persistSessionTitle(root, "canonical-thread", "Generated title", {
      source: "generated",
    });

    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      const catalog = await buildTranscriptCatalog();
      expect(catalog.transcriptPathByThreadId.get("filename-alias")).toBe(transcriptPath);
      expect(catalog.transcriptPathByThreadId.get("canonical-thread")).toBe(transcriptPath);

      const sessions = await listPersistedSessionsForCwd("/workspace");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: "canonical-thread",
        title: "Generated title",
        titleSource: "generated",
      });
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("the catalog scan is cached briefly, invalidated explicitly, and expires by TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-catalog-cache-"));
    temporaryDirectories.push(root);
    const writeRollout = async (threadId: string) => {
      const path = join(root, "sessions", `${threadId}.jsonl`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({
        type: "session_meta",
        payload: { id: threadId, cwd: "/workspace", timestamp: "2026-07-25T12:00:00.000Z" },
      })}\n`, "utf8");
    };
    await writeRollout("cache-thread-1");

    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    // Generous TTL so a slow runner cannot expire the cache mid-test.
    setTranscriptCatalogTtlForTesting(60_000);
    try {
      expect((await listPersistedSessionsForCwd("/workspace")).map((s) => s.id))
        .toEqual(["cache-thread-1"]);

      // Within the TTL the listing reuses the previous scan, so a rollout that
      // appeared afterwards is not visible yet…
      await writeRollout("cache-thread-2");
      expect(await listPersistedSessionsForCwd("/workspace")).toHaveLength(1);

      // …until the cache is invalidated, as the runtime does when this process
      // creates, resumes, or forks a thread.
      invalidateTranscriptCatalogCache();
      expect(await listPersistedSessionsForCwd("/workspace")).toHaveLength(2);

      // A zero TTL means every listing rescans.
      setTranscriptCatalogTtlForTesting(0);
      await writeRollout("cache-thread-3");
      expect(await listPersistedSessionsForCwd("/workspace")).toHaveLength(3);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("an in-flight catalog scan stays coalesced beyond the TTL and expires after success", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-catalog-inflight-"));
    temporaryDirectories.push(root);
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;

    let now = 1_000;
    let builds = 0;
    let resolveBuild!: (catalog: Awaited<ReturnType<typeof buildTranscriptCatalog>>) => void;
    const firstBuild = new Promise<Awaited<ReturnType<typeof buildTranscriptCatalog>>>(
      (resolve) => {
        resolveBuild = resolve;
      },
    );
    setTranscriptCatalogTtlForTesting(2_000);
    setTranscriptCatalogNowForTesting(() => now);
    setTranscriptCatalogBuilderForTesting(() => {
      builds += 1;
      if (builds === 1) return firstBuild;
      return Promise.resolve({
        metas: [],
        metaByPath: new Map(),
        transcriptPathByThreadId: new Map(),
      });
    });

    try {
      const first = buildTranscriptCatalogCachedForTesting();
      expect(builds).toBe(1);

      // The scan is still pending well beyond its nominal TTL. It must remain
      // the single shared scan rather than multiplying whole-home walks.
      now = 10_000;
      const second = buildTranscriptCatalogCachedForTesting();
      expect(builds).toBe(1);

      resolveBuild({
        metas: [],
        metaByPath: new Map(),
        transcriptPathByThreadId: new Map(),
      });
      await Promise.all([first, second]);

      now = 11_999;
      await buildTranscriptCatalogCachedForTesting();
      expect(builds).toBe(1);

      now = 12_000;
      await buildTranscriptCatalogCachedForTesting();
      expect(builds).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("a cached catalog that cannot answer for a specific thread is rescanned", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-catalog-miss-"));
    temporaryDirectories.push(root);
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;

    let builds = 0;
    const catalogs: Array<Awaited<ReturnType<typeof buildTranscriptCatalog>>> = [
      { metas: [], metaByPath: new Map(), transcriptPathByThreadId: new Map() },
      {
        metas: [],
        metaByPath: new Map(),
        transcriptPathByThreadId: new Map([["late-thread", "/tmp/late-thread.jsonl"]]),
      },
    ];
    setTranscriptCatalogTtlForTesting(60_000);
    setTranscriptCatalogBuilderForTesting(() => {
      const catalog = catalogs[Math.min(builds, catalogs.length - 1)]!;
      builds += 1;
      return Promise.resolve(catalog);
    });

    try {
      await buildTranscriptCatalogCachedForTesting();
      expect(builds).toBe(1);

      // A caller with no specific thread in mind is still served the cache.
      await buildTranscriptCatalogCachedForTesting();
      expect(builds).toBe(1);

      // A caller asking about a thread the cached scan already knows is too.
      await buildTranscriptCatalogCachedForTesting("late-thread");
      expect(builds).toBe(2);
      await buildTranscriptCatalogCachedForTesting("late-thread");
      expect(builds).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("hydration finds a rollout written after the catalog was scanned", async () => {
    // The regression this pins: the app-server child writes a thread's rollout
    // asynchronously *after* this process asks for the thread, so a catalog
    // scanned moments earlier — and a negative path-cache entry from the same
    // moment — both say "no such rollout". Serving either of those stale misses
    // hands back an empty transcript, which `attachThread` then latches onto the
    // context for the life of the attachment.
    const root = await mkdtemp(join(tmpdir(), "rollout-late-write-"));
    temporaryDirectories.push(root);
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    // Long enough that neither cache can expire on its own during the test.
    setTranscriptCatalogTtlForTesting(60_000);
    setTranscriptPathCacheLimitsForTesting({ negativeTtlMs: 60_000 });

    try {
      // Warm both caches while the rollout genuinely does not exist yet.
      expect(await listPersistedSessionsForCwd("/workspace")).toEqual([]);
      expect(await hydrateMessagesFromPersistedSession("late-thread")).toMatchObject({
        messages: [],
      });

      await writeFile(
        join(sessionsDir, "late-thread.jsonl"),
        `${[
          sessionMeta("late-thread"),
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "written late" }],
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n")}\n`,
        "utf8",
      );

      const hydrated = await hydrateMessagesFromPersistedSession("late-thread");
      expect(hydrated.messages).toHaveLength(1);
      expect(hydrated.messages[0]).toMatchObject({
        role: "assistant",
        content: "written late",
      });
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  test("a per-thread lookup opts out of the negative path cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-negative-cache-"));
    temporaryDirectories.push(root);
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    setTranscriptPathCacheLimitsForTesting({ negativeTtlMs: 60_000 });

    try {
      expect(await findTranscriptPath("pending-thread")).toBeNull();

      await writeFile(
        join(sessionsDir, "pending-thread.jsonl"),
        `${JSON.stringify(sessionMeta("pending-thread"))}\n`,
        "utf8",
      );

      // The default path still trusts the cached miss for its TTL…
      expect(await findTranscriptPath("pending-thread")).toBeNull();
      // …but a caller resolving this one thread must re-check the disk.
      expect(
        await findTranscriptPath("pending-thread", undefined, { allowNegativeCache: false }),
      ).toContain("pending-thread.jsonl");
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("a rejected catalog scan is evicted rather than pinned for the TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-catalog-reject-"));
    temporaryDirectories.push(root);
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;

    let builds = 0;
    setTranscriptCatalogTtlForTesting(60_000);
    setTranscriptCatalogBuilderForTesting(() => {
      builds += 1;
      if (builds === 1) return Promise.reject(new Error("scan failed"));
      return Promise.resolve({
        metas: [],
        metaByPath: new Map(),
        transcriptPathByThreadId: new Map(),
      });
    });

    try {
      await expect(buildTranscriptCatalogCachedForTesting()).rejects.toThrow("scan failed");
      // A failed scan cached for the TTL would blank `/session/list` for anyone
      // who asked during the window, so the next caller must rescan.
      await buildTranscriptCatalogCachedForTesting();
      expect(builds).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("the catalog cache is keyed by Codex home", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "rollout-catalog-home-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "rollout-catalog-home-b-"));
    temporaryDirectories.push(rootA, rootB);
    const previousHome = process.env.CODEX_HOME;

    let builds = 0;
    setTranscriptCatalogTtlForTesting(60_000);
    setTranscriptCatalogBuilderForTesting(() => {
      builds += 1;
      return Promise.resolve({
        metas: [],
        metaByPath: new Map(),
        transcriptPathByThreadId: new Map(),
      });
    });

    try {
      process.env.CODEX_HOME = rootA;
      await buildTranscriptCatalogCachedForTesting();
      await buildTranscriptCatalogCachedForTesting();
      expect(builds).toBe(1);

      // Another store's catalog must never answer for this one.
      process.env.CODEX_HOME = rootB;
      await buildTranscriptCatalogCachedForTesting();
      expect(builds).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("a thread id that is a prefix of another does not resolve to its rollout", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-id-collision-"));
    temporaryDirectories.push(root);
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    // Written first so a plain `includes` scan would reach it first.
    await writeFile(
      join(sessionsDir, "thread-10.jsonl"),
      `${JSON.stringify(sessionMeta("thread-10"))}\n`,
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "thread-1.jsonl"),
      `${JSON.stringify(sessionMeta("thread-1"))}\n`,
      "utf8",
    );

    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      expect(await findTranscriptPath("thread-1")).toContain("thread-1.jsonl");
      expect(await findTranscriptPath("thread-10")).toContain("thread-10.jsonl");
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("resolves a real Codex rollout filename, which prefixes the thread id", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-real-name-"));
    temporaryDirectories.push(root);
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "0199c0de-dead-beef-cafe-0123456789ab";
    await writeFile(
      join(sessionsDir, `rollout-2026-07-25T12-00-00-${threadId}.jsonl`),
      `${JSON.stringify(sessionMeta(threadId))}\n`,
      "utf8",
    );

    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      expect(await findTranscriptPath(threadId)).toContain(threadId);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("hydration resolves a thread whose rollout cwd differs from the current one", async () => {
    // The cwd-scoped listing filters by cwd because it answers "what sessions
    // belong to this workspace". Hydration answers "what is in THIS thread",
    // and the caller already holds the thread id from its own registry — so the
    // direct lookup deliberately does not re-apply that filter. Pinned because
    // the filter used to apply incidentally, via the listing.
    const root = await mkdtemp(join(tmpdir(), "rollout-foreign-cwd-"));
    temporaryDirectories.push(root);
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "foreign-cwd-thread.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "foreign-cwd-thread",
            cwd: "/somewhere/else",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "still mine" }],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
      "utf8",
    );

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("foreign-cwd-thread");
      expect(hydrated.messages).toHaveLength(1);
      expect(hydrated.messages[0]).toMatchObject({ content: "still mine" });
      // The cwd-scoped listing still excludes it.
      expect(await listPersistedSessionsForCwd("/workspace")).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  test("the listing exposes the generated-title index it already parsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-listing-titles-"));
    temporaryDirectories.push(root);
    const path = join(root, "sessions", "titled-thread.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      type: "session_meta",
      payload: { id: "titled-thread", cwd: "/workspace", timestamp: "2026-07-25T12:00:00.000Z" },
    })}\n`, "utf8");
    await persistSessionTitle(root, "titled-thread", "Generated title", { source: "generated" });

    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      const listing = await listPersistedSessionsWithTitlesForCwd("/workspace");
      expect(listing.sessions.map((s) => s.title)).toEqual(["Generated title"]);
      // The map a caller would otherwise re-read and re-parse per request.
      expect(listing.generatedTitles.get("titled-thread")).toMatchObject({
        title: "Generated title",
        source: "generated",
      });
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("cached and malformed metadata preserve caller fallbacks", async () => {
    const path = "/sessions/thread-cached.jsonl";
    const cached = {
      id: "different-id",
      title: "Prompt title",
      titleSource: "prompt" as const,
      updatedAt: "",
      cwd: "/workspace",
      transcriptPath: path,
    };
    const catalog = {
      metas: [cached],
      metaByPath: new Map([[path, cached]]),
      transcriptPathByThreadId: new Map([["thread-cached", path]]),
    };

    expect(
      await getPersistedSessionMeta(
        "thread-cached",
        "Indexed title",
        "2026-07-25T12:00:00.000Z",
        catalog,
      ),
    ).toMatchObject({
      id: "thread-cached",
      title: "Indexed title",
      titleSource: "codex",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });

    const malformed = await temporaryRollout("malformed-meta-fallback", [{
      type: "session_meta",
      payload: { id: "" },
    }]);
    expect(
      await getPersistedSessionMeta(
        "malformed-meta-fallback",
        "Fallback",
        "2026-07-25T12:00:00.000Z",
        undefined,
        [malformed],
      ),
    ).toMatchObject({
      id: "malformed-meta-fallback",
      title: "Fallback",
      transcriptPath: malformed,
    });
  });

  test("invalid transcript metadata falls back without fabricating a session", async () => {
    const noMeta = await temporaryRollout("no-meta", [{ type: "response_item" }]);
    expect(await getSessionMetaFromTranscriptPath(noMeta)).toBeNull();

    const malformedId = await temporaryRollout("bad-id", [{
      type: "session_meta",
      payload: { id: "", timestamp: 4 },
    }]);
    expect(await getSessionMetaFromTranscriptPath(malformedId)).toBeNull();
    expect(
      await getPersistedSessionMeta(
        "missing",
        "Fallback",
        "2026-07-25T12:00:00.000Z",
        undefined,
        [],
      ),
    ).toEqual({
      id: "missing",
      title: "Fallback",
      titleSource: "codex",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
  });

  test("shared metadata loader scans lazily, once, and reuses the same path snapshot", async () => {
    let scans = 0;
    const seen: Array<{ id: string; paths: readonly string[] }> = [];
    const loader = createSharedTranscriptMetaLoader(
      async () => {
        scans += 1;
        return ["/one.jsonl"];
      },
      async (id, paths) => {
        seen.push({ id, paths: await paths() });
        return null;
      },
    );
    await Promise.all([loader("a"), loader("b")]);
    expect(scans).toBe(1);
    expect(seen.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    expect(seen[0]!.paths).toBe(seen[1]!.paths);
  });

  test("shared metadata loader never walks when metadata resolves without paths", async () => {
    let scans = 0;
    const loader = createSharedTranscriptMetaLoader(
      async () => {
        scans += 1;
        return [];
      },
      async (id) => ({ id, updatedAt: "2026-07-25T12:00:00.000Z" }),
    );
    await Promise.all([loader("a"), loader("b")]);
    expect(scans).toBe(0);
  });

  test("metadata merge inserts copies and advances only the timestamp", () => {
    const sessions = new Map();
    const original = {
      id: "thread-1",
      title: "Indexed title",
      updatedAt: "2026-07-25T10:00:00.000Z",
    };
    mergePersistedSessionMeta(sessions, original);
    original.title = "mutated";
    mergePersistedSessionMeta(sessions, {
      id: "thread-1",
      title: "Transcript title",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
    expect(sessions.get("thread-1")).toEqual({
      id: "thread-1",
      title: "Indexed title",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
  });

  test("extracts multipart text and filters synthetic injected user context", () => {
    expect(
      extractPersistedMessageText([
        { type: "output_text", text: "one" },
        null,
        { type: "output_text", text: 42 },
        { type: "future_content", text: "hidden" },
        { type: "output_text", text: "two" },
      ], "assistant"),
    ).toBe("one\ntwo");
    expect(extractPersistedMessageText("bad", "assistant")).toBeNull();
    expect(extractPersistedMessageText([], "assistant")).toBeNull();
    expect(
      extractPersistedMessageText(
        [{ type: "input_text", text: "wrong role shape" }, { type: "output_text", text: 42 }],
        "assistant",
      ),
    ).toBeNull();
    expect(extractPersistedMessageText([{ type: "input_text", text: "  " }], "user"))
      .toBeNull();
    expect(
      extractPersistedMessageText(
        [{ type: "input_text", text: "# AGENTS.md instructions for /workspace" }],
        "user",
      ),
    ).toBeNull();
    expect(
      extractPersistedMessageText(
        [{
          type: "input_text",
          text: "<recommended_plugins>\nHere is a list of plugins that are available but not installed.",
        }],
        "user",
      ),
    ).toBeNull();
  });

  test("recovers attachment rows from the persisted marker, not from inline image data", () => {
    const persisted = extractPersistedMessageContent(
      [
        {
          type: "input_text",
          text: "Inspect the diagram\n\n<attached-files>\n"
            + '<attachment type="image" path="/workspace/.orkestrator/initial-prompt/shot.png"'
            + ' filename="shot.png" />\n</attached-files>',
        },
        // Codex rewrites a local image into an inline base64 data URL. Replaying
        // that would cost megabytes per subscriber per rehydration.
        { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(5000)}` },
      ],
      "user",
    );

    expect(persisted).toEqual({
      text: "Inspect the diagram",
      attachments: [{
        type: "file",
        content: "/workspace/.orkestrator/initial-prompt/shot.png",
        fileUrl: "/workspace/.orkestrator/initial-prompt/shot.png",
        filename: "shot.png",
      }],
    });
    expect(JSON.stringify(persisted)).not.toContain("base64");
  });

  test("keeps an attachment-only prompt that has no text left after stripping", () => {
    expect(
      extractPersistedMessageContent(
        [{
          type: "input_text",
          text: '<attached-files><attachment type="image" path="/workspace/a.png" /></attached-files>',
        }],
        "user",
      ),
    ).toEqual({
      text: "",
      attachments: [{ type: "file", content: "/workspace/a.png", fileUrl: "/workspace/a.png" }],
    });
  });

  test("hides the attachment marker from the text used for titles", () => {
    expect(
      extractPersistedMessageText(
        [{
          type: "input_text",
          text: 'Fix the layout\n\n<attached-files><attachment type="image" path="/workspace/a.png" /></attached-files>',
        }],
        "user",
      ),
    ).toBe("Fix the layout");
  });

  test("hydrates a user message with an attachment into text and file parts", async () => {
    const hydrated = await hydrateRollout("thread-attachment", [
      sessionMeta("thread-attachment"),
      {
        timestamp: "2026-07-25T12:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: 'Look\n\n<attached-files><attachment type="image" path="/workspace/a.png" filename="a.png" /></attached-files>',
            },
            { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
          ],
        },
      },
    ]);

    expect(hydrated.messages).toHaveLength(1);
    expect(hydrated.messages[0]?.content).toBe("Look");
    expect(hydrated.messages[0]?.parts).toEqual([
      { type: "text", content: "Look" },
      {
        type: "file",
        content: "/workspace/a.png",
        fileUrl: "/workspace/a.png",
        filename: "a.png",
      },
    ]);
  });

  test("hydrates one rollout defensively while skipping malformed and synthetic records", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-hydration-"));
    temporaryDirectories.push(root);
    const path = join(root, "sessions", "2026", "07", "thread-hydrate.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "thread-hydrate",
            cwd: "/workspace",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        }),
        "{malformed",
        JSON.stringify({
          timestamp: "2026-07-25T12:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions for /workspace" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-25T12:02:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "real prompt" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-25T12:03:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "real answer" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "system", content: [] },
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "session_index.jsonl"),
      `${JSON.stringify({
        id: "thread-hydrate",
        updated_at: "2026-07-25T12:03:00.000Z",
      })}\n`,
      "utf8",
    );

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("thread-hydrate");
      expect(hydrated.messages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      }))).toEqual([
        {
          role: "user",
          content: "real prompt",
          createdAt: "2026-07-25T12:02:00.000Z",
        },
        {
          role: "assistant",
          content: "real answer",
          createdAt: "2026-07-25T12:03:00.000Z",
        },
      ]);
      expect(hydrated.title).toBe("real prompt");
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  /**
   * The direct per-thread lookup replaced a whole-home catalog scan as
   * hydration's first step; these pin the title semantics the listing used to
   * provide, so the inversion stays behaviour-equivalent.
   */
  test("hydration keeps an indexed thread_name over a generated title", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-hydrate-titles-"));
    temporaryDirectories.push(root);
    const path = join(root, "sessions", "thread-named.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${[
      JSON.stringify(sessionMeta("thread-named")),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Prompt title" }],
        },
      }),
    ].join("\n")}\n`, "utf8");
    await writeFile(
      join(root, "session_index.jsonl"),
      `${JSON.stringify({
        id: "thread-named",
        thread_name: "Indexed name",
        updated_at: "2026-07-25T12:00:00.000Z",
      })}\n`,
      "utf8",
    );
    // A Codex-owned name outranks the bridge's generated title, exactly as in
    // the full listing.
    await persistSessionTitle(root, "thread-named", "Generated title", { source: "generated" });

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("thread-named");
      expect(hydrated.title).toBe("Indexed name");
      expect(hydrated.titleSource).toBe("codex");
      expect(hydrated.messages).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  test("hydration applies a generated title over the prompt fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-hydrate-generated-"));
    temporaryDirectories.push(root);
    const path = join(root, "sessions", "thread-generated.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${[
      JSON.stringify(sessionMeta("thread-generated")),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Prompt title" }],
        },
      }),
    ].join("\n")}\n`, "utf8");
    await persistSessionTitle(root, "thread-generated", "Generated title", {
      source: "generated",
    });

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("thread-generated");
      expect(hydrated.title).toBe("Generated title");
      expect(hydrated.titleSource).toBe("generated");
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  test("direct hydration ignores malformed and malformed matching session-index entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-index-defensive-"));
    temporaryDirectories.push(root);
    const path = join(root, "sessions", "thread-index-defensive.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${[
      JSON.stringify(sessionMeta("thread-index-defensive")),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Prompt fallback" }],
        },
      }),
    ].join("\n")}\n`, "utf8");
    await writeFile(
      join(root, "session_index.jsonl"),
      [
        "null",
        "[]",
        "{malformed",
        JSON.stringify({
          id: "thread-index-defensive",
          thread_name: { malformed: true },
          updated_at: 42,
        }),
      ].join("\n"),
      "utf8",
    );

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("thread-index-defensive");
      expect(hydrated.title).toBe("Prompt fallback");
      expect(hydrated.titleSource).toBe("prompt");
      expect(hydrated.messages).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  test("hydrates a rollout whose filename does not contain the thread id", async () => {
    // Only the catalog can find this rollout, so the listing fallback — not the
    // direct lookup — must carry it.
    const root = await mkdtemp(join(tmpdir(), "rollout-hydrate-alias-"));
    temporaryDirectories.push(root);
    const path = join(root, "sessions", "filename-alias.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${[
      JSON.stringify(sessionMeta("canonical-hydrate")),
      JSON.stringify({
        timestamp: "2026-07-25T12:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "aliased prompt" }],
        },
      }),
    ].join("\n")}\n`, "utf8");

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("canonical-hydrate");
      expect(hydrated.messages.map((message) => message.content)).toEqual(["aliased prompt"]);
      expect(hydrated.title).toBe("aliased prompt");
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  /**
   * The record shapes here are the ones Codex actually writes, verified against
   * this repo's full rollout history: a `function_call` never carries `status`
   * (92,495 of 92,495 records), and a `custom_tool_call` always does. That
   * distinction drives the two different outcomes asserted below.
   */
  test("rehydrates persisted tool calls and results in assistant timeline order", async () => {
    const path = await temporaryRollout("thread-tools", [
      {
        type: "session_meta",
        payload: {
          id: "thread-tools",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      },
      { type: "turn_context", payload: { turn_id: "turn-tools", cwd: "/workspace" } },
      {
        timestamp: "2026-07-25T12:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the repository" }],
        },
      },
      {
        timestamp: "2026-07-25T12:01:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I'll inspect it." }],
        },
      },
      {
        timestamp: "2026-07-25T12:01:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-exec",
          arguments: JSON.stringify({ cmd: "git status --short" }),
        },
      },
      {
        timestamp: "2026-07-25T12:01:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-exec",
          output: " M src/example.ts",
        },
      },
      {
        timestamp: "2026-07-25T12:01:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "update_plan",
          call_id: "call-plan",
          arguments: JSON.stringify({
            plan: [{ step: "Patch files", status: "in_progress" }],
          }),
        },
      },
      {
        timestamp: "2026-07-25T12:01:04.100Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-plan",
          output: "Plan updated",
        },
      },
      {
        timestamp: "2026-07-25T12:01:04.200Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-patch",
          input: `*** Begin Patch
*** Update File: src/a.ts
@@
-a
+A
*** Add File: src/b.ts
+B
*** End Patch`,
          status: "completed",
        },
      },
      {
        timestamp: "2026-07-25T12:01:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch",
          output: "Patch applied to 2 files",
        },
      },
      {
        timestamp: "2026-07-25T12:01:05.100Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-custom-exec",
          input:
            "const r = await tools.exec_command({\"cmd\":\"bun test --parallel\",\"yield_time_ms\":30000});",
          status: "completed",
        },
      },
      {
        timestamp: "2026-07-25T12:01:05.200Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-custom-exec",
          output: "All tests passed",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "unknown-call",
          output: "must not create an orphan result",
        },
      },
      {
        timestamp: "2026-07-25T12:01:06.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The repository has one modified file." }],
        },
      },
    ]);

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = dirname(dirname(path));
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("thread-tools");
      expect(hydrated.messages).toHaveLength(2);
      expect(hydrated.messages[0]).toMatchObject({
        role: "user",
        content: "Inspect the repository",
        turnId: "turn-tools",
      });
      expect(hydrated.messages[1]).toMatchObject({
        role: "assistant",
        content: "The repository has one modified file.",
        turnId: "turn-tools",
      });
      expect(hydrated.messages[1]?.parts).toEqual([
        { type: "text", content: "I'll inspect it." },
        {
          type: "tool-invocation",
          content: "exec_command",
          toolName: "exec_command",
          toolArgs: {
            cmd: "git status --short",
            command: "git status --short",
          },
          // The rollout records no outcome for a function_call — not on the call
          // record, not on the output record, and not in the output text. The
          // result is shown without claiming it succeeded, because a failed
          // command produces exactly this same pair of records.
          toolState: undefined,
          toolTitle: "exec_command",
          toolOutput: " M src/example.ts",
          toolError: undefined,
        },
        {
          type: "tool-invocation",
          content: "update_plan",
          toolName: "update_plan",
          toolArgs: {
            plan: [{ step: "Patch files", status: "in_progress" }],
          },
          toolState: undefined,
          toolTitle: "update_plan",
          toolOutput: "Plan updated",
          toolError: undefined,
        },
        {
          type: "tool-invocation",
          content: "src/a.ts",
          toolName: "apply_patch",
          toolArgs: { path: "src/a.ts", kind: "update" },
          // This successful patch output agrees with the call record.
          toolState: "success",
          toolTitle: "update: src/a.ts",
          toolOutput: "Patch applied to 2 files",
          toolError: undefined,
          toolDiff: {
            filePath: "/workspace/src/a.ts",
            diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-a\n+A",
            additions: 1,
            deletions: 1,
          },
        },
        {
          type: "tool-invocation",
          content: "src/b.ts",
          toolName: "apply_patch",
          toolArgs: { path: "src/b.ts", kind: "add" },
          toolState: "success",
          toolTitle: "add: src/b.ts",
          toolOutput: "Patch applied to 2 files",
          toolError: undefined,
          toolDiff: {
            filePath: "/workspace/src/b.ts",
            diff: "--- /dev/null\n+++ b/src/b.ts\n+B",
            additions: 1,
            deletions: 0,
          },
        },
        {
          type: "tool-invocation",
          content: "exec",
          toolName: "exec",
          toolArgs: {
            input:
              "const r = await tools.exec_command({\"cmd\":\"bun test --parallel\",\"yield_time_ms\":30000});",
            command: "bun test --parallel",
          },
          toolState: "success",
          toolTitle: "exec",
          toolOutput: "All tests passed",
          toolError: undefined,
        },
        { type: "text", content: "The repository has one modified file." },
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  test("rehydrates the model Codex persisted in each turn context", async () => {
    const hydrated = await hydrateRollout("thread-model", [
      sessionMeta("thread-model"),
      {
        type: "turn_context",
        payload: {
          turn_id: "turn-1",
          cwd: "/workspace",
          model: "gpt-5.6-sol",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        },
      },
    ]);

    expect(hydrated.messages[0]).toMatchObject({
      role: "assistant",
      modelId: "gpt-5.6-sol",
      turnId: "turn-1",
    });
  });

  test("scopes changing models to their turn and never attributes user messages", async () => {
    const hydrated = await hydrateRollout("thread-models", [
      sessionMeta("thread-models"),
      {
        type: "turn_context",
        payload: { turn_id: "turn-1", cwd: "/workspace", model: "gpt-one" },
      },
      // A repeated context without a model must not erase the value already
      // observed for this same turn.
      {
        type: "turn_context",
        payload: { turn_id: "turn-1", cwd: "/workspace" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "First" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "One" }],
        },
      },
      {
        type: "turn_context",
        payload: { turn_id: "turn-2", cwd: "/workspace", model: "gpt-two" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Two" }],
        },
      },
    ]);

    expect(hydrated.messages.map((message) => ({
      role: message.role,
      turnId: message.turnId,
      modelId: message.modelId,
    }))).toEqual([
      { role: "user", turnId: "turn-1", modelId: undefined },
      { role: "assistant", turnId: "turn-1", modelId: "gpt-one" },
      { role: "assistant", turnId: "turn-2", modelId: "gpt-two" },
    ]);
  });

  test("does not retroactively apply a turn context that arrives after output", async () => {
    const hydrated = await hydrateRollout("thread-late-model", [
      sessionMeta("thread-late-model"),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Before context" }],
        },
      },
      {
        type: "turn_context",
        payload: { turn_id: "turn-1", cwd: "/workspace", model: "gpt-late" },
      },
    ]);

    expect(hydrated.messages[0]?.modelId).toBeUndefined();
  });

  /**
   * `status: "failed"` has not been observed in 34,640 sampled `custom_tool_call`
   * records — every one was `"completed"`. It is kept as a guard because it is
   * the counterpart value in the same field, so this test pins the branch rather
   * than documenting a shape Codex is known to emit.
   */
  test("a custom_tool_call that claims failure keeps that outcome", async () => {
    const hydrated = await hydrateRollout("thread-tool-failed", [
      sessionMeta("thread-tool-failed"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-patch",
          input: "*** Begin Patch",
          status: "failed",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch",
          output: "Patch did not apply",
        },
      },
    ]);

    expect(hydrated.messages[0]?.parts[0]).toMatchObject({
      toolState: "failure",
      toolOutput: undefined,
      toolError: "Patch did not apply",
    });
  });

  test("a completed apply_patch call is failed when its output reports verification failure", async () => {
    const hydrated = await hydrateRollout("thread-patch-verification-failed", [
      sessionMeta("thread-patch-verification-failed"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-patch",
          input: "*** Begin Patch",
          // Codex records call emission as completed even when application fails.
          status: "completed",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch",
          output: "apply_patch verification failed: Failed to find expected lines",
        },
      },
    ]);

    expect(hydrated.messages[0]?.parts[0]).toMatchObject({
      toolName: "apply_patch",
      toolState: "failure",
      toolOutput: undefined,
      toolError: "apply_patch verification failed: Failed to find expected lines",
    });
  });

  test("rehydrates paired and inline apply_patch diagnostics as failures", async () => {
    const hydrated = await hydrateRollout("thread-patch-inline-and-paired", [
      sessionMeta("thread-patch-inline-and-paired"),
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-inline-patch",
          input: "*** Begin Patch",
          output: "Failed to read file to update src/inline.ts: permission denied",
          status: "completed",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-paired-patch",
          input: "*** Begin Patch",
          status: "completed",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-paired-patch",
          output: [{ type: "input_text", text: "Invalid Update File Line: broken" }],
        },
      },
    ]);

    expect(hydrated.messages[0]?.parts).toEqual([
      expect.objectContaining({
        toolName: "apply_patch",
        toolState: "failure",
        toolOutput: undefined,
        toolError: "Failed to read file to update src/inline.ts: permission denied",
      }),
      expect.objectContaining({
        toolName: "apply_patch",
        toolState: "failure",
        toolOutput: undefined,
        toolError: JSON.stringify(
          [{ type: "input_text", text: "Invalid Update File Line: broken" }],
          null,
          2,
        ),
      }),
    ]);
  });

  test("a failed tool result with no output text still reports an error", async () => {
    const hydrated = await hydrateRollout("thread-tool-failed-blank", [
      sessionMeta("thread-tool-failed-blank"),
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-blank",
          input: "*** Begin Patch",
          status: "failed",
        },
      },
      {
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "call-blank" },
      },
    ]);

    // A failure with nothing to show must not render as a blank success.
    expect(hydrated.messages[0]?.parts[0]).toMatchObject({
      toolState: "failure",
      toolError: "Tool failed",
    });
  });

  test("a tool call whose result never arrived stays pending", async () => {
    const hydrated = await hydrateRollout("thread-tool-unpaired", [
      sessionMeta("thread-tool-unpaired"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-interrupted",
          arguments: JSON.stringify({ cmd: "sleep 600" }),
        },
      },
    ]);

    // The turn was interrupted before the result was written. "Still running" is
    // what the rollout records, so that is what is shown — inventing a terminal
    // state here would claim an outcome that never happened.
    const part = hydrated.messages[0]?.parts[0];
    expect(part).toMatchObject({ toolName: "exec_command", toolState: "pending" });
    expect(part?.toolOutput).toBeUndefined();
    expect(part?.toolError).toBeUndefined();
  });

  test("a turn of pure tool calls yields an assistant message with no text", async () => {
    const hydrated = await hydrateRollout("thread-tools-only", [
      sessionMeta("thread-tools-only"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Run the tests" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: JSON.stringify({ cmd: "bun test" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: "ok" },
      },
    ]);

    expect(hydrated.messages).toHaveLength(2);
    // The tool work is still surfaced even though the agent said nothing, so the
    // transcript does not silently lose the turn.
    expect(hydrated.messages[1]).toMatchObject({ role: "assistant", content: "" });
    expect(hydrated.messages[1]?.parts).toHaveLength(1);
    expect(hydrated.messages[1]?.parts[0]).toMatchObject({ toolName: "exec_command" });
  });

  test("tool calls do not leak across a turn boundary", async () => {
    const hydrated = await hydrateRollout("thread-two-turns", [
      sessionMeta("thread-two-turns"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: JSON.stringify({ cmd: "ls" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: "a.ts" },
      },
      { type: "turn_context", payload: { turn_id: "turn-2", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-2",
          arguments: JSON.stringify({ cmd: "pwd" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-2", output: "/workspace" },
      },
    ]);

    // Two turns, two assistant messages — a merged bubble would make "fork from
    // here" target the wrong turn.
    expect(hydrated.messages).toHaveLength(2);
    expect(hydrated.messages.map((message) => message.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(hydrated.messages.map((message) => message.parts.length)).toEqual([1, 1]);
  });

  test("a repeated call_id does not rewrite an earlier turn's result", async () => {
    const hydrated = await hydrateRollout("thread-duplicate-call", [
      sessionMeta("thread-duplicate-call"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-shared",
          arguments: JSON.stringify({ cmd: "ls" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-shared", output: "first" },
      },
      { type: "turn_context", payload: { turn_id: "turn-2", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-shared", output: "second" },
      },
    ]);

    expect(hydrated.messages).toHaveLength(1);
    expect(hydrated.messages[0]?.parts[0]).toMatchObject({ toolOutput: "first" });
  });

  test("falls back to a generic name and ignores a call with no call_id", async () => {
    const hydrated = await hydrateRollout("thread-tool-degraded", [
      sessionMeta("thread-tool-degraded"),
      {
        type: "response_item",
        payload: { type: "function_call", name: "   ", call_id: "call-unnamed", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call", arguments: JSON.stringify({ cmd: "ls" }) },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-unnamed", output: "done" },
      },
    ]);

    const parts = hydrated.messages[0]?.parts ?? [];
    // Both calls are still shown; only the pairing degrades when call_id is absent.
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ toolName: "tool", toolOutput: "done" });
    expect(parts[1]).toMatchObject({ toolName: "tool", toolState: "pending" });
    expect(parts[1]?.toolOutput).toBeUndefined();
  });

  /**
   * Turn boundaries are what make "fork from here" survive a bridge restart, and
   * they are reconstructed from *two* record shapes: `turn_context`, and the
   * turn-scoped `event_msg` records. Both precede the messages of their turn, so
   * the last id seen owns the message. The camelCase spelling is accepted too, so
   * a rollout-format change degrades to "no fork point" rather than silently
   * attributing messages to the previous turn.
   */
  test("reconstructs turn boundaries from turn_context, event_msg, and either spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-turns-"));
    temporaryDirectories.push(root);
    const path = join(root, "sessions", "thread-turns.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const records = [
      {
        type: "session_meta",
        payload: { id: "thread-turns", cwd: "/workspace", timestamp: "2026-07-25T12:00:00.000Z" },
      },
      // Before the first turn: no boundary has been seen yet.
      {
        timestamp: "2026-07-25T12:00:30.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "before any turn" }],
        },
      },
      { type: "turn_context", payload: { turn_id: "turn-a", cwd: "/workspace" } },
      {
        timestamp: "2026-07-25T12:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first turn prompt" }],
        },
      },
      // The other ordering: a turn-scoped event_msg carrying the boundary.
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-b" },
      },
      {
        timestamp: "2026-07-25T12:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "second turn answer" }],
        },
      },
      // camelCase: accepted, so a format change does not misattribute messages.
      { type: "event_msg", payload: { type: "task_started", turnId: "turn-c" } },
      {
        timestamp: "2026-07-25T12:03:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "third turn prompt" }],
        },
      },
      // Neither spelling, and a blank id: leaves the previous boundary standing
      // rather than clearing it.
      { type: "event_msg", payload: { type: "task_started", turn_id: "   " } },
      {
        timestamp: "2026-07-25T12:04:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "third turn answer" }],
        },
      },
    ];
    await writeFile(
      path,
      `${records.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      join(root, "session_index.jsonl"),
      `${JSON.stringify({ id: "thread-turns", updated_at: "2026-07-25T12:04:00.000Z" })}\n`,
      "utf8",
    );

    const previousHome = process.env.CODEX_HOME;
    const previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/workspace";
    try {
      const hydrated = await hydrateMessagesFromPersistedSession("thread-turns");
      expect(hydrated.messages.map((message) => [message.content, message.turnId])).toEqual([
        ["before any turn", undefined],
        ["first turn prompt", "turn-a"],
        ["second turn answer", "turn-b"],
        ["third turn prompt", "turn-c"],
        ["third turn answer", "turn-c"],
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });
});

describe("persisted multi-file apply_patch hydration", () => {
  const MULTI_FILE_PATCH = `*** Begin Patch
*** Update File: src/a.ts
@@
-a
+A
*** Add File: src/b.ts
+B
*** End Patch`;

  test("clears the state of every part when the output records no outcome", async () => {
    // A `function_call_output` is written whether the call succeeded or failed
    // and carries no status, so "unknown" is the only honest state — and it has
    // to reach *all* of the parts one call now expands into, not just the first.
    const hydrated = await hydrateRollout("thread-fnpatch", [
      sessionMeta("thread-fnpatch"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        timestamp: "2026-07-25T12:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "apply_patch",
          call_id: "call-patch",
          arguments: JSON.stringify({ input: MULTI_FILE_PATCH }),
        },
      },
      {
        timestamp: "2026-07-25T12:01:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-patch",
          output: "Patch applied to 2 files",
        },
      },
    ]);

    const parts = hydrated.messages.flatMap((message) => message.parts);
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.toolTitle)).toEqual([
      "update: src/a.ts",
      "add: src/b.ts",
    ]);
    for (const part of parts) {
      expect(part.toolName).toBe("apply_patch");
      expect(part.toolState).toBeUndefined();
      expect(part.toolOutput).toBe("Patch applied to 2 files");
      expect(part.toolError).toBeUndefined();
    }
  });

  test("marks every part failed when the output reports a patch failure", async () => {
    // apply_patch is atomic, so one file failing means none were written.
    const hydrated = await hydrateRollout("thread-failpatch", [
      sessionMeta("thread-failpatch"),
      { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/workspace" } },
      {
        timestamp: "2026-07-25T12:01:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-patch",
          status: "completed",
          input: MULTI_FILE_PATCH,
        },
      },
      {
        timestamp: "2026-07-25T12:01:01.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch",
          output: "Failed to read file to update: src/a.ts",
        },
      },
    ]);

    const parts = hydrated.messages.flatMap((message) => message.parts);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.toolState).toBe("failure");
      expect(part.toolError).toBe("Failed to read file to update: src/a.ts");
      expect(part.toolOutput).toBeUndefined();
    }
  });

  test.each([
    ["carries no cwd at all", undefined],
    ["carries a blank cwd", ""],
  ])("resolves patch paths against the process cwd when the rollout %s", async (
    _label,
    cwd,
  ) => {
    const hydrated = await hydrateRollout(
      "thread-nocwd",
      [
        {
          type: "session_meta",
          payload: {
            id: "thread-nocwd",
            ...(cwd === undefined ? {} : { cwd }),
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        { type: "turn_context", payload: { turn_id: "turn-1" } },
        {
          timestamp: "2026-07-25T12:01:00.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "call-patch",
            status: "completed",
            input: MULTI_FILE_PATCH,
          },
        },
      ],
      "/fallback-workspace",
    );

    const parts = hydrated.messages.flatMap((message) => message.parts);
    // A blank `cwd` must fall back rather than joining relatively, which would
    // leave the UI with a path it cannot open.
    expect(parts.map((part) => part.toolDiff?.filePath)).toEqual([
      "/fallback-workspace/src/a.ts",
      "/fallback-workspace/src/b.ts",
    ]);
  });
});
