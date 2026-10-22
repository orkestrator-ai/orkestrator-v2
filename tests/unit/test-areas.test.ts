import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AREA_IGNORE_ENV_BY_PACKAGE,
  areaIgnoreEnvironment,
  areaTestFiles,
  changedFilesSince,
  importClosure,
  selectTestAreas,
  TEST_AREAS,
  TEST_AREAS_ENV,
  type TestArea,
} from "../../scripts/test-areas";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const temporaryRoots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "test-areas-"));
  temporaryRoots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AREA: TestArea = {
  name: "slow",
  packageDirectory: "apps/backend",
  tests: ["src/slow/**/*.test.ts"],
  triggers: ["fixtures/slow/**"],
};

function areaFixture(): string {
  return fixture({
    "apps/backend/src/slow/slow.test.ts": 'import { run } from "./run";\nrun();\n',
    "apps/backend/src/slow/run.ts":
      'import { shared } from "../shared";\nexport const run = shared;\n',
    "apps/backend/src/shared.ts": "export const shared = () => 1;\n",
    "apps/backend/src/unrelated.ts": "export const unrelated = 1;\n",
    "tests/setup-node.ts": "export {};\n",
  });
}

describe("importClosure", () => {
  test("follows runtime imports but not type-only ones or dependencies", () => {
    const root = fixture({
      "entry.ts": [
        'import type { T } from "./typed";',
        'import { value } from "./static";',
        'export * from "./reexported";',
        'const lazy = () => import("./dynamic");',
        'const required = require("./required.js");',
        'import { dependency } from "dependency";',
        "export const used = [value, lazy, required, dependency];",
      ].join("\n"),
      "typed.ts": 'import "./only-through-types";\nexport type T = 1;\n',
      "only-through-types.ts": "export {};\n",
      "static.ts": 'import data from "./data.json";\nexport const value = data;\n',
      "data.json": "{}\n",
      "reexported.ts": "export const again = 1;\n",
      "dynamic.ts": "export {};\n",
      "required.ts": "module.exports = 1;\n",
      "node_modules/dependency/package.json": '{"name":"dependency","main":"index.js"}\n',
      "node_modules/dependency/index.js": 'require("../../static");\nexports.dependency = 1;\n',
    });

    expect(Array.from(importClosure(root, ["entry.ts"])).sort()).toEqual([
      "data.json",
      "dynamic.ts",
      "entry.ts",
      "reexported.ts",
      "required.ts",
      "static.ts",
    ]);
  });

  test("follows a workspace package through its symlink to the repository source", () => {
    const root = fixture({
      "app/entry.ts": 'import { shared } from "@scope/lib/shared";\nexport const x = shared;\n',
      "packages/lib/package.json":
        '{"name":"@scope/lib","exports":{"./shared":"./src/shared.ts"}}\n',
      "packages/lib/src/shared.ts": "export const shared = 1;\n",
    });
    mkdirSync(path.join(root, "node_modules/@scope"), { recursive: true });
    symlinkSync(path.join(root, "packages/lib"), path.join(root, "node_modules/@scope/lib"));

    expect(importClosure(root, ["app/entry.ts"])).toContain("packages/lib/src/shared.ts");
  });
});

describe("changedFilesSince", () => {
  function git(root: string, ...args: string[]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }

  test("reports committed, staged, unstaged, untracked, and both sides of a rename", () => {
    const root = fixture({ "kept.ts": "1\n", "moved.ts": "1\n", "edited.ts": "1\n" });
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "add", ".");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "base");
    git(root, "switch", "--quiet", "-c", "feature");
    writeFileSync(path.join(root, "committed.ts"), "1\n");
    git(root, "mv", "moved.ts", "renamed.ts");
    git(root, "add", ".");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "change");
    writeFileSync(path.join(root, "edited.ts"), "2\n");
    writeFileSync(path.join(root, "untracked.ts"), "1\n");

    expect(changedFilesSince(root, "main")?.sort()).toEqual([
      "committed.ts",
      "edited.ts",
      "moved.ts",
      "renamed.ts",
      "untracked.ts",
    ]);
  });

  test("is unknown when the base cannot be resolved", () => {
    const root = fixture({ "a.ts": "1\n" });
    git(root, "init", "--quiet", "--initial-branch=feature");
    git(root, "add", ".");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "only");

    expect(changedFilesSince(root, "main")).toBeUndefined();
  });
});

describe("selectTestAreas", () => {
  const select = (changed: string[] | undefined, env: NodeJS.ProcessEnv = {}) =>
    selectTestAreas({ root: areaFixture(), env, areas: [AREA], changedFiles: () => changed })[0]!;

  test("skips an area when nothing it imports changed", () => {
    const decision = select(["apps/backend/src/unrelated.ts", "docs/notes.md"]);
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain("none of its 4 imported files changed since main");
  });

  test("runs an area when a transitively imported file changed", () => {
    expect(select(["apps/backend/src/shared.ts"])).toMatchObject({
      run: true,
      reason: "apps/backend/src/shared.ts changed",
    });
  });

  test("runs an area when its preload or a declared non-import trigger changed", () => {
    expect(select(["tests/setup-node.ts"]).run).toBe(true);
    expect(select(["fixtures/slow/page.html", "a.ts"])).toMatchObject({
      run: true,
      reason: "fixtures/slow/page.html changed",
    });
  });

  test("runs every area for wide-reaching changes", () => {
    for (const file of [
      "bun.lock",
      "package.json",
      "apps/backend/package.json",
      "apps/backend/bunfig.toml",
      "tsconfig.base.json",
      "mise.toml",
      "turbo.json",
      "scripts/test-all.ts",
      "scripts/test-areas.ts",
    ]) {
      expect(select([file])).toMatchObject({ run: true, reason: `${file} changed` });
    }
  });

  test("runs every area whenever skipping cannot be justified", () => {
    expect(select(undefined).reason).toBe("changes since main are unknown");
    expect(select([], { [TEST_AREAS_ENV]: "all" }).reason).toBe(`${TEST_AREAS_ENV}=all`);
    expect(select([], { CI: "true" }).reason).toBe("CI runs every area");
    expect(select([], { [TEST_AREAS_ENV]: "sometimes" }).run).toBe(true);
    // An explicit auto still selects by change inside CI.
    expect(select([], { CI: "true", [TEST_AREAS_ENV]: "auto" }).run).toBe(false);

    const missingPreload = selectTestAreas({
      root: fixture({ "apps/backend/src/slow/slow.test.ts": "\n" }),
      env: {},
      areas: [AREA],
      changedFiles: () => ["x.ts"],
    })[0]!;
    // An unreadable graph must not skip.
    expect(missingPreload.run).toBe(true);
    expect(missingPreload.reason).toStartWith("import graph unavailable");
  });

  test("compares against an overridable base", () => {
    const bases: string[] = [];
    selectTestAreas({
      root: areaFixture(),
      env: { ORKESTRATOR_TEST_AREA_BASE: "release/2" },
      areas: [AREA],
      changedFiles: (_root, base) => {
        bases.push(base);
        return [];
      },
    });
    expect(bases).toEqual(["release/2"]);
  });
});

describe("areaIgnoreEnvironment", () => {
  test("ignores only unselected areas, one flag per test glob", () => {
    const other = { ...AREA, name: "other", tests: ["tests/a*.test.ts", "src/b/**/*.test.ts"] };
    expect(
      areaIgnoreEnvironment([
        { area: AREA, run: true, reason: "" },
        { area: other, run: false, reason: "" },
      ]),
    ).toEqual({
      ORKESTRATOR_BACKEND_TEST_IGNORE:
        "--path-ignore-patterns=tests/a*.test.ts --path-ignore-patterns=src/b/**/*.test.ts",
    });
  });

  test("refuses an area whose package cannot ignore it", () => {
    expect(() =>
      areaIgnoreEnvironment([
        { area: { ...AREA, packageDirectory: "apps/web" }, run: false, reason: "" },
      ]),
    ).toThrow("has no package ignore wiring");
  });
});

describe("repository area wiring", () => {
  const turbo = JSON.parse(readFileSync(path.join(repositoryRoot, "turbo.json"), "utf8"));

  for (const area of TEST_AREAS) {
    test(`${area.name} is wired into its package's test run`, () => {
      const variable = AREA_IGNORE_ENV_BY_PACKAGE[area.packageDirectory];
      expect(variable).toBeDefined();
      const manifest = JSON.parse(
        readFileSync(path.join(repositoryRoot, area.packageDirectory, "package.json"), "utf8"),
      );
      expect(manifest.scripts["test:workspace"]).toContain(`$${variable}`);
      expect(turbo.tasks["test:workspace"].passThroughEnv).toContain(variable);
      // A glob that matches nothing would silently stop excluding the area.
      expect(areaTestFiles(repositoryRoot, area).length).toBeGreaterThan(0);
    });
  }
});
