import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activateRelease,
  installRelease,
  isNewerVersion,
  linkedVersion,
  readLauncherState,
  readReleaseManifest,
  releaseDirectory,
  satisfiesBunRange,
  standaloneLayout,
  type CommandRunner,
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
    });
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
