import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  currentHost,
  freshResolveDifferences,
  inspectLockedRelease,
  installedFromLockfile,
  lockKeySegments,
  type ReleaseHost,
  sharpLoads,
} from "../../scripts/qualify-locked-release";

/** The fixture's platform: its linux-x64 entry is the one a frozen install installs. */
const LINUX_X64: ReleaseHost = { os: "linux", cpu: "x64", libc: "glibc" };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MANIFEST = `${JSON.stringify({ name: "orkestrator-release-runtime", private: true, dependencies: { sharp: "0.35.5" } }, null, 2)}\n`;
// Bun's text lockfile: JSONC with trailing commas.
const LOCK = `{
  "lockfileVersion": 2,
  "workspaces": {
    "": {
      "name": "orkestrator-release-runtime",
      "dependencies": {
        "sharp": "0.35.5",
      },
    },
  },
  "packages": {
    "@img/sharp-linux-x64": ["@img/sharp-linux-x64@0.35.5", "", { "os": "linux", "cpu": "x64", "libc": "glibc" }, "sha512-a"],
    "@img/sharp-linuxmusl-x64": ["@img/sharp-linuxmusl-x64@0.35.5", "", { "os": "linux", "cpu": "x64", "libc": "musl" }, "sha512-h"],
    "@img/sharp-darwin-arm64": ["@img/sharp-darwin-arm64@0.35.5", "", { "os": "darwin", "cpu": "arm64" }, "sha512-b"],
    "@img/sharp-wasm32": ["@img/sharp-wasm32@0.35.5", "", { "dependencies": { "tslib": "^2.4.0" } }, "sha512-c"],
    "detect-libc": ["detect-libc@2.1.2", "", {}, "sha512-i"],
    "semver": ["semver@7.8.5", "", {}, "sha512-d"],
    "sharp": ["sharp@0.35.5", "", { "dependencies": { "detect-libc": "^2.1.2", "semver": "^6.3.1" }, "optionalDependencies": { "@img/sharp-darwin-arm64": "0.35.5", "@img/sharp-linux-x64": "0.35.5", "@img/sharp-linuxmusl-x64": "0.35.5", "@img/sharp-wasm32": "0.35.5" } }, "sha512-e"],
    "sharp/semver": ["semver@6.3.1", "", {}, "sha512-f"],
    "tslib": ["tslib@2.9.1", "", {}, "sha512-j"],
  }
}
`;

function pkg(directory: string, name: string, version: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version }));
}

/** A release directory as `installRelease` leaves it after a frozen install. */
function release(edit?: (dir: string) => void): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "qualify-locked-release-"));
  roots.push(root);
  const dir = path.join(root, "2.38.1-beta");
  const modules = path.join(dir, "node_modules");
  const runtime = path.join(modules, "orkestrator", "resources", "release-runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(runtime, "package.json"), MANIFEST);
  writeFileSync(path.join(runtime, "bun.lock"), LOCK);
  writeFileSync(path.join(dir, "package.json"), MANIFEST);
  writeFileSync(path.join(dir, "bun.lock"), LOCK);
  pkg(path.join(modules, "orkestrator"), "orkestrator", "2.38.1-beta");
  pkg(path.join(modules, "@img", "sharp-linux-x64"), "@img/sharp-linux-x64", "0.35.5");
  pkg(path.join(modules, "detect-libc"), "detect-libc", "2.1.2");
  pkg(path.join(modules, "semver"), "semver", "7.8.5");
  pkg(path.join(modules, "sharp"), "sharp", "0.35.5");
  pkg(path.join(modules, "sharp", "node_modules", "semver"), "semver", "6.3.1");
  mkdirSync(path.join(modules, ".bin"));
  edit?.(dir);
  return dir;
}

test("lock keys split into the package names along their node_modules path", () => {
  expect(lockKeySegments("sharp")).toEqual(["sharp"]);
  expect(lockKeySegments("@img/sharp-linux-x64")).toEqual(["@img/sharp-linux-x64"]);
  expect(lockKeySegments("sharp/semver")).toEqual(["sharp", "semver"]);
  expect(lockKeySegments("@a/b/@c/d/e")).toEqual(["@a/b", "@c/d", "e"]);
});

test("a frozen install of the published lockfile passes", () => {
  const evidence = inspectLockedRelease(release(), LINUX_X64);
  expect(evidence).toMatchObject({
    publishedRuntime: true,
    lockMatchesPublished: true,
    manifestMatchesPublished: true,
    lockEntries: 9,
    installedAtLockedVersion: 5,
    mismatched: [],
    extraneous: [],
    host: LINUX_X64,
    missingRequired: [],
    missingForHost: [],
    // darwin-arm64 by os, linuxmusl-x64 by libc.
    otherPlatform: 2,
    // Reached only through sharp's optional edge, and tslib only through it.
    notInstalled: ["@img/sharp-wasm32", "tslib"],
    direct: { sharp: "0.35.5" },
  });
  expect(evidence.lockSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(installedFromLockfile(evidence)).toBe(true);
});

test("a newer version than the lockfile names fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) => pkg(path.join(dir, "node_modules", "semver"), "semver", "7.8.6")),
    LINUX_X64,
  );
  expect(evidence.mismatched).toEqual([{ name: "semver", locked: "7.8.5", installed: "7.8.6" }]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a package the lockfile does not list fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) => pkg(path.join(dir, "node_modules", "@x", "extra"), "@x/extra", "1.0.0")),
    LINUX_X64,
  );
  expect(evidence.extraneous).toEqual(["@x/extra"]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a fresh resolve, with a generated manifest and no lockfile, fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) => {
      rmSync(path.join(dir, "bun.lock"));
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "orkestrator-release",
          dependencies: { orkestrator: "2.38.1-beta" },
        }),
      );
    }),
  );
  expect(evidence.lockMatchesPublished).toBe(false);
  expect(evidence.manifestMatchesPublished).toBe(false);
  expect(evidence.error).toContain("no bun.lock");
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a lockfile that differs from the published one fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) =>
      writeFileSync(path.join(dir, "bun.lock"), LOCK.replace("sha512-f", "sha512-g")),
    ),
  );
  expect(evidence.lockMatchesPublished).toBe(false);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a release with no published runtime fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) =>
      rmSync(path.join(dir, "node_modules", "orkestrator", "resources"), { recursive: true }),
    ),
  );
  expect(evidence.publishedRuntime).toBe(false);
  expect(installedFromLockfile(evidence)).toBe(false);
});

function removeModule(dir: string, ...segments: string[]) {
  rmSync(path.join(dir, "node_modules", ...segments), { recursive: true });
}

test("a missing direct dependency fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) => removeModule(dir, "sharp")),
    LINUX_X64,
  );
  // sharp's nested semver went with it; it is required through sharp.
  expect(evidence.missingRequired).toEqual(["sharp", "sharp/semver"]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a missing transitive dependency fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) => removeModule(dir, "detect-libc")),
    LINUX_X64,
  );
  expect(evidence.missingRequired).toEqual(["detect-libc"]);
  expect(evidence.notInstalled).toEqual(["@img/sharp-wasm32", "tslib"]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a missing nested copy that a dependency resolves to fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) => removeModule(dir, "sharp", "node_modules", "semver")),
    LINUX_X64,
  );
  expect(evidence.missingRequired).toEqual(["sharp/semver"]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a missing entry limited to this host fails, though it is optional", () => {
  const evidence = inspectLockedRelease(
    release((dir) => removeModule(dir, "@img", "sharp-linux-x64")),
    LINUX_X64,
  );
  expect(evidence.missingForHost).toEqual(["@img/sharp-linux-x64"]);
  expect(evidence.otherPlatform).toBe(2);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("platform limits are judged against the host, by os, cpu and libc", () => {
  const release_ = release((dir) => removeModule(dir, "@img", "sharp-linux-x64"));
  // On a musl host the glibc entry is another platform and the musl one is this host's.
  const musl = inspectLockedRelease(release_, { os: "linux", cpu: "x64", libc: "musl" });
  expect(musl.missingForHost).toEqual(["@img/sharp-linuxmusl-x64"]);
  expect(musl.otherPlatform).toBe(2);
  const mac = inspectLockedRelease(release_, { os: "darwin", cpu: "arm64", libc: null });
  expect(mac.missingForHost).toEqual(["@img/sharp-darwin-arm64"]);
  expect(mac.otherPlatform).toBe(2);
});

test("npm's list and negation forms of a platform limit are honoured", () => {
  const lock = LOCK.replace(
    `{ "os": "darwin", "cpu": "arm64" }`,
    `{ "os": ["!win32", "!darwin"], "cpu": ["arm64", "x64"] }`,
  );
  const evidence = inspectLockedRelease(
    release((dir) => {
      writeFileSync(path.join(dir, "bun.lock"), lock);
      writeFileSync(
        path.join(dir, "node_modules", "orkestrator", "resources", "release-runtime", "bun.lock"),
        lock,
      );
    }),
    LINUX_X64,
  );
  // Now admitted on linux-x64, and absent.
  expect(evidence.missingForHost).toEqual(["@img/sharp-darwin-arm64"]);
  expect(evidence.otherPlatform).toBe(1);
});

test("a dependency the lockfile does not resolve fails", () => {
  const lock = LOCK.replace(
    `"detect-libc": "^2.1.2", `,
    `"detect-libc": "^2.1.2", "color": "^4", `,
  );
  const evidence = inspectLockedRelease(
    release((dir) => {
      writeFileSync(path.join(dir, "bun.lock"), lock);
      writeFileSync(
        path.join(dir, "node_modules", "orkestrator", "resources", "release-runtime", "bun.lock"),
        lock,
      );
    }),
    LINUX_X64,
  );
  expect(evidence.missingRequired).toEqual(["color (required by sharp)"]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("an unlisted nested package fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) =>
      pkg(path.join(dir, "node_modules", "sharp", "node_modules", "@x", "extra"), "@x/extra", "1"),
    ),
    LINUX_X64,
  );
  expect(evidence.extraneous).toEqual(["sharp/@x/extra"]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a nested copy that shadows a locked top-level package fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) =>
      pkg(
        path.join(dir, "node_modules", "sharp", "node_modules", "detect-libc"),
        "detect-libc",
        "1.0.3",
      ),
    ),
    LINUX_X64,
  );
  expect(evidence.extraneous).toEqual(["sharp/detect-libc"]);
  expect(evidence.mismatched).toEqual([]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a nested copy under the release package fails, deeper nesting too", () => {
  const evidence = inspectLockedRelease(
    release((dir) => {
      const modules = path.join(dir, "node_modules");
      pkg(path.join(modules, "orkestrator", "node_modules", "semver"), "semver", "7.9.0");
      pkg(
        path.join(modules, "sharp", "node_modules", "semver", "node_modules", "@x", "deep"),
        "@x/deep",
        "1.0.0",
      );
    }),
    LINUX_X64,
  );
  expect(evidence.extraneous.sort()).toEqual(["orkestrator/semver", "sharp/semver/@x/deep"]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("an unparseable lockfile fails with its parse error", () => {
  const evidence = inspectLockedRelease(
    release((dir) => {
      writeFileSync(path.join(dir, "bun.lock"), "{ not a lockfile");
    }),
    LINUX_X64,
  );
  expect(evidence.error).toContain("bun.lock does not parse");
  expect(evidence.lockSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("the current host is described in the lockfile's own vocabulary", () => {
  const host = currentHost();
  expect(host.os).toBe(process.platform);
  expect(host.cpu).toBe(process.arch);
  if (process.platform === "linux") expect(["glibc", "musl"]).toContain(host.libc!);
  else expect(host.libc).toBeNull();
});

/** A stand-in for `bun` that runs `body` as a shell script. */
function fakeBun(body: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "qualify-locked-release-bun-"));
  roots.push(root);
  const file = path.join(root, "bun");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function scratchDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "qualify-locked-release-scratch-"));
  roots.push(root);
  return path.join(root, "fresh");
}

test("a fresh resolution lists the locked entries it would move", async () => {
  // A fresh lockfile has no nested copy of semver: it is listed only where both have it.
  const fresh = LOCK.replace("semver@7.8.5", "semver@7.9.0").replace(
    `"sharp/semver": ["semver@6.3.1", "", {}, "sha512-f"],`,
    "",
  );
  const freshFile = path.join(scratchDir(), "..", "fresh.lock");
  writeFileSync(freshFile, fresh);
  const bun = fakeBun(`cp '${freshFile}' bun.lock`);
  const result = await freshResolveDifferences(bun, release(), scratchDir());
  expect(result).toEqual([{ name: "semver", locked: "7.8.5", fresh: "7.9.0" }]);
});

test("a failed fresh resolution returns its error", async () => {
  const bun = fakeBun("echo 'registry unreachable' >&2; exit 3");
  expect(await freshResolveDifferences(bun, release(), scratchDir())).toEqual({
    error: "registry unreachable",
  });
});

test("a release without bun.lock returns an error instead of throwing", async () => {
  const bun = fakeBun("exit 0");
  const result = await freshResolveDifferences(
    bun,
    release((dir) => rmSync(path.join(dir, "bun.lock"))),
    scratchDir(),
  );
  expect(result).toMatchObject({ error: expect.stringContaining("bun.lock") });
});

test("a fresh resolution that writes no lockfile returns an error", async () => {
  const bun = fakeBun("exit 0");
  const result = await freshResolveDifferences(bun, release(), scratchDir());
  expect(result).toMatchObject({ error: expect.stringContaining("fresh/bun.lock") });
});

test("a release without package.json returns an error instead of throwing", async () => {
  const bun = fakeBun("exit 0");
  const result = await freshResolveDifferences(
    bun,
    release((dir) => rmSync(path.join(dir, "package.json"))),
    scratchDir(),
  );
  expect(result).toMatchObject({ error: expect.stringContaining("fresh resolution") });
});

test("sharp passes only when the probe reports a PNG", async () => {
  const ok = fakeBun(`echo noise; echo '{"sharp":"0.35.5","libvips":"8.18.7","format":"png"}'`);
  expect(await sharpLoads(ok, release())).toEqual({
    ok: true,
    sharp: "0.35.5",
    libvips: "8.18.7",
    format: "png",
  });
  const jpeg = fakeBun(`echo '{"sharp":"0.35.5","format":"jpeg"}'`);
  expect(await sharpLoads(jpeg, release())).toMatchObject({ ok: false, format: "jpeg" });
});

test("sharp fails with the probe's stderr, or its exit code", async () => {
  const broken = fakeBun("echo 'Could not load the sharp module' >&2; exit 1");
  expect(await sharpLoads(broken, release())).toEqual({
    ok: false,
    error: "Could not load the sharp module",
  });
  const silent = fakeBun("exit 7");
  expect(await sharpLoads(silent, release())).toEqual({ ok: false, error: "exit 7" });
});

test("sharp fails on output that is not the probe's JSON", async () => {
  const garbled = fakeBun("echo 'not json'");
  expect(await sharpLoads(garbled, release())).toMatchObject({
    ok: false,
    error: expect.stringContaining("unexpected output"),
  });
});

test("sharp fails when the probe outlives its timeout", async () => {
  const hung = fakeBun("exec sleep 30");
  const result = await sharpLoads(hung, release(), 200);
  expect(result.ok).toBe(false);
});

test("sharp and the fresh resolution report a bun that cannot run instead of throwing", async () => {
  const missing = path.join(scratchDir(), "no-such-bun");
  expect(await sharpLoads(missing, release())).toMatchObject({
    ok: false,
    error: expect.stringContaining("could not run"),
  });
  expect(await freshResolveDifferences(missing, release(), scratchDir())).toMatchObject({
    error: expect.stringContaining("could not run"),
  });
});
