import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildConcurrentGroups } from "../../scripts/test-all";

const root = path.resolve(import.meta.dir, "../..");
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

function repositoryTestFiles(): string[] {
  return git("ls-files", "-co", "--exclude-standard")
    .split("\n")
    .filter((file) => TEST_FILE.test(file));
}

function repositoryFiles(prefix: string): string[] {
  return git("ls-files", "-co", "--exclude-standard", "--", prefix)
    .split("\n")
    .filter((file) => file.length > 0);
}

/** Bun test flags whose value is a separate token rather than `--flag=value`. */
const VALUE_FLAGS = new Set(["--preload", "-p", "--timings", "--reporter", "--reporter-outfile"]);

/**
 * The path selectors a `bun test` invocation actually hands to the runner.
 *
 * Ownership has to be read off the commands that run, not restated beside
 * them: a suite dropped from a package script is exactly the drift this file
 * exists to catch, and a hand-copied list cannot see it.
 */
function testSelectors(script: string): string[] {
  const tokens = script.trim().split(/\s+/);
  const start = tokens.indexOf("test");
  if (start === -1) throw new Error(`Not a bun test invocation: ${script}`);

  const selectors: string[] = [];
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    // `${VAR:+--flag ...}` expansions contribute no selector.
    if (token.includes("$") || token.includes("{")) continue;
    if (token.startsWith("-")) {
      if (!token.includes("=") && VALUE_FLAGS.has(token)) index += 1;
      continue;
    }
    selectors.push(token.replace(/^\.\//, ""));
  }
  return selectors;
}

/**
 * Resolves a package's selectors to repository-relative paths.
 *
 * Each one is checked against the repository. Misreading a flag's value as a
 * selector would widen ownership and could hide an unowned suite, so a
 * selector that names nothing fails here instead of passing quietly.
 */
function ownedPaths(packageDirectory: string, script: string): string[] {
  return testSelectors(script).map((selector) => {
    const resolved = path.posix.join(packageDirectory, selector).replace(/^\.\//, "");
    if (repositoryFiles(resolved).length === 0) {
      throw new Error(
        `Test selector "${selector}" in "${script}" matches nothing in the repository`,
      );
    }
    return resolved;
  });
}

function selects(owned: string[], file: string): boolean {
  return owned.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

/** Every workspace package, keyed by the package name Turbo filters on. */
function workspaceDirectories(): Map<string, string> {
  const directories = new Map<string, string>();
  for (const manifest of [...repositoryFiles("apps"), ...repositoryFiles("packages")]) {
    if (path.posix.basename(manifest) !== "package.json") continue;
    const directory = path.posix.dirname(manifest);
    // Only top-level workspace packages, not nested fixture manifests.
    if (directory.split("/").length !== 2) continue;
    const { name } = JSON.parse(read(manifest)) as { name?: string };
    if (name) directories.set(name, directory);
  }
  return directories;
}

function groupArgs(name: string): string[] {
  const args = buildConcurrentGroups(8).find((group) => group.name === name)?.args;
  if (!args) throw new Error(`No test group named ${name}`);
  return args;
}

/** The packages the aggregate runner's workspace group actually schedules. */
function filteredPackages(): string[] {
  return groupArgs("workspace (web, backend, desktop, web-public, cli, protocol)")
    .filter((argument) => argument.startsWith("--filter="))
    .map((argument) => argument.slice("--filter=".length));
}

function buildOwnership() {
  const directories = workspaceDirectories();

  const rootOwned = ownedPaths(".", groupArgs("root and agent-support tests").join(" "));

  const workspaceOwned: string[] = [];
  for (const packageName of filteredPackages()) {
    const directory = directories.get(packageName);
    if (!directory) throw new Error(`Unknown workspace filter: ${packageName}`);
    const { scripts } = JSON.parse(read(`${directory}/package.json`)) as {
      scripts?: Record<string, string>;
    };
    const script = scripts?.["test:workspace"];
    if (!script) throw new Error(`${packageName} has no test:workspace script`);
    workspaceOwned.push(...ownedPaths(directory, script));
  }

  const bridgeOwned: string[] = [];
  for (const manifest of repositoryFiles("bridges")) {
    if (path.posix.basename(manifest) !== "package.json") continue;
    const directory = path.posix.dirname(manifest);
    if (directory.split("/").length !== 2) continue;
    const { scripts } = JSON.parse(read(manifest)) as { scripts?: Record<string, string> };
    const script = scripts?.["test:bridge"];
    if (script) bridgeOwned.push(...ownedPaths(directory, script));
  }

  return { root: rootOwned, workspace: workspaceOwned, bridges: bridgeOwned };
}

function defaultOwners(owned: ReturnType<typeof buildOwnership>, file: string): string[] {
  const owners: string[] = [];
  if (selects(owned.root, file)) owners.push("root");
  if (selects(owned.workspace, file)) owners.push("workspace");
  if (selects(owned.bridges, file)) owners.push("bridges");
  return owners;
}

function explicitOwners(file: string): string[] {
  const owners: string[] = [];
  if (/^e2e\/(?!agent-testing\/)/.test(file)) owners.push("browser");
  if (/^e2e\/agent-testing\/.*\.spec\.ts$/.test(file)) owners.push("agent-browser/electron");
  if (file.startsWith("test-fixtures/test-diagnostics/")) owners.push("diagnostic fixture");
  return owners;
}

describe("test suite ownership", () => {
  test("every repository test has exactly one default owner or an explicit opt-in owner", () => {
    const owned = buildOwnership();
    const unowned: string[] = [];
    const duplicateDefaultOwners: string[] = [];

    for (const file of repositoryTestFiles()) {
      const defaults = defaultOwners(owned, file);
      const explicit = explicitOwners(file);
      if (defaults.length === 0 && explicit.length === 0) unowned.push(file);
      if (defaults.length > 1) duplicateDefaultOwners.push(`${file}: ${defaults.join(", ")}`);
    }

    expect(unowned).toEqual([]);
    expect(duplicateDefaultOwners).toEqual([]);
  });

  test("ownership is derived from the scripts that run, not restated beside them", () => {
    // Dropping a suite from a package script has to make the file unowned. The
    // desktop suite names its electron tests individually, so it is the case
    // where a hand-copied list would keep reporting a dropped file as covered.
    const owned = buildOwnership();
    const desktopElectronTests = repositoryFiles("apps/desktop/electron").filter((file) =>
      TEST_FILE.test(file),
    );

    expect(desktopElectronTests.length).toBeGreaterThan(0);
    for (const file of desktopElectronTests) {
      expect(defaultOwners(owned, file), file).toEqual(["workspace"]);
    }

    const withoutOne = {
      ...owned,
      workspace: owned.workspace.filter((entry) => entry !== desktopElectronTests[0]),
    };
    expect(defaultOwners(withoutOne, desktopElectronTests[0]!)).toEqual([]);
  });

  test("the ownership model agrees with the aggregate and package selectors", () => {
    const rootArgs = groupArgs("root and agent-support tests");
    expect(rootArgs).toContain("./tests");
    expect(rootArgs).toContain("./e2e/agent-testing/artifact-sanitizer.test.ts");
    expect(rootArgs).toContain("./scripts/opencode-live-compatibility-probe.test.ts");
    expect(rootArgs).toContain("./test-fixtures/agent-project/server.test.ts");

    const mise = read("mise.toml");
    expect(mise).toContain("bunx playwright test --config e2e/playwright.config.ts");
    expect(mise).toContain("e2e/agent-testing/playwright.browser.config.ts");
    expect(mise).toContain("e2e/agent-testing/playwright.electron.config.ts");
  });
});
