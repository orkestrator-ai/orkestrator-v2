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

let allRepositoryFiles: string[] | undefined;

/**
 * Every tracked and untracked, non-ignored path, listed once per file run.
 *
 * Each `git ls-files -o` walks the whole working tree, so asking Git once per
 * selector made ownership cost dozens of tree walks and pushed it past the
 * test deadline under aggregate load.
 */
function listRepositoryFiles(): string[] {
  allRepositoryFiles ??= git("ls-files", "-co", "--exclude-standard")
    .split("\n")
    .filter((file) => file.length > 0);
  return allRepositoryFiles;
}

function repositoryTestFiles(): string[] {
  return listRepositoryFiles().filter((file) => TEST_FILE.test(file));
}

/** Paths equal to `prefix` or beneath it, as a literal `git ls-files -- prefix` lists them. */
function repositoryFiles(prefix: string): string[] {
  // Git expands wildcard pathspecs; keep its semantics rather than reimplement them.
  if (/[*?[]/.test(prefix)) {
    return git("ls-files", "-co", "--exclude-standard", "--", prefix)
      .split("\n")
      .filter((file) => file.length > 0);
  }
  const directory = `${prefix.replace(/\/+$/, "")}/`;
  return listRepositoryFiles().filter((file) => file === prefix || file.startsWith(directory));
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
  // Package scripts run `bun-test-tier.ts <package> <path...> -- <flags>`; its
  // paths are the selectors, of which the default tier ignores the slow files.
  const wrapper = tokens.findIndex((token) => token.endsWith("/bun-test-tier.ts"));
  if (wrapper !== -1) {
    const end = tokens.indexOf("--");
    if (end === -1) throw new Error(`Tier wrapper without "--": ${script}`);
    return tokens.slice(wrapper + 2, end).map((token) => token.replace(/^\.\//, ""));
  }
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
  return groupArgs("workspace (web, backend, desktop, web-public, cli, protocol, toolchain)")
    .filter((argument) => argument.startsWith("--filter="))
    .map((argument) => argument.slice("--filter=".length));
}

type Ownership = { root: string[]; workspace: string[]; bridges: string[] };

let ownership: Ownership | undefined;

/** Ownership is a pure function of the checkout, so every test shares one derivation. */
function buildOwnership(): Ownership {
  ownership ??= deriveOwnership();
  return ownership;
}

function deriveOwnership(): Ownership {
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

function defaultOwners(owned: Ownership, file: string): string[] {
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

  test("root tests import backend or desktop sources only as cross-package contracts", () => {
    // The root tree runs under Happy DOM, which replaces fetch, Response, the
    // abort classes and the timer queues, and swallows errors thrown from them.
    // A backend or desktop suite belongs in its own package, where it runs on
    // the platform it ships on and is typechecked with that package.
    const crossPackageContracts = new Set([
      // Build discovery must match the bridges desktop profiles build and check.
      "tests/unit/bridge-packaging.test.ts",
      "tests/unit/codex-bridge-environment.test.ts",
      // The disk report reads the database the backend writes, without migrating it.
      "tests/unit/disk-report.test.ts",
      "tests/unit/components/GitHubCloneIntegration.test.tsx",
      "tests/unit/components/SettingsPage.test.tsx",
      "tests/unit/firewall-refresh.test.ts",
      // Exercises backend normalization through the renderer's pipeline adapter.
      "tests/unit/lib/opencode-pipeline-transcript.test.ts",
      "tests/unit/migrate-copy.test.ts",
      "tests/unit/test-host-isolation.test.ts",
      "tests/unit/user-prompt-display-contract.test.ts",
      "tests/unit/workspace-setup-preserve.test.ts",
    ]);
    const sourceImport =
      /(?:from|import\(|mock\.module\()\s*["'](?:\.\.\/)+apps\/(?:backend|desktop)\//;
    const misplaced = repositoryFiles("tests")
      .filter((file) => /\.tsx?$/.test(file) && !crossPackageContracts.has(file))
      .filter((file) => sourceImport.test(read(file)));

    expect(misplaced).toEqual([]);
    for (const file of crossPackageContracts)
      expect(sourceImport.test(read(file)), file).toBe(true);
  });
});
