import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activateRelease,
  installRelease,
  isNewerVersion,
  linkedVersion,
  nextRollbackTarget,
  readLauncherState,
  readReleaseManifest,
  readServiceConfig,
  readStartupFailure,
  releaseDirectory,
  satisfiesBunRange,
  standaloneLayout,
  writeServiceConfig,
  type CommandRunner,
  type StandaloneServiceConfig,
} from "./standalone-service.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-standalone-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Stands in for `bun install`: lays out the package the release would get. */
function fakeInstall(version: string, options: { produce?: boolean } = {}): CommandRunner {
  return async (_file, args, runOptions) => {
    expect(args[0]).toBe("install");
    if (options.produce === false) return { stdout: "", stderr: "" };
    const root = path.join(runOptions.cwd!, "node_modules", "orkestrator");
    await mkdir(path.join(root, "bin"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "orkestrator", version, engines: { bun: ">=1.4.3" } }),
    );
    await writeFile(path.join(root, "bin", "orkestrator.js"), "// entry\n");
    return { stdout: "", stderr: "" };
  };
}

describe("standalone releases", () => {
  test("installs a release by one rename and reuses a complete one", async () => {
    const layout = standaloneLayout(dataDir);
    let installs = 0;
    const run: CommandRunner = async (...args) => {
      installs += 1;
      return fakeInstall("2.22.0")(...args);
    };
    const dir = await installRelease(layout, "2.22.0", { bun: "bun", run });
    expect(dir).toBe(releaseDirectory(layout, "2.22.0"));
    expect(readReleaseManifest(dir)).toEqual({ version: "2.22.0", engines: { bun: ">=1.4.3" } });
    await installRelease(layout, "2.22.0", { bun: "bun", run });
    expect(installs).toBe(1);
  });

  test("an install that produced nothing usable leaves no release behind", async () => {
    const layout = standaloneLayout(dataDir);
    await expect(
      installRelease(layout, "2.22.0", {
        bun: "bun",
        run: fakeInstall("2.22.0", { produce: false }),
      }),
    ).rejects.toThrow("produced no usable release");
    expect(existsSync(releaseDirectory(layout, "2.22.0"))).toBe(false);
  });

  test("activation moves current and remembers previous", async () => {
    const layout = standaloneLayout(dataDir);
    await installRelease(layout, "2.21.1", { bun: "bun", run: fakeInstall("2.21.1") });
    await installRelease(layout, "2.22.0", { bun: "bun", run: fakeInstall("2.22.0") });
    await activateRelease(layout, "2.21.1");
    expect(linkedVersion(layout.current)).toBe("2.21.1");
    expect(linkedVersion(layout.previous)).toBeNull();
    await activateRelease(layout, "2.22.0");
    expect(linkedVersion(layout.current)).toBe("2.22.0");
    expect(linkedVersion(layout.previous)).toBe("2.21.1");
  });

  test("reads an absent launcher state as empty", () => {
    expect(readLauncherState(standaloneLayout(dataDir))).toEqual({
      version: 1,
      lastReadyVersion: null,
      bootAttempts: {},
      rollback: null,
      bootFailure: null,
    });
  });
});

describe("startup failure", () => {
  const SINCE = Date.parse("2026-10-30T12:00:00.000Z");
  const LATER = "2026-10-30T12:00:05.000Z";
  const EARLIER = "2026-10-30T11:00:00.000Z";

  async function state(value: Record<string, unknown>, previous?: string): Promise<void> {
    const layout = standaloneLayout(dataDir);
    await mkdir(layout.root, { recursive: true });
    await writeFile(layout.stateFile, JSON.stringify({ version: 1, bootAttempts: {}, ...value }));
    if (previous) await symlink(releaseDirectory(layout, previous), layout.previous);
  }

  const read = () => readStartupFailure(standaloneLayout(dataDir), "2.0.0", SINCE);
  const failed = (exits: number, at = LATER) => ({ version: "2.0.0", exits, at });

  test("a rollback of this release names what replaced it", async () => {
    await state({
      rollback: { failedVersion: "2.0.0", restoredVersion: "1.0.0", at: LATER },
      bootFailure: failed(2),
    });
    expect(read()).toEqual({ restoredVersion: "1.0.0" });
  });

  test("records from before the install or for another release do not count", async () => {
    await state({
      rollback: { failedVersion: "2.0.0", restoredVersion: "1.0.0", at: EARLIER },
      bootFailure: failed(5, EARLIER),
    });
    expect(read()).toBeNull();
    await state({
      rollback: { failedVersion: "3.0.0", restoredVersion: "1.0.0", at: LATER },
      bootFailure: { version: "3.0.0", exits: 5, at: LATER },
    });
    expect(read()).toBeNull();
  });

  test("one exit is not a failure yet", async () => {
    await state({ bootFailure: failed(1) });
    expect(read()).toBeNull();
  });

  test("used-up boots with no previous release fail at once", async () => {
    await state({ bootFailure: failed(2) });
    expect(read()).toEqual({ restoredVersion: null });
  });

  test("used-up boots wait for the rollback that is coming", async () => {
    await state({ bootFailure: failed(2), lastReadyVersion: "1.0.0" }, "1.0.0");
    expect(read()).toBeNull();
  });

  test("a release that was ready before is never rolled back", async () => {
    await state({ bootFailure: failed(2), lastReadyVersion: "2.0.0" }, "1.0.0");
    expect(read()).toEqual({ restoredVersion: null });
  });
});

describe("rollback target", () => {
  const config = (
    args: string[],
    rollbackTarget?: { version: string; args: string[] },
  ): StandaloneServiceConfig => ({
    version: 1,
    dataDir: "/data",
    bun: "bun",
    bunVersion: "1.4.4",
    args,
    ...(rollbackTarget ? { rollbackTarget } : {}),
    installedAt: "",
  });

  test("records what the replaced release was running with", () => {
    const layout = standaloneLayout(dataDir);
    expect(nextRollbackTarget(layout, config(["--old"]), "1.0.0", "2.0.0")).toEqual({
      version: "1.0.0",
      args: ["--old"],
    });
  });

  test("a first install has nothing to go back to", () => {
    const layout = standaloneLayout(dataDir);
    expect(nextRollbackTarget(layout, null, null, "2.0.0")).toBeUndefined();
  });

  test("a release restored by a rollback keeps the arguments it ran with", async () => {
    const layout = standaloneLayout(dataDir);
    await mkdir(layout.root, { recursive: true });
    await symlink(releaseDirectory(layout, "1.0.0"), layout.previous);
    const rolledBack = config(["--new"], { version: "1.0.0", args: ["--old"] });
    expect(nextRollbackTarget(layout, rolledBack, "1.0.0", "2.0.0")).toEqual({
      version: "1.0.0",
      args: ["--old"],
    });
  });

  test("a reinstall keeps the previous release's arguments but replaces its own", () => {
    const layout = standaloneLayout(dataDir);
    const target = { version: "1.0.0", args: ["--old"] };
    expect(nextRollbackTarget(layout, config(["--new"], target), "2.0.0", "2.0.0")).toEqual(target);
    expect(nextRollbackTarget(layout, config(["--new"], target), "1.0.0", "1.0.0")).toBeUndefined();
  });

  test("reading service.json keeps a valid target and drops a malformed one", async () => {
    const layout = standaloneLayout(dataDir);
    await writeServiceConfig(layout, config([], { version: "1.0.0", args: ["--old"] }));
    expect(readServiceConfig(layout)?.rollbackTarget).toEqual({
      version: "1.0.0",
      args: ["--old"],
    });
    await writeFile(
      layout.serviceFile,
      JSON.stringify({ ...config([]), rollbackTarget: { version: 1 } }),
    );
    expect(readServiceConfig(layout)?.rollbackTarget).toBeUndefined();
  });
});

test("isNewerVersion orders releases numerically, prereleases before their release", () => {
  expect(isNewerVersion("2.22.0", "2.21.1")).toBe(true);
  expect(isNewerVersion("2.10.0", "2.9.9")).toBe(true);
  expect(isNewerVersion("2.21.1", "2.21.1")).toBe(false);
  expect(isNewerVersion("2.22.0-rc.1", "2.22.0")).toBe(false);
  expect(isNewerVersion("2.22.0", "2.22.0-rc.1")).toBe(true);
});

test("satisfiesBunRange understands the published forms", () => {
  expect(satisfiesBunRange(">=1.4.3", "1.4.3")).toBe(true);
  expect(satisfiesBunRange(">=1.4.3", "1.5.0")).toBe(true);
  expect(satisfiesBunRange(">=1.4.3", "1.4.2")).toBe(false);
  expect(satisfiesBunRange("1.4.3", "1.4.4")).toBe(false);
  expect(satisfiesBunRange(undefined, "1.0.0")).toBe(true);
});

test.each(["bootFailure", "rollback"])(
  "startup failure accepts only evidence from this install: %s",
  async (kind) => {
    const layout = standaloneLayout(dataDir);
    await mkdir(layout.root, { recursive: true });
    for (const installGeneration of [undefined, "old-install", "new-install"]) {
      await writeFile(
        layout.stateFile,
        JSON.stringify({
          version: 1,
          [kind]:
            kind === "bootFailure"
              ? { version: "2.0.0", exits: 2, at: new Date().toISOString(), installGeneration }
              : {
                  failedVersion: "2.0.0",
                  restoredVersion: "1.0.0",
                  at: new Date().toISOString(),
                  installGeneration,
                },
        }),
      );
      const failure = readStartupFailure(layout, "2.0.0", 0, "new-install");
      if (installGeneration === "new-install")
        expect(failure).toEqual({ restoredVersion: kind === "rollback" ? "1.0.0" : null });
      else expect(failure).toBeNull();
    }
  },
);
