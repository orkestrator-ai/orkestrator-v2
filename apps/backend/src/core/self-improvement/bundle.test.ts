import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseEssentialLines, readBundle } from "./bundle.js";
import {
  bundleArchive,
  bundleDirectory,
  type FixtureBundle,
  healthRun,
  HOUR,
  temporaryDirectory,
} from "./testing/fixtures.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(): string {
  const { dir, remove } = temporaryDirectory("improvement-bundle-");
  cleanups.push(remove);
  return dir;
}

const BUNDLE: FixtureBundle = {
  createdAt: NOW,
  appVersion: "2.30.1",
  essential: [
    {
      at: NOW - 3 * HOUR,
      level: "info",
      area: "backend",
      event: "starting",
      fields: { version: "2.30.1" },
    },
    {
      at: NOW - HOUR,
      level: "error",
      area: "storage",
      event: "snapshot.failed",
      fields: { "error.code": "EIO" },
    },
  ],
  health: healthRun({ pid: 10, startedAt: NOW - 3 * HOUR, hours: 3, clean: false }),
  database: {
    main: { fileBytes: 1, walBytes: 2, freelistBytes: 3 },
    leaseWaits: {
      families: { kanban: { acquired: 4, timedOut: 1, maxWaitMs: 50 } },
      transactionsBusy: 2,
    },
    slowOperations: { series: { "main:select:sessions": { count: 5, totalMs: 900, maxMs: 400 } } },
  },
};

describe("readBundle", () => {
  test("reads the archive's manifest, essential log, health rows and database figures", async () => {
    const file = path.join(scratch(), "bundle.tar.gz");
    writeFileSync(file, await bundleArchive(BUNDLE));
    const data = await readBundle(file);
    expect(data.manifest.appVersion).toBe("2.30.1");
    expect(data.manifest.absent.map((item) => item.name)).toEqual(["container server logs"]);
    expect(data.essential.map((entry) => entry.event)).toEqual(["starting", "snapshot.failed"]);
    expect(data.essential[1]!.fields["error.code"]).toBe("EIO");
    expect(data.health.length).toBeGreaterThan(30);
    expect(data.database?.leaseFamilies.kanban?.timedOut).toBe(1);
    expect(data.database?.transactionsBusy).toBe(2);
    expect(data.database?.slowSeries["main:select:sessions"]?.count).toBe(5);
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reads an extracted directory the same way", async () => {
    const dir = bundleDirectory(scratch(), BUNDLE);
    const data = await readBundle(dir);
    expect(data.essential).toHaveLength(2);
    expect(data.database?.mainWalBytes).toBe(2);
  });

  test("ignores entries it does not use and any name that leaves the bundle", async () => {
    const file = path.join(scratch(), "bundle.tar.gz");
    writeFileSync(
      file,
      await bundleArchive({
        ...BUNDLE,
        extra: [
          { name: "../escape/logs/essential/x.jsonl", contents: "{}" },
          { name: "logs/debug/orkestrator.log", contents: "debug text" },
        ],
      }),
    );
    const data = await readBundle(file);
    expect(data.essential).toHaveLength(2);
  });

  test("refuses an archive with no manifest", async () => {
    const dir = scratch();
    await expect(readBundle(dir)).rejects.toThrow(/manifest/);
  });

  test("orders rotated essential files oldest first", async () => {
    const dir = bundleDirectory(scratch(), { createdAt: NOW, essential: [] });
    writeFileSync(
      path.join(dir, "logs", "essential", "essential.1.jsonl"),
      `${JSON.stringify({ ts: new Date(NOW - 2 * HOUR).toISOString(), level: "warn", area: "a", event: "older" })}\n`,
    );
    writeFileSync(
      path.join(dir, "logs", "essential", "essential.jsonl"),
      `${JSON.stringify({ ts: new Date(NOW - HOUR).toISOString(), level: "warn", area: "a", event: "newer" })}\n`,
    );
    const data = await readBundle(dir);
    expect(data.essential.map((entry) => entry.event)).toEqual(["older", "newer"]);
  });
});

describe("parseEssentialLines", () => {
  test("counts unreadable lines and keeps only scalar fields", () => {
    const parsed = parseEssentialLines(
      [
        "not json",
        JSON.stringify({ ts: "nope", area: "a", event: "b" }),
        JSON.stringify({
          ts: "2026-11-09T10:00:00.000Z",
          level: "error",
          area: "a",
          event: "b",
          fields: { kept: 1, nested: { dropped: true } },
        }),
      ].join("\n"),
    );
    expect(parsed.unreadable).toBe(2);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.fields).toEqual({ kept: 1 });
  });
});
