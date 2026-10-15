import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readPendingInstallMarker,
  writePendingInstallMarker,
  type PendingInstallMarker,
} from "./update-host.js";
import {
  claimFirstLaunchAfterUpdate,
  discardRollbackCopies,
  installedApp,
  keepRollbackCopy,
  rollBackFailedUpdate,
  type RollbackFileOps,
} from "./update-rollback.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "update-rollback-"));
  directories.push(directory);
  return directory;
}

/** Plain recursive copies stand in for ditto. */
const ops: RollbackFileOps = {
  async copy(source, destination) {
    const { cpSync } = await import("node:fs");
    cpSync(source, destination, { recursive: true });
  },
  async rename(from, to) {
    const { renameSync } = await import("node:fs");
    renameSync(from, to);
  },
  async remove(target) {
    rmSync(target, { recursive: true, force: true });
  },
  async mkdir(directory) {
    mkdirSync(directory, { recursive: true });
  },
  async list(directory) {
    const { readdirSync } = await import("node:fs");
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  },
};

function marker(overrides: Partial<PendingInstallMarker> = {}): PendingInstallMarker {
  return {
    version: 1,
    jobId: "job-1",
    fromVersion: "2.21.0",
    toVersion: "2.22.0",
    mode: "now",
    createdAt: "2026-10-15T12:00:00.000Z",
    rollbackPath: null,
    ...overrides,
  };
}

describe("installed app", () => {
  test("is the .app bundle on macOS and the AppImage on Linux", () => {
    expect(
      installedApp({
        platform: "darwin",
        exePath: "/Applications/Orkestrator AI.app/Contents/MacOS/Orkestrator AI",
        appImage: undefined,
      }),
    ).toEqual({ kind: "mac-app", path: "/Applications/Orkestrator AI.app" });
    expect(
      installedApp({
        platform: "linux",
        exePath: "/tmp/.mount/x",
        appImage: "/home/u/app.AppImage",
      }),
    ).toEqual({
      kind: "appimage",
      path: "/home/u/app.AppImage",
    });
    expect(
      installedApp({ platform: "linux", exePath: "/usr/bin/orkestrator-v2", appImage: undefined }),
    ).toBeNull();
  });
});

describe("rolling back a failed update", () => {
  function setup() {
    const root = temp();
    const app = path.join(root, "Applications", "Orkestrator AI.app");
    mkdirSync(path.join(app, "Contents"), { recursive: true });
    writeFileSync(path.join(app, "Contents", "version"), "2.21.0");
    const dataDir = path.join(root, "data");
    mkdirSync(path.join(dataDir, "backups"), { recursive: true });
    writeFileSync(path.join(dataDir, "orkestrator.sqlite"), "schema-4");
    writeFileSync(path.join(dataDir, "orkestrator.sqlite-wal"), "wal");
    return { root, app, dataDir };
  }

  test("keeps one copy of the running app, then restores it with the pre-migration database", async () => {
    const { root, app, dataDir } = setup();
    const rollbackRoot = path.join(dataDir, "updates", "rollback");
    mkdirSync(path.join(rollbackRoot, "2.20.0"), { recursive: true });
    const copy = await keepRollbackCopy({
      app: { kind: "mac-app", path: app },
      version: "2.21.0",
      rollbackRoot,
      ops,
    });
    expect(copy).toBe(path.join(rollbackRoot, "2.21.0", "Orkestrator AI.app"));
    expect(existsSync(path.join(rollbackRoot, "2.20.0"))).toBe(false);

    // The update replaces the app and its first start migrates the database.
    writeFileSync(path.join(app, "Contents", "version"), "2.22.0");
    writeFileSync(
      path.join(dataDir, "backups", "pre-migration-v3-2026-10-15T12-00-05-000Z.sqlite"),
      "schema-3",
    );
    writeFileSync(
      path.join(dataDir, "backups", "pre-migration-v2-2026-10-01T12-00-05-000Z.sqlite"),
      "ancient",
    );

    const result = await rollBackFailedUpdate({
      marker: marker({ rollbackPath: copy }),
      appVersion: "2.22.0",
      firstLaunch: true,
      app: { kind: "mac-app", path: app },
      dataDir,
      now: 42,
      ops,
    });
    expect(result).toEqual({ rolledBack: true, restoredDatabase: true });
    expect(readFileSync(path.join(app, "Contents", "version"), "utf8")).toBe("2.21.0");
    expect(readFileSync(path.join(dataDir, "orkestrator.sqlite"), "utf8")).toBe("schema-3");
    expect(existsSync(path.join(dataDir, "orkestrator.sqlite-wal"))).toBe(false);
    expect(readdirSync(dataDir).filter((name) => name.includes(".replaced-"))).toEqual([]);
    expect(existsSync(`${app}.failed-42`)).toBe(false);
    expect(existsSync(path.join(root, "Applications"))).toBe(true);
  });

  test("an update that did not migrate leaves the database alone", async () => {
    const { app, dataDir } = setup();
    const copy = await keepRollbackCopy({
      app: { kind: "mac-app", path: app },
      version: "2.21.0",
      rollbackRoot: path.join(dataDir, "rollback"),
      ops,
    });
    const result = await rollBackFailedUpdate({
      marker: marker({ rollbackPath: copy }),
      appVersion: "2.22.0",
      firstLaunch: true,
      app: { kind: "mac-app", path: app },
      dataDir,
      now: 1,
      ops,
    });
    expect(result).toEqual({ rolledBack: true, restoredDatabase: false });
    expect(readFileSync(path.join(dataDir, "orkestrator.sqlite"), "utf8")).toBe("schema-4");
  });

  test("replaces an AppImage file in place", async () => {
    const root = temp();
    const appImage = path.join(root, "Orkestrator.AppImage");
    writeFileSync(appImage, "old");
    const copy = await keepRollbackCopy({
      app: { kind: "appimage", path: appImage },
      version: "2.21.0",
      rollbackRoot: path.join(root, "rollback"),
      ops,
    });
    writeFileSync(appImage, "new");
    await rollBackFailedUpdate({
      marker: marker({ rollbackPath: copy }),
      appVersion: "2.22.0",
      firstLaunch: true,
      app: { kind: "appimage", path: appImage },
      dataDir: path.join(root, "data"),
      now: 1,
      ops,
    });
    expect(readFileSync(appImage, "utf8")).toBe("old");
  });

  test("only rolls back the update that installed this very version, once", async () => {
    const { app, dataDir } = setup();
    const base = {
      app: { kind: "mac-app" as const, path: app },
      dataDir,
      now: 1,
      ops,
      firstLaunch: true,
    };
    expect(
      await rollBackFailedUpdate({ ...base, marker: null, appVersion: "2.22.0" }),
    ).toMatchObject({ rolledBack: false });
    expect(
      await rollBackFailedUpdate({
        ...base,
        marker: marker({ rollbackPath: "/x" }),
        appVersion: "2.21.0",
      }),
    ).toMatchObject({ rolledBack: false });
    expect(await rollBackFailedUpdate({ ...base, marker: marker(), appVersion: "2.22.0" })).toEqual(
      {
        rolledBack: false,
        reason: "no copy of the previous version",
      },
    );
    expect(
      await rollBackFailedUpdate({
        ...base,
        marker: marker({ rollbackPath: "/x", rolledBack: { reason: "earlier" } }),
        appVersion: "2.22.0",
      }),
    ).toMatchObject({ rolledBack: false });
    // A later launch of the new version never rolls the update back.
    expect(
      await rollBackFailedUpdate({
        ...base,
        firstLaunch: false,
        marker: marker({ rollbackPath: "/x" }),
        appVersion: "2.22.0",
      }),
    ).toEqual({
      rolledBack: false,
      reason: "only the first launch after an update rolls it back",
    });
  });

  test("deletes the kept copy once it is no longer needed", async () => {
    const { app, dataDir } = setup();
    const rollbackRoot = path.join(dataDir, "updates", "rollback");
    await keepRollbackCopy({
      app: { kind: "mac-app", path: app },
      version: "2.21.0",
      rollbackRoot,
      ops,
    });
    await discardRollbackCopies(rollbackRoot, ops);
    expect(readdirSync(rollbackRoot)).toEqual([]);
    // Nothing kept, or no folder at all, is fine.
    await discardRollbackCopies(path.join(dataDir, "missing"), ops);
  });

  test("claims the first launch of the installed version once", async () => {
    const markerFile = path.join(temp(), "updates", "pending-install.json");
    expect(await claimFirstLaunchAfterUpdate(markerFile, "2.22.0")).toBe(false);
    await writePendingInstallMarker(markerFile, marker({ rollbackPath: "/x" }));
    expect(await claimFirstLaunchAfterUpdate(markerFile, "2.21.0")).toBe(false);
    expect(await claimFirstLaunchAfterUpdate(markerFile, "2.22.0")).toBe(true);
    expect((await readPendingInstallMarker(markerFile))?.launched).toBe(true);
    expect(await claimFirstLaunchAfterUpdate(markerFile, "2.22.0")).toBe(false);
  });
});
