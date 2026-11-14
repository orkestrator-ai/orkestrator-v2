import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectLockedRelease,
  installedFromLockfile,
  lockKeySegments,
} from "../../scripts/qualify-locked-release";

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
    "@img/sharp-linux-x64": ["@img/sharp-linux-x64@0.35.5", "", { "os": "linux", "cpu": "x64" }, "sha512-a"],
    "@img/sharp-darwin-arm64": ["@img/sharp-darwin-arm64@0.35.5", "", { "os": "darwin", "cpu": "arm64" }, "sha512-b"],
    "@img/sharp-wasm32": ["@img/sharp-wasm32@0.35.5", "", {}, "sha512-c"],
    "semver": ["semver@7.8.5", "", {}, "sha512-d"],
    "sharp": ["sharp@0.35.5", "", { "dependencies": { "semver": "^7.8.5" } }, "sha512-e"],
    "sharp/semver": ["semver@6.3.1", "", {}, "sha512-f"],
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
  const evidence = inspectLockedRelease(release());
  expect(evidence).toMatchObject({
    publishedRuntime: true,
    lockMatchesPublished: true,
    manifestMatchesPublished: true,
    lockEntries: 6,
    installedAtLockedVersion: 4,
    mismatched: [],
    extraneous: [],
    otherPlatform: 1,
    notInstalled: ["@img/sharp-wasm32"],
    direct: { sharp: "0.35.5" },
  });
  expect(evidence.lockSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(installedFromLockfile(evidence)).toBe(true);
});

test("a newer version than the lockfile names fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) => pkg(path.join(dir, "node_modules", "semver"), "semver", "7.8.6")),
  );
  expect(evidence.mismatched).toEqual([{ name: "semver", locked: "7.8.5", installed: "7.8.6" }]);
  expect(installedFromLockfile(evidence)).toBe(false);
});

test("a package the lockfile does not list fails", () => {
  const evidence = inspectLockedRelease(
    release((dir) => pkg(path.join(dir, "node_modules", "@x", "extra"), "@x/extra", "1.0.0")),
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
