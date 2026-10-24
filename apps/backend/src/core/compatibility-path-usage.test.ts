import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeBridgeSessionRetaining } from "./bridge-session-close.js";
import {
  COMPATIBILITY_PATH_USAGE_STORE,
  CompatibilityPathUsage,
  compatibilityPathUsage,
  normalizeCompatibilityPathUsage,
  type CompatibilityPathUsageSink,
} from "./compatibility-path-usage.js";
import { compatibilityPathUsageDatabaseSink } from "./compatibility-path-usage-store.js";
import { openBackendDatabase } from "./storage-stores.js";

const dirs: string[] = [];

async function dataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-compat-usage-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function clock(start = Date.parse("2026-10-24T10:00:00.000Z")) {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("CompatibilityPathUsage", () => {
  test("counts each path with its first and last use, without a sink", () => {
    const time = clock();
    const usage = new CompatibilityPathUsage(time.now);
    usage.record("bridge-close.legacy-delete");
    time.advance(1_000);
    usage.record("bridge-close.legacy-delete");
    usage.record("history.joined-v1-page");

    expect(usage.snapshot()).toEqual({
      version: 1,
      paths: {
        "bridge-close.legacy-delete": {
          count: 2,
          firstSeenAt: "2026-10-24T10:00:00.000Z",
          lastSeenAt: "2026-10-24T10:00:01.000Z",
        },
        "history.joined-v1-page": {
          count: 1,
          firstSeenAt: "2026-10-24T10:00:01.000Z",
          lastSeenAt: "2026-10-24T10:00:01.000Z",
        },
      },
    });
    // Without a sink nothing is lost by reading.
    expect(usage.snapshot().paths["bridge-close.legacy-delete"]?.count).toBe(2);
  });

  test("persists totals across backends sharing a data directory", async () => {
    const dir = await dataDir();
    const time = clock();
    const first = new CompatibilityPathUsage(time.now);
    const firstSink = compatibilityPathUsageDatabaseSink(dir);
    first.record("slash-catalogue.legacy-route");
    first.attach(firstSink);
    first.record("slash-catalogue.legacy-route");
    first.detach(firstSink);

    time.advance(60_000);
    const second = new CompatibilityPathUsage(time.now);
    const secondSink = compatibilityPathUsageDatabaseSink(dir);
    second.attach(secondSink);
    second.record("slash-catalogue.legacy-route");
    expect(second.snapshot().paths["slash-catalogue.legacy-route"]).toEqual({
      count: 3,
      firstSeenAt: "2026-10-24T10:00:00.000Z",
      lastSeenAt: "2026-10-24T10:01:00.000Z",
    });
    second.detach(secondSink);

    // The stored document holds only ids, counts and times.
    const database = openBackendDatabase(dir);
    try {
      expect(database.readStore(COMPATIBILITY_PATH_USAGE_STORE)?.value).toEqual({
        version: 1,
        paths: {
          "slash-catalogue.legacy-route": {
            count: 3,
            firstSeenAt: "2026-10-24T10:00:00.000Z",
            lastSeenAt: "2026-10-24T10:01:00.000Z",
          },
        },
      });
    } finally {
      database.close();
    }
  });

  test("flushes on its timer once a sink is attached", async () => {
    const merged: number[] = [];
    const sink: CompatibilityPathUsageSink = {
      merge: (pending) => {
        merged.push(pending.get("preview.legacy-loopback-route")?.count ?? 0);
        return { version: 1, paths: {} };
      },
    };
    const usage = new CompatibilityPathUsage(undefined, 5);
    usage.attach(sink);
    usage.record("preview.legacy-loopback-route");
    usage.record("preview.legacy-loopback-route");
    const deadline = Date.now() + 1_000;
    while (merged.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(merged).toEqual([2]);
    usage.detach(sink);
  });

  test("keeps pending counts when the sink fails", () => {
    let fail = true;
    const sink: CompatibilityPathUsageSink = {
      merge: (pending) => {
        if (fail) throw new Error("database is busy");
        return {
          version: 1,
          paths: {
            "mcp-report.unmarked-config": { ...pending.get("mcp-report.unmarked-config")! },
          },
        };
      },
    };
    const usage = new CompatibilityPathUsage(clock().now);
    usage.attach(sink);
    usage.record("mcp-report.unmarked-config");
    expect(usage.snapshot().paths["mcp-report.unmarked-config"]?.count).toBe(1);
    fail = false;
    usage.record("mcp-report.unmarked-config");
    expect(usage.snapshot().paths["mcp-report.unmarked-config"]?.count).toBe(2);
    usage.detach(sink);
  });

  test("never recreates a data directory that was removed", async () => {
    const dir = path.join(await dataDir(), "gone");
    const usage = new CompatibilityPathUsage(clock().now);
    const sink = compatibilityPathUsageDatabaseSink(dir);
    usage.attach(sink);
    usage.record("bridge-transcript.messages-fallback");
    expect(usage.snapshot().paths["bridge-transcript.messages-fallback"]?.count).toBe(1);
    usage.detach(sink);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  test("detaching a sink that was replaced leaves the current one attached", () => {
    const merges: string[] = [];
    const sinkFor = (name: string): CompatibilityPathUsageSink => ({
      merge: () => {
        merges.push(name);
        return { version: 1, paths: {} };
      },
    });
    const first = sinkFor("first");
    const second = sinkFor("second");
    const usage = new CompatibilityPathUsage(clock().now);
    usage.attach(first);
    usage.attach(second);
    usage.detach(first);
    usage.snapshot();
    expect(merges).toEqual(["first", "second"]);
    usage.detach(second);
  });
});

describe("normalizeCompatibilityPathUsage", () => {
  test("keeps only known ids with valid counts and times", () => {
    expect(
      normalizeCompatibilityPathUsage({
        version: 1,
        paths: {
          "bridge-close.legacy-delete": {
            count: 4,
            firstSeenAt: "2026-10-20T00:00:00.000Z",
            lastSeenAt: "2026-10-21T00:00:00.000Z",
          },
          "a-path-a-newer-backend-counts": {
            count: 1,
            firstSeenAt: "2026-10-20T00:00:00.000Z",
            lastSeenAt: "2026-10-20T00:00:00.000Z",
          },
          "history.joined-v1-page": { count: -1, firstSeenAt: "x", lastSeenAt: "y" },
        },
      }),
    ).toEqual({
      version: 1,
      paths: {
        "bridge-close.legacy-delete": {
          count: 4,
          firstSeenAt: "2026-10-20T00:00:00.000Z",
          lastSeenAt: "2026-10-21T00:00:00.000Z",
        },
      },
    });
    expect(normalizeCompatibilityPathUsage(null)).toEqual({ version: 1, paths: {} });
  });
});

describe("compatibility paths record their use", () => {
  test("the legacy DELETE close counts once per close", async () => {
    const before =
      compatibilityPathUsage.snapshot().paths["bridge-close.legacy-delete"]?.count ?? 0;
    await closeBridgeSessionRetaining("codex", "s1", async (method) =>
      method === "POST" ? new Response(null, { status: 404 }) : new Response(null, { status: 204 }),
    );
    expect(compatibilityPathUsage.snapshot().paths["bridge-close.legacy-delete"]?.count).toBe(
      before + 1,
    );
  });
});
