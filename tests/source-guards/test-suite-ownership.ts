import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildConcurrentGroups } from "../../scripts/test-all";
import type { RepositoryIndex } from "./repository-index";

/**
 * Test suite ownership: every repository test file is run by exactly one
 * default suite (the aggregate runner's root group, a workspace package's
 * `test:workspace` script or a bridge's `test:bridge` script), or has an
 * explicit opt-in owner. Ownership is read off the commands that run, not
 * restated beside them: a suite dropped from a package script is exactly the
 * drift this check exists to catch, and a hand-copied list cannot see it.
 *
 * The repository check runs in the guard stage (`mise run guards`).
 */

const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

/** Bun test flags whose value is a separate token rather than `--flag=value`. */
const VALUE_FLAGS = new Set(["--preload", "-p", "--timings", "--reporter", "--reporter-outfile"]);

/** The path selectors a `bun test` invocation actually hands to the runner. */
export function testSelectors(script: string): string[] {
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

export function selects(owned: readonly string[], file: string): boolean {
  return owned.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

export type Ownership = { root: string[]; workspace: string[]; bridges: string[] };

export function defaultOwners(owned: Ownership, file: string): string[] {
  const owners: string[] = [];
  if (selects(owned.root, file)) owners.push("root");
  if (selects(owned.workspace, file)) owners.push("workspace");
  if (selects(owned.bridges, file)) owners.push("bridges");
  return owners;
}

export function explicitOwners(file: string): string[] {
  const owners: string[] = [];
  if (/^e2e\/(?!agent-testing\/)/.test(file)) owners.push("browser");
  if (/^e2e\/agent-testing\/.*\.spec\.ts$/.test(file)) owners.push("agent-browser/electron");
  // Opt-in live qualifications run by hand: they need host facilities (user
  // and network namespaces, Playwright Chromium) that CI runners do not grant.
  if (/^e2e\/agent-testing\/.*\.integration\.test\.ts$/.test(file))
    owners.push("agent opt-in qualification");
  if (file.startsWith("test-fixtures/test-diagnostics/")) owners.push("diagnostic fixture");
  return owners;
}

/**
 * Root tests that may import backend or desktop sources: cross-package
 * contracts. The root tree runs under Happy DOM, which replaces fetch,
 * Response, the abort classes and the timer queues, and swallows errors thrown
 * from them. A backend or desktop suite belongs in its own package, where it
 * runs on the platform it ships on and is typechecked with that package.
 */
export const CROSS_PACKAGE_CONTRACTS: ReadonlySet<string> = new Set([
  // Build discovery must match the bridges desktop profiles build and check.
  "tests/unit/bridge-packaging.test.ts",
  "tests/unit/codex-bridge-environment.test.ts",
  // Root launch arguments must agree with Docker scripts and image ownership.
  "tests/unit/container-root-boundary.test.ts",
  // The committed compatibility register must name the backend's counter ids (1008).
  "tests/unit/contract-ci.test.ts",
  // The disk report reads the database the backend writes, without migrating it.
  "tests/unit/disk-report.test.ts",
  "tests/unit/components/GitHubCloneIntegration.test.tsx",
  "tests/unit/components/SettingsPage.test.tsx",
  "tests/unit/firewall-refresh.test.ts",
  // Exercises backend normalization through the renderer's pipeline adapter.
  "tests/unit/lib/opencode-pipeline-transcript.test.ts",
  "tests/unit/migrate-copy.test.ts",
  // Deferred backend references must survive the browser's normalization.
  "tests/unit/native-agent-deferred-normalization.test.ts",
  // The goal scripts/qa-remote-goal-hold.ts seeds must be the one the backend's
  // registry, NodeCoordinatorRemote and coordinator hold on (4860 (retired)).
  "tests/unit/qa-remote-goal-hold.test.ts",
  // The busy driver badge limit must match the backend untracked-file scan cap.
  "tests/unit/recurring-live-ab-busy.test.ts",
  "tests/unit/test-host-isolation.test.ts",
  // The mail benchmark script reads the agent-accounts store the backend writes.
  "tests/unit/tmux-mail-benchmark.test.ts",
  "tests/unit/user-prompt-display-contract.test.ts",
  "tests/unit/workspace-setup-preserve.test.ts",
]);

const SOURCE_IMPORT =
  /(?:from|import\(|mock\.module\()\s*["'](?:\.\.\/)+apps\/(?:backend|desktop)\//;

const ROOT_GROUP = "root and agent-support tests";
const WORKSPACE_GROUP = "workspace (web, backend, desktop, web-public, cli, protocol, toolchain)";

function groupArgs(name: string): string[] {
  const args = buildConcurrentGroups(8).find((group) => group.name === name)?.args;
  if (!args) throw new Error(`No test group named ${name}`);
  return args;
}

/** Ownership derived from one repository listing. */
export class OwnershipModel {
  constructor(private readonly index: RepositoryIndex) {}

  /** Paths equal to `prefix` or beneath it, as a literal `git ls-files -- prefix` lists them. */
  repositoryFiles(prefix: string): string[] {
    // Git expands wildcard pathspecs; keep its semantics rather than reimplement them.
    if (/[*?[]/.test(prefix)) {
      const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "--", prefix], {
        cwd: this.index.root,
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
      return result.stdout.split("\n").filter((file) => file.length > 0);
    }
    return this.index.under(prefix);
  }

  private read(relative: string): string {
    const source = this.index.read(relative);
    if (source === null) throw new Error(`${relative} is listed but cannot be read`);
    return source;
  }

  /**
   * Resolves a package's selectors to repository-relative paths. A selector
   * that names nothing fails here instead of passing quietly: misreading a
   * flag's value as a selector would widen ownership and could hide an
   * unowned suite.
   */
  private ownedPaths(packageDirectory: string, script: string): string[] {
    return testSelectors(script).map((selector) => {
      const resolved = path.posix.join(packageDirectory, selector).replace(/^\.\//, "");
      if (this.repositoryFiles(resolved).length === 0) {
        throw new Error(
          `Test selector "${selector}" in "${script}" matches nothing in the repository`,
        );
      }
      return resolved;
    });
  }

  /** Every workspace package, keyed by the package name Turbo filters on. */
  private workspaceDirectories(): Map<string, string> {
    const directories = new Map<string, string>();
    for (const manifest of [...this.repositoryFiles("apps"), ...this.repositoryFiles("packages")]) {
      if (path.posix.basename(manifest) !== "package.json") continue;
      const directory = path.posix.dirname(manifest);
      // Only top-level workspace packages, not nested fixture manifests.
      if (directory.split("/").length !== 2) continue;
      const { name } = JSON.parse(this.read(manifest)) as { name?: string };
      if (name) directories.set(name, directory);
    }
    return directories;
  }

  derive(): Ownership {
    const directories = this.workspaceDirectories();
    const rootOwned = this.ownedPaths(".", groupArgs(ROOT_GROUP).join(" "));

    const workspaceOwned: string[] = [];
    const filtered = groupArgs(WORKSPACE_GROUP)
      .filter((argument) => argument.startsWith("--filter="))
      .map((argument) => argument.slice("--filter=".length));
    for (const packageName of filtered) {
      const directory = directories.get(packageName);
      if (!directory) throw new Error(`Unknown workspace filter: ${packageName}`);
      const { scripts } = JSON.parse(this.read(`${directory}/package.json`)) as {
        scripts?: Record<string, string>;
      };
      const script = scripts?.["test:workspace"];
      if (!script) throw new Error(`${packageName} has no test:workspace script`);
      workspaceOwned.push(...this.ownedPaths(directory, script));
    }

    const bridgeOwned: string[] = [];
    for (const manifest of this.repositoryFiles("bridges")) {
      if (path.posix.basename(manifest) !== "package.json") continue;
      const directory = path.posix.dirname(manifest);
      if (directory.split("/").length !== 2) continue;
      const { scripts } = JSON.parse(this.read(manifest)) as { scripts?: Record<string, string> };
      const script = scripts?.["test:bridge"];
      if (script) bridgeOwned.push(...this.ownedPaths(directory, script));
    }

    return { root: rootOwned, workspace: workspaceOwned, bridges: bridgeOwned };
  }

  /** Every way the checkout breaks ownership, as one line each. */
  check(): string[] {
    const problems: string[] = [];
    const owned = this.derive();

    for (const file of this.index.files.filter((candidate) => TEST_FILE.test(candidate))) {
      const defaults = defaultOwners(owned, file);
      if (defaults.length === 0 && explicitOwners(file).length === 0)
        problems.push(`unowned test file: ${file}`);
      if (defaults.length > 1)
        problems.push(
          `test file with more than one default owner: ${file}: ${defaults.join(", ")}`,
        );
    }

    // Dropping a suite from a package script has to make the file unowned. The
    // desktop suite names its electron tests individually, so it is the case
    // where a hand-copied list would keep reporting a dropped file as covered.
    const desktopElectronTests = this.repositoryFiles("apps/desktop/electron").filter((file) =>
      TEST_FILE.test(file),
    );
    if (desktopElectronTests.length === 0)
      problems.push("found no apps/desktop/electron tests to check the ownership model against");
    for (const file of desktopElectronTests) {
      const owners = defaultOwners(owned, file);
      if (owners.join() !== "workspace")
        problems.push(`${file} is owned by [${owners.join(", ")}], not the workspace suite`);
    }
    const first = desktopElectronTests[0];
    if (first) {
      const withoutOne = {
        ...owned,
        workspace: owned.workspace.filter((entry) => entry !== first),
      };
      if (defaultOwners(withoutOne, first).length > 0)
        problems.push(`dropping ${first} from its package script would not make it unowned`);
    }

    const rootArgs = groupArgs(ROOT_GROUP);
    for (const expected of [
      "./tests",
      "./e2e/agent-testing/artifact-sanitizer.test.ts",
      "./test-fixtures/agent-project/server.test.ts",
    ])
      if (!rootArgs.includes(expected))
        problems.push(`the root group no longer selects ${expected}`);
    const mise = this.read("mise.toml");
    for (const expected of [
      "bunx playwright test --config e2e/playwright.config.ts",
      "e2e/agent-testing/playwright.browser.config.ts",
      "e2e/agent-testing/playwright.electron.config.ts",
    ])
      if (!mise.includes(expected)) problems.push(`mise.toml no longer runs ${expected}`);

    for (const file of this.repositoryFiles("tests")) {
      if (!/\.tsx?$/.test(file) || CROSS_PACKAGE_CONTRACTS.has(file)) continue;
      const source = this.index.read(file);
      if (source !== null && SOURCE_IMPORT.test(source))
        problems.push(
          `${file} imports backend or desktop sources; move it to that package's tests, or list it as a cross-package contract`,
        );
    }
    for (const file of CROSS_PACKAGE_CONTRACTS) {
      const source = this.index.read(file);
      if (source === null || !SOURCE_IMPORT.test(source))
        problems.push(
          `${file} is listed as a cross-package contract but imports no backend or desktop source`,
        );
    }
    return problems;
  }
}
