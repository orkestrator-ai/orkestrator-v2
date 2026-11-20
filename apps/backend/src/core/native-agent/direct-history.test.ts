/**
 * The direct history page cache (efficiency step 11): bounded, scoped to the
 * session's current epoch, and sharing one provider read between concurrent
 * callers without letting a stale read repopulate it.
 */
import { describe, expect, test } from "bun:test";
import {
  DIRECT_HISTORY_CURSOR_MAX_LENGTH,
  DirectHistoryCursorHandles,
  DirectHistoryPageCache,
  decodeHistoryCursor,
  encodeDirectHistoryCursor,
} from "./direct-history.js";

const limits = {
  maxEntries: 10,
  maxBytes: 10_000,
  maxSessionEntries: 10,
  maxSessionBytes: 10_000,
  ttlMs: 60_000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const now = () => 1_000;
const page = (key: string, epoch = "e1") => ({
  sessionKey: "s1",
  providerSessionId: "p1",
  epoch,
  key,
});

describe("direct history page cache", () => {
  test("a loaded page is served again only for its session, provider session and epoch", async () => {
    const cache = new DirectHistoryPageCache<string>(limits);
    let reads = 0;
    const value = await cache.load(
      page("k1"),
      async () => {
        reads += 1;
        return { value: "page-1", bytes: 100 };
      },
      now,
    );
    expect(value).toBe("page-1");
    expect(cache.lookup("s1", "p1", "e1", "k1", now())).toBe("page-1");
    expect(cache.lookup("s2", "p1", "e1", "k1", now())).toBeUndefined();
    expect(cache.lookup("s1", "p2", "e1", "k1", now())).toBeUndefined();
    expect(cache.lookup("s1", "p1", "e2", "k1", now())).toBeUndefined();
    // The time-to-live backstop expires it.
    expect(cache.lookup("s1", "p1", "e1", "k1", now() + limits.ttlMs)).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(reads).toBe(1);
  });

  test("observing another epoch drops the session's pages", async () => {
    const cache = new DirectHistoryPageCache<string>(limits);
    await cache.load(page("k1"), async () => ({ value: "page-1", bytes: 100 }), now);
    cache.observeEpoch("s1", "p1", "e1");
    expect(cache.lookup("s1", "p1", "e1", "k1", now())).toBe("page-1");
    cache.observeEpoch("s1", "p1", "e2");
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    expect(cache.lookup("s1", "p1", "e1", "k1", now())).toBeUndefined();
  });

  test("concurrent callers share one read, and a rejection reaches each without being cached", async () => {
    const cache = new DirectHistoryPageCache<string>(limits);
    const gate = deferred<{ value: string; bytes: number }>();
    let reads = 0;
    const read = () => {
      reads += 1;
      return gate.promise;
    };
    const first = cache.load(page("k1"), read, now);
    const second = cache.load(page("k1"), read, now);
    gate.reject(new Error("expired"));
    await expect(first).rejects.toThrow("expired");
    await expect(second).rejects.toThrow("expired");
    expect(reads).toBe(1);
    expect(cache.size).toBe(0);

    // A caller that stopped waiting leaves no unhandled rejection behind.
    const abandoned = deferred<{ value: string; bytes: number }>();
    void cache.load(page("k2"), () => abandoned.promise, now).catch(() => undefined);
    const joined = cache.load(page("k2"), () => abandoned.promise, now);
    abandoned.reject(new Error("gone"));
    await expect(joined).rejects.toThrow("gone");

    // The next request reads again.
    expect(await cache.load(page("k1"), async () => ({ value: "page-1", bytes: 100 }), now)).toBe(
      "page-1",
    );
  });

  test("a read in flight when the session is forgotten or rotates is not admitted", async () => {
    const cache = new DirectHistoryPageCache<string>(limits);
    const forgotten = deferred<{ value: string; bytes: number }>();
    const pending = cache.load(page("k1"), () => forgotten.promise, now);
    cache.forgetSession("s1");
    // A caller after the invalidation does not join the stale read.
    let fresh = 0;
    const after = cache.load(
      page("k1"),
      async () => {
        fresh += 1;
        return { value: "fresh", bytes: 100 };
      },
      now,
    );
    forgotten.resolve({ value: "stale", bytes: 100 });
    expect(await pending).toBe("stale");
    expect(await after).toBe("fresh");
    expect(fresh).toBe(1);
    expect(cache.lookup("s1", "p1", "e1", "k1", now())).toBe("fresh");

    const rotating = deferred<{ value: string; bytes: number }>();
    const old = cache.load(page("k2"), () => rotating.promise, now);
    cache.observeEpoch("s1", "p1", "e2");
    rotating.resolve({ value: "old-epoch", bytes: 100 });
    expect(await old).toBe("old-epoch");
    // Neither admitted nor allowed to restore its epoch as current.
    expect(cache.lookup("s1", "p1", "e1", "k2", now())).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("with no remembered epoch, a newer observation still stops an older read", async () => {
    const cache = new DirectHistoryPageCache<string>(limits);
    const older = deferred<{ value: string; bytes: number }>();
    // No epoch is remembered for s1 (as after a restart or eviction).
    const pending = cache.load(page("k1", "e1"), () => older.promise, now);
    cache.observeEpoch("s1", "p1", "e2");
    older.resolve({ value: "old-epoch", bytes: 100 });
    expect(await pending).toBe("old-epoch");
    // e2 stays current and the e1 page is neither admitted nor served.
    expect(cache.lookup("s1", "p1", "e1", "k1", now())).toBeUndefined();
    expect(cache.size).toBe(0);
    const current = cache.load(page("k2", "e2"), async () => ({ value: "new", bytes: 100 }), now);
    expect(await current).toBe("new");
    expect(cache.lookup("s1", "p1", "e2", "k2", now())).toBe("new");
  });

  test("byte, count and per-session ceilings evict the least recently used page", async () => {
    const cache = new DirectHistoryPageCache<string>({
      ...limits,
      maxBytes: 1_000,
      maxSessionEntries: 2,
    });
    const load = (sessionKey: string, key: string, bytes: number) =>
      cache.load(
        { sessionKey, providerSessionId: "p1", epoch: "e1", key },
        async () => ({ value: key, bytes }),
        now,
      );
    await load("s1", "a", 400);
    await load("s1", "b", 400);
    expect(cache.lookup("s1", "p1", "e1", "a", now())).toBe("a");
    await load("s1", "c", 100);
    // The session holds two pages: "b" was least recently used.
    expect(cache.lookup("s1", "p1", "e1", "b", now())).toBeUndefined();
    await load("s2", "d", 550);
    // 400 + 100 + 550 exceeds 1,000 bytes: "a" (oldest) goes.
    expect(cache.bytes).toBeLessThanOrEqual(1_000);
    expect(cache.lookup("s1", "p1", "e1", "a", now())).toBeUndefined();
    expect(cache.lookup("s1", "p1", "e1", "c", now())).toBe("c");
    expect(cache.lookup("s2", "p1", "e1", "d", now())).toBe("d");
    // A page larger than the whole budget is served but never admitted.
    expect(await load("s2", "huge", 5_000)).toBe("huge");
    expect(cache.lookup("s2", "p1", "e1", "huge", now())).toBeUndefined();
  });
});

describe("direct history cursors too long to wrap (8110)", () => {
  const owner = { sessionKey: "s1", providerSessionId: "p1" };
  const long = (tag: string) => `bp1.${tag}${"c".repeat(900)}`;
  const mint = (handles: DirectHistoryCursorHandles | undefined, cursor: string, epoch = "e1") =>
    encodeDirectHistoryCursor({ ...owner, historyEpoch: epoch, providerCursor: cursor }, handles);

  test("a short cursor is carried inline and needs no handle", () => {
    const handles = new DirectHistoryCursorHandles();
    const cursor = mint(handles, "bp1.short")!;
    expect(handles.size).toBe(0);
    expect(decodeHistoryCursor(cursor, owner)).toEqual({
      version: 2,
      epoch: "e1",
      providerCursor: "bp1.short",
    });
  });

  test("a long one is named by a handle, only for its owner and epoch", () => {
    expect(mint(undefined, long("a"))).toBeUndefined();
    const handles = new DirectHistoryCursorHandles();
    const cursor = mint(handles, long("a"))!;
    expect(cursor.length).toBeLessThanOrEqual(DIRECT_HISTORY_CURSOR_MAX_LENGTH);
    expect(decodeHistoryCursor(cursor, owner, handles)).toEqual({
      version: 2,
      epoch: "e1",
      providerCursor: long("a"),
    });
    // The same cursor again is the same handle, not a second entry.
    expect(mint(handles, long("a"))).toBe(cursor);
    expect(handles.size).toBe(1);
    // Another session, a caller holding no handles, or a forgotten session.
    expect(
      decodeHistoryCursor(cursor, { ...owner, providerSessionId: "p2" }, handles).version,
    ).toBe("invalid");
    expect(decodeHistoryCursor(cursor, owner).version).toBe("invalid");
    handles.forgetSession("other-session");
    expect(decodeHistoryCursor(cursor, owner, handles).version).toBe(2);
    handles.forgetSession("s1");
    expect(handles.size).toBe(0);
    expect(handles.bytes).toBe(0);
    expect(decodeHistoryCursor(cursor, owner, handles).version).toBe("invalid");
  });

  test("handles are bounded by count and bytes, oldest unused first", () => {
    const handles = new DirectHistoryCursorHandles({ maxEntries: 2, maxBytes: 1_000_000 });
    const a = mint(handles, long("a"))!;
    const b = mint(handles, long("b"))!;
    // Using `a` makes `b` the least recently used.
    expect(decodeHistoryCursor(a, owner, handles).version).toBe(2);
    const c = mint(handles, long("c"))!;
    expect(handles.size).toBe(2);
    expect(decodeHistoryCursor(b, owner, handles).version).toBe("invalid");
    expect(decodeHistoryCursor(a, owner, handles).version).toBe(2);
    expect(decodeHistoryCursor(c, owner, handles).version).toBe(2);

    const small = new DirectHistoryCursorHandles({ maxEntries: 100, maxBytes: 2_500 });
    for (const tag of ["a", "b", "c", "d"]) mint(small, long(tag));
    expect(small.bytes).toBeLessThanOrEqual(2_500);
    expect(small.size).toBe(2);
    small.clear();
    expect(small.size).toBe(0);
    expect(small.bytes).toBe(0);
  });
});
