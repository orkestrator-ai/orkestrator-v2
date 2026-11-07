import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  REALM_PARTITION_DIRECTORY,
  removeRealmPartitions,
} from "../electron/realm-partition-cleanup";
import { connectionPartitionKey } from "../electron/desktop-window-lifecycle";

const HASH = connectionPartitionKey("bk_leaf");
/** What Electron made of `persist:orkestrator-realm-<slot>-<hash>` (checked against Electron 45). */
const realm = (slot: number, hash = HASH) => `orkestrator-realm-${slot}-${hash}`;

let root: string;
let userData: string;
let partitions: string;
let logs: LogCapture;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ork-realm-partitions-"));
  userData = path.join(root, "userData");
  partitions = path.join(userData, "Partitions");
  logs = captureLogs();
});

afterEach(async () => {
  logs.restore();
  await rm(root, { recursive: true, force: true });
});

async function partitionDir(name: string, parent = partitions): Promise<string> {
  const directory = path.join(parent, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "Preferences"), "{}");
  return directory;
}

describe("removing the retired realm partitions", () => {
  test("only directories named exactly like a realm partition, under userData's Partitions", async () => {
    await partitionDir(realm(1));
    await partitionDir(realm(32, connectionPartitionKey("bk_other")));
    await partitionDir(realm(0));
    const kept = [
      `orkestrator-renderer-1-${HASH}`,
      `orkestrator-browser-previews-1-${HASH}`,
      `orkestrator-preview-svc-1-${HASH}-${HASH}`,
      `${realm(1)}-extra`,
      `x-${realm(1)}`,
      `orkestrator-realm-1-${HASH.slice(1)}`,
      `orkestrator-realm-1-${HASH.toUpperCase().replace(/[0-9]/gu, "A")}`,
      `orkestrator-realm-1234-${HASH}`,
      `orkestrator-realm--${HASH}`,
      "orkestrator-realm",
    ];
    for (const name of kept) await partitionDir(name);
    // A file and a symbolic link with a realm partition's name are not partitions.
    await writeFile(path.join(partitions, realm(5)), "not a directory");
    const outside = await partitionDir("elsewhere", root);
    await symlink(outside, path.join(partitions, realm(6)));
    // The same name outside `Partitions` is not Electron's partition storage.
    const besideUserData = await partitionDir(realm(1), userData);

    expect(await removeRealmPartitions(userData)).toEqual({ removed: 3, failed: 0 });

    expect((await readdir(partitions)).sort()).toEqual([...kept, realm(5), realm(6)].sort());
    expect(existsSync(path.join(outside, "Preferences"))).toBe(true);
    expect(existsSync(path.join(besideUserData, "Preferences"))).toBe(true);
  });

  test("is idempotent: a second start removes nothing and logs nothing", async () => {
    await partitionDir(realm(2));
    expect(await removeRealmPartitions(userData)).toEqual({ removed: 1, failed: 0 });
    logs.lines.length = 0;
    expect(await removeRealmPartitions(userData)).toEqual({ removed: 0, failed: 0 });
    expect(logs.lines).toEqual([]);
  });

  test("a profile without partitions, or without userData, is left alone quietly", async () => {
    expect(await removeRealmPartitions(userData)).toEqual({ removed: 0, failed: 0 });
    await mkdir(partitions, { recursive: true });
    expect(await removeRealmPartitions(userData)).toEqual({ removed: 0, failed: 0 });
    expect(logs.lines).toEqual([]);
  });

  test("the log carries counts only, never a name or a path", async () => {
    await partitionDir(realm(3));
    await partitionDir(realm(4));
    await removeRealmPartitions(userData);
    expect(logs.records().map((record) => [record.event, record.fields])).toEqual([
      ["realm-partitions.removed", { count: 2 }],
    ]);
    for (const line of logs.lines) {
      expect(line).not.toContain(HASH);
      expect(line).not.toContain(root);
    }
  });

  test("a directory that cannot be removed is counted and the rest still go", async () => {
    await partitionDir(realm(7));
    await partitionDir(realm(8));
    const removed: string[] = [];
    const result = await removeRealmPartitions(userData, {
      readdir: (directory) => readdir(directory, { withFileTypes: true }),
      rm: async (target) => {
        if (target.endsWith(realm(7))) throw new Error("busy");
        removed.push(path.basename(target));
        await rm(target, { recursive: true, force: true });
      },
    });
    expect(result).toEqual({ removed: 1, failed: 1 });
    expect(removed).toEqual([realm(8)]);
    expect(logs.records().map((record) => [record.event, record.fields])).toEqual([
      ["realm-partitions.removed", { count: 1 }],
      ["realm-partitions.remove-failed", { count: 1 }],
    ]);
  });

  test("an unreadable partitions directory is reported without its path", async () => {
    const result = await removeRealmPartitions(userData, {
      readdir: async () => {
        throw Object.assign(new Error(`EACCES: ${partitions}`), { code: "EACCES" });
      },
      rm: async () => undefined,
    });
    expect(result).toEqual({ removed: 0, failed: 0 });
    expect(logs.records().map((record) => record.event)).toEqual(["realm-partitions.list-failed"]);
    for (const line of logs.lines) expect(line).not.toContain(root);
  });

  test("the pattern is the partition name `rendererPartitionForRealm` used, without `persist:`", () => {
    expect(REALM_PARTITION_DIRECTORY.test(realm(1))).toBe(true);
    expect(REALM_PARTITION_DIRECTORY.test(`persist:${realm(1)}`)).toBe(false);
  });
});
