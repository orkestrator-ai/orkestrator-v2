/**
 * Area suites: slow, self-contained test sets that `mise run test` runs only
 * when the change can reach them.
 *
 * An area is selected by its import graph, not by its directory. The closure
 * starts from the area's test files plus the owning package's preloads and
 * follows every runtime import (type-only imports are erased before they can
 * affect a test). If any file in that closure, or any declared non-import
 * trigger, differs from the merge base with `main`, the area runs. Changes to
 * the toolchain, dependencies, or the runner itself select every area.
 *
 * Anything uncertain selects the area: no merge base, a Git failure, or an
 * unreadable file. CI and `mise run test:full` run every area unconditionally,
 * so a coupling the graph cannot see is still caught before merge.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";

export interface TestArea {
  name: string;
  /** Repository-relative package directory whose Bun run owns these tests. */
  packageDirectory: string;
  /** Test-file globs relative to {@link packageDirectory}. */
  tests: string[];
  /**
   * Repository-relative globs for inputs the import graph cannot see: fixtures
   * read by path, scripts spawned as processes, assets resolved at runtime.
   */
  triggers: string[];
}

/**
 * Package-level wiring. Each package script appends the named variable to its
 * `bun test` arguments, so an unselected area's files are ignored there.
 */
export const AREA_IGNORE_ENV_BY_PACKAGE: Readonly<Record<string, string>> = {
  "apps/backend": "ORKESTRATOR_BACKEND_TEST_IGNORE",
};

/** Repository-relative preloads each package's `bun test` loads; part of every closure. */
const PACKAGE_PRELOADS: Readonly<Record<string, string[]>> = {
  "apps/backend": ["tests/setup-node.ts"],
};

export const TEST_AREAS: readonly TestArea[] = [
  // Real-Chromium sandbox and preview-worker suites: about a fifth of backend
  // test time, while the area itself rarely changes.
  {
    name: "transcript-artifacts",
    packageDirectory: "apps/backend",
    tests: ["src/core/transcript-artifacts/**/*.test.ts"],
    triggers: [
      "apps/backend/src/core/transcript-artifacts/**",
      "docker/artifact-preview-worker/**",
    ],
  },
  // Real tmux sessions polled on wall-clock ticks: about a tenth of backend
  // test time.
  {
    name: "tmux",
    packageDirectory: "apps/backend",
    tests: ["tests/tmux*.test.ts", "src/core/tmux*.test.ts"],
    triggers: ["apps/backend/src/core/tmux*"],
  },
];

/**
 * Changes that can alter any test's behaviour without appearing in an import
 * graph: dependency resolution, runtime and runner configuration, toolchain
 * pins, and this selection logic itself.
 */
export const WIDE_REACHING_PATTERNS: readonly string[] = [
  "**/package.json",
  "bun.lock",
  "**/bunfig.toml",
  "**/tsconfig*.json",
  "mise.toml",
  "turbo.json",
  "scripts/test-all.ts",
  "scripts/test-areas.ts",
  "scripts/test-admission.ts",
];

export const TEST_AREAS_ENV = "ORKESTRATOR_TEST_AREAS";
export const TEST_AREA_BASE_ENV = "ORKESTRATOR_TEST_AREA_BASE";
const DEFAULT_AREA_BASE = "main";

export interface AreaDecision {
  area: TestArea;
  run: boolean;
  reason: string;
}

const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

function loaderFor(file: string): "ts" | "tsx" | "js" | "jsx" {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?ts$/.test(file)) return "ts";
  return "js";
}

/**
 * Every repository file reachable from `entries` through runtime imports,
 * as repository-relative POSIX paths. Dependencies under `node_modules` are
 * not followed; the lockfile is a wide-reaching trigger instead. Workspace
 * packages resolve through their symlinks to their sources and are followed.
 */
export function importClosure(root: string, entries: string[]): Set<string> {
  const realRoot = realpathSync(root);
  const relative = (file: string) => path.relative(realRoot, file).split(path.sep).join("/");
  const inRepository = (file: string) => {
    const rel = path.relative(realRoot, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const seen = new Set<string>();
  const pending = entries.map((entry) => realpathSync(path.resolve(realRoot, entry)));
  const transpilers = new Map<string, Bun.Transpiler>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE_EXTENSION.test(file)) continue;
    const loader = loaderFor(file);
    let transpiler = transpilers.get(loader);
    if (!transpiler) {
      transpiler = new Bun.Transpiler({ loader });
      transpilers.set(loader, transpiler);
    }
    for (const { path: specifier } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (isBuiltin(specifier) || specifier === "bun" || specifier.startsWith("bun:")) continue;
      let resolved: string;
      try {
        resolved = realpathSync(Bun.resolveSync(specifier, path.dirname(file)));
      } catch (error) {
        // An incomplete graph cannot justify skipping tests. In particular,
        // deleted relative imports and broken workspace links must fail open.
        throw new Error(`Cannot resolve ${specifier} imported by ${relative(file)}`, {
          cause: error,
        });
      }
      if (inRepository(resolved) && !resolved.split(path.sep).includes("node_modules")) {
        pending.push(resolved);
      }
    }
  }
  return new Set(Array.from(seen, relative));
}

/**
 * Files that differ between the merge base with `base` and the working tree,
 * including untracked files. `undefined` means the difference is unknown and
 * every area must run.
 */
export function changedFilesSince(root: string, base: string): string[] | undefined {
  const git = (args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const mergeBase = git(["merge-base", "HEAD", base]);
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) return undefined;
  // --no-renames reports both sides of a move, so a file that left the
  // closure still counts as a change to it.
  const diff = git(["diff", "--name-only", "--no-renames", "-z", mergeBase.stdout.trim()]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (diff.status !== 0 || untracked.status !== 0) return undefined;
  return [...diff.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean);
}

function matches(file: string, pattern: string): boolean {
  return new Bun.Glob(pattern).match(file);
}

function describeChange(files: string[]): string {
  const [first, ...rest] = files;
  return rest.length === 0 ? `${first} changed` : `${first} and ${rest.length} more changed`;
}

/** Repository-relative test files of an area, sorted for stable output. */
export function areaTestFiles(root: string, area: TestArea): string[] {
  const directory = path.join(root, area.packageDirectory);
  const files = new Set<string>();
  for (const pattern of area.tests) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: directory })) {
      files.add(path.posix.join(area.packageDirectory, file.split(path.sep).join("/")));
    }
  }
  return Array.from(files).sort();
}

/**
 * Decides which areas run. {@link TEST_AREAS_ENV} set to `all` runs every
 * area; `auto` (the default outside CI) selects by change.
 */
export function selectTestAreas(options: {
  root: string;
  env: NodeJS.ProcessEnv;
  areas?: readonly TestArea[];
  changedFiles?: (root: string, base: string) => string[] | undefined;
}): AreaDecision[] {
  const areas = options.areas ?? TEST_AREAS;
  const configured = options.env[TEST_AREAS_ENV];
  const runAll = (reason: string): AreaDecision[] =>
    areas.map((area) => ({ area, run: true, reason }));
  if (configured === "all") return runAll(`${TEST_AREAS_ENV}=all`);
  if (configured === undefined && options.env.CI) return runAll("CI runs every area");
  if (configured !== undefined && configured !== "auto") {
    return runAll(`unrecognised ${TEST_AREAS_ENV}=${JSON.stringify(configured)}`);
  }

  const base = options.env[TEST_AREA_BASE_ENV] || DEFAULT_AREA_BASE;
  const changed = (options.changedFiles ?? changedFilesSince)(options.root, base);
  if (!changed) return runAll(`changes since ${base} are unknown`);
  const wide = changed.filter((file) => WIDE_REACHING_PATTERNS.some((p) => matches(file, p)));
  if (wide.length > 0) return runAll(describeChange(wide));

  return areas.map((area): AreaDecision => {
    try {
      const preloads = PACKAGE_PRELOADS[area.packageDirectory] ?? [];
      const tests = areaTestFiles(options.root, area);
      const closure = importClosure(options.root, [...tests, ...preloads]);
      const hits = changed.filter(
        (file) => closure.has(file) || area.triggers.some((pattern) => matches(file, pattern)),
      );
      return hits.length > 0
        ? { area, run: true, reason: describeChange(hits) }
        : {
            area,
            run: false,
            reason: `none of its ${closure.size} imported files changed since ${base}`,
          };
    } catch (error) {
      return {
        area,
        run: true,
        reason: `import graph unavailable (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  });
}

/**
 * Environment for the package scripts: each unselected area's test globs as
 * repeated `--path-ignore-patterns` flags, keyed by its package's variable.
 */
export function areaIgnoreEnvironment(decisions: AreaDecision[]): Record<string, string> {
  const flags = new Map<string, string[]>();
  for (const decision of decisions) {
    if (decision.run) continue;
    const variable = AREA_IGNORE_ENV_BY_PACKAGE[decision.area.packageDirectory];
    if (!variable) {
      throw new Error(`Test area ${decision.area.name} has no package ignore wiring`);
    }
    const list = flags.get(variable) ?? [];
    for (const pattern of decision.area.tests) list.push(`--path-ignore-patterns=${pattern}`);
    flags.set(variable, list);
  }
  return Object.fromEntries(Array.from(flags, ([variable, list]) => [variable, list.join(" ")]));
}
