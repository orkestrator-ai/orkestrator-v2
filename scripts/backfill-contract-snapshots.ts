#!/usr/bin/env bun
/**
 * Writes the contract snapshot of every published release that has none
 * (plan item 1007, docs/reports/unified-federation.md §11.3 step 2), and
 * records each published release's publication time in
 * `packages/protocol/contracts/releases/index.json`.
 *
 *   mise run contract:backfill                    # snapshot what is missing
 *   mise run contract:backfill -- --only 2.21.0   # only these versions
 *   mise run contract:backfill -- --check         # verify, no writes, no checkouts
 *
 * Published means a non-draft GitHub release (docs/architecture/version-compatibility.md),
 * read with `gh release list` (read-only). A release whose tag commits a
 * contract manifest is split from that manifest (`git show`, no checkout).
 * Every other release is pre-contract: it is checked out in a detached
 * worktree under `output/contract-backfill/` and installed with the Bun its
 * `mise.toml` pins (`--frozen-lockfile --ignore-scripts`), and a child process
 * running that Bun lists the release's own `createCommandRegistry()` and, when
 * the release has one, its `isNodeReadCommand` classifier. The child runs the
 * way `generate-contract-manifest.ts` runs its own: a constructed environment
 * (temporary HOME and XDG directories, an empty PATH, nothing inherited, so no
 * data directory or port of this host is reachable), a refusing `fetch`, no
 * command executed. Domains come from this tree's
 * `apps/backend/src/core/contract-domain-map.ts`. Each worktree is removed as
 * soon as its release is listed, and only paths this run created are removed.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTRACT_DOMAIN_MAP,
  contractDomainsByCommand,
  type ContractDomainMap,
} from "../apps/backend/src/core/contract-domain-map.js";
import {
  CONTRACTS_DIRECTORY,
  GH_RELEASE_LIST_COMMAND,
  parseGitHubReleases,
  readReleaseIndex,
  readReleaseSnapshot,
  releaseInputFromManifest,
  releaseInputFromRegistry,
  releaseSnapshotFile,
  withReleaseIndexEntries,
  writeReleaseIndex,
  writeReleaseSnapshot,
  type PublishedRelease,
  type ReleaseContractInput,
} from "./contract-snapshots.js";
import type { ContractManifest } from "./generate-contract-manifest.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const scriptPath = path.join(import.meta.dir, "backfill-contract-snapshots.ts");

/** Where the temporary worktrees go, relative to the repository root (ignored by Git). */
export const BACKFILL_WORK_DIRECTORY = "output/contract-backfill";
const CHILD_FLAG = "--child";
const CHILD_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMMANDS = 10_000;
const MANIFEST_PATH = `${CONTRACTS_DIRECTORY}/manifest.json`;

/** What the child reports about a release's registry. */
export interface RegistryListing {
  /** Sorted, unique. */
  readonly names: readonly string[];
  /** The read commands, or `null` when the release has no classifier. */
  readonly read: readonly string[] | null;
}

export interface BackfillRuntime {
  readonly contractsDirectory: string;
  /** Throws when the releases cannot be listed. */
  listPublishedReleases(): readonly PublishedRelease[];
  /** The commit a tag points at. */
  resolveTag(tag: string): string;
  /** The contract manifest committed at `commit`, or `null` (a pre-contract release). */
  manifestAt(commit: string): string | null;
  /** Lists a pre-contract release's registry from a checkout of `commit`. */
  listRegistry(release: PublishedRelease, commit: string): Promise<RegistryListing>;
  /** Each command's domain. Defaults to {@link currentDomainOf} of this tree. */
  readonly domainOf?: ReadonlyMap<string, string>;
  log(line: string): void;
}

export interface BackfillOptions {
  readonly check: boolean;
  /** Versions to consider; all published releases when empty. */
  readonly only: readonly string[];
}

export function parseArguments(args: readonly string[]): BackfillOptions {
  let check = false;
  const only: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") check = true;
    else if (arg === "--only" && args[index + 1]) only.push(args[++index]!.replace(/^v/u, ""));
    else {
      throw new Error(
        "usage: bun scripts/backfill-contract-snapshots.ts [--check] [--only <version>]...",
      );
    }
  }
  return { check, only };
}

/**
 * Every current command's domain: the committed manifest's (string commands
 * from the domain map, defined commands from their definition), then the
 * domain map for anything the manifest lacks. The map alone would lose a
 * command once it is converted to `defineCommand` and leaves the map.
 * `map` is the domain map (empty since 7009); a test passes its own.
 */
export function currentDomainOf(
  root: string,
  map: ContractDomainMap = CONTRACT_DOMAIN_MAP,
): ReadonlyMap<string, string> {
  const domainOf = new Map<string, string>(contractDomainsByCommand(map));
  const manifestFile = path.join(root, MANIFEST_PATH);
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as ContractManifest;
    for (const [name, entry] of Object.entries(manifest.commands)) domainOf.set(name, entry.domain);
  }
  return domainOf;
}

/** The snapshot input of one published release. */
export async function releaseInput(
  release: PublishedRelease,
  runtime: BackfillRuntime,
  domainOf: ReadonlyMap<string, string>,
): Promise<ReleaseContractInput> {
  const commit = runtime.resolveTag(release.tag);
  const manifest = runtime.manifestAt(commit);
  if (manifest !== null) {
    return releaseInputFromManifest(release.version, JSON.parse(manifest) as ContractManifest, {
      commit,
    });
  }
  const listing = await runtime.listRegistry(release, commit);
  const read = listing.read === null ? null : new Set(listing.read);
  return releaseInputFromRegistry({
    version: release.version,
    commit,
    names: listing.names,
    isRead: read === null ? undefined : (command) => read.has(command),
    domainOf,
  });
}

/**
 * Snapshots every selected published release that has no snapshot and records
 * the publication times, or with `check` reports what is missing or stale.
 * Returns the exit status.
 */
export async function backfillContractSnapshots(
  options: BackfillOptions,
  runtime: BackfillRuntime,
): Promise<number> {
  const published = runtime
    .listPublishedReleases()
    .filter((release) => options.only.length === 0 || options.only.includes(release.version));
  const unknown = options.only.filter(
    (version) => !published.some((release) => release.version === version),
  );
  if (unknown.length > 0) {
    runtime.log(`Not a published release: ${unknown.join(", ")}.`);
    return 1;
  }
  const domainOf = runtime.domainOf ?? currentDomainOf(repoRoot);
  const problems: string[] = [];
  let created = 0;
  for (const release of published) {
    const file = path.join(runtime.contractsDirectory, releaseSnapshotFile(release.version));
    if (existsSync(file)) {
      try {
        readReleaseSnapshot(runtime.contractsDirectory, release.version);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    if (options.check) {
      problems.push(`${release.version} (published ${release.publishedAt}) has no snapshot.`);
      continue;
    }
    runtime.log(`Snapshotting ${release.version}…`);
    const input = await releaseInput(release, runtime, domainOf);
    const { release: written, written: files } = writeReleaseSnapshot(
      runtime.contractsDirectory,
      input,
    );
    created += 1;
    runtime.log(
      `  ${releaseSnapshotFile(release.version)}: ${written.counts.commands} commands` +
        `${written.preContract ? " (pre-contract)" : ""}, ${written.counts.unmapped} unmapped, ` +
        `${files.filter((name) => name.startsWith("domains/")).length} new domain blobs.`,
    );
  }
  const index = readReleaseIndex(runtime.contractsDirectory);
  const updated = withReleaseIndexEntries(index, published);
  if (options.check) {
    for (const release of published) {
      const entry = index.releases.find((candidate) => candidate.version === release.version);
      if (entry?.publishedAt !== release.publishedAt) {
        problems.push(`releases/index.json does not record ${release.version}'s publication.`);
      }
    }
  } else if (writeReleaseIndex(runtime.contractsDirectory, updated)) {
    runtime.log("Updated releases/index.json.");
  }
  for (const entry of updated.releases) {
    if (!existsSync(path.join(runtime.contractsDirectory, releaseSnapshotFile(entry.version)))) {
      problems.push(`releases/index.json lists ${entry.version}, which has no snapshot.`);
    }
  }
  if (problems.length > 0) {
    runtime.log("Contract snapshots are incomplete:");
    for (const problem of problems) runtime.log(`  - ${problem}`);
    if (options.check) runtime.log("Run `mise run contract:backfill` and commit the result.");
    return 1;
  }
  runtime.log(
    options.check
      ? `Every published release (${published.length}) has a snapshot.`
      : `${created} snapshot(s) written; ${published.length} published releases recorded.`,
  );
  return 0;
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.status}`);
  }
  return result.stdout;
}

/** The Bun a checkout pins in its `mise.toml`, installed through mise when missing. */
export function pinnedBun(tree: string): string {
  const version = /^bun\s*=\s*"([^"]+)"/mu.exec(
    readFileSync(path.join(tree, "mise.toml"), "utf8"),
  )?.[1];
  if (!version) throw new Error(`${tree} pins no Bun version in mise.toml`);
  const where = () => spawnSync("mise", ["where", `bun@${version}`], { encoding: "utf8" });
  let found = where();
  if (found.status !== 0) {
    const install = spawnSync("mise", ["install", `bun@${version}`], { stdio: "inherit" });
    if (install.status !== 0) throw new Error(`mise install bun@${version} failed`);
    found = where();
  }
  if (found.status !== 0) throw new Error(`mise cannot find bun@${version}`);
  return path.join(found.stdout.trim(), "bin", "bun");
}

function installRelease(bun: string, tree: string, tmp: string): void {
  // Lifecycle scripts never run: the registry needs only the sources, and a
  // release's postinstall must not reach anything outside its checkout.
  const result = spawnSync(bun, ["install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: tree,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LANG: process.env.LANG ?? "C.UTF-8",
      TMPDIR: tmp,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `bun install in ${tree} failed: ${String(result.stderr ?? "").trim() || result.status}`,
    );
  }
}

export interface ListRegistryOptions {
  readonly repoRoot: string;
  /** Holds this run's worktrees and sandboxes; created, and removed when empty. */
  readonly workDirectory: string;
  readonly resolveBun?: (tree: string) => string;
  readonly install?: (bun: string, tree: string, tmp: string) => void;
  readonly log?: (line: string) => void;
}

/**
 * Checks `commit` out in a detached worktree of `repoRoot` under
 * `workDirectory`, installs it, lists its registry in a sandboxed child and
 * removes the worktree, whatever happened.
 */
export async function listRegistryInWorktree(
  release: PublishedRelease,
  commit: string,
  options: ListRegistryOptions,
): Promise<RegistryListing> {
  mkdirSync(options.workDirectory, { recursive: true });
  const run = mkdtempSync(path.join(options.workDirectory, `${release.version}-`));
  const tree = path.join(run, "tree");
  let created = false;
  try {
    git(options.repoRoot, ["worktree", "add", "--detach", tree, commit]);
    created = true;
    activeWorktrees.add({ repoRoot: options.repoRoot, tree });
    const version = (
      JSON.parse(readFileSync(path.join(tree, "package.json"), "utf8")) as {
        version?: string;
      }
    ).version;
    if (version !== release.version) {
      throw new Error(`${release.tag} (${commit}) is version ${String(version)}`);
    }
    const bun = (options.resolveBun ?? pinnedBun)(tree);
    const tmp = path.join(run, "tmp");
    mkdirSync(tmp, { recursive: true });
    options.log?.(`  installing ${release.tag} (${commit.slice(0, 9)}) with ${bun}`);
    (options.install ?? installRelease)(bun, tree, tmp);
    return await listInChild(bun, tree, path.join(run, "sandbox"));
  } finally {
    if (created) removeWorktree(options.repoRoot, tree);
    rmSync(run, { recursive: true, force: true });
    try {
      // Only when empty: another run's directory is never touched.
      rmdirSync(options.workDirectory);
    } catch {
      // Not empty (a concurrent run) or already gone.
    }
  }
}

/** Worktrees this process created and has not removed yet, for the signal handler. */
const activeWorktrees = new Set<{ readonly repoRoot: string; readonly tree: string }>();

function removeWorktree(root: string, tree: string): void {
  const result = spawnSync("git", ["-C", root, "worktree", "remove", "--force", tree], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(
      `Could not remove the worktree ${tree}: ${result.stderr.trim()}. Remove it with \`git worktree remove --force ${tree}\`.`,
    );
  }
  for (const entry of activeWorktrees) if (entry.tree === tree) activeWorktrees.delete(entry);
}

async function listInChild(bun: string, tree: string, sandbox: string): Promise<RegistryListing> {
  const home = path.join(sandbox, "home");
  const bin = path.join(sandbox, "bin");
  const tmp = path.join(sandbox, "tmp");
  for (const dir of [home, bin, tmp]) mkdirSync(dir, { recursive: true });
  const output = path.join(sandbox, "registry.json");
  // Built from nothing rather than filtered from process.env: a production
  // backend's variables on this host must not reach the release's modules.
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: tmp,
    PATH: bin,
    NODE_ENV: "production",
    LANG: "C.UTF-8",
  };
  const child = spawn(bun, ["--no-env-file", scriptPath, CHILD_FLAG, tree, output], {
    // Not the checkout: bun reads bunfig.toml and .env from its cwd.
    cwd: sandbox,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const collect = (chunk: Buffer) => {
    if (bytes >= MAX_CHILD_OUTPUT_BYTES) return;
    bytes += chunk.length;
    chunks.push(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The registry child did not finish within ${CHILD_TIMEOUT_MS}ms.`));
    }, CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (code !== 0 || !existsSync(output)) {
    throw new Error(text.length > 0 ? text : `The registry child exited with status ${code}.`);
  }
  return parseRegistryListing(readFileSync(output, "utf8"));
}

/** Validates what the child wrote. */
export function parseRegistryListing(text: string): RegistryListing {
  const parsed = JSON.parse(text) as { names?: unknown; read?: unknown };
  const isNames = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length <= MAX_COMMANDS &&
    value.every((name) => typeof name === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(name));
  if (!isNames(parsed.names) || parsed.names.length === 0) {
    throw new Error("The registry child listed no valid command names.");
  }
  if (parsed.read !== null && !isNames(parsed.read)) {
    throw new Error("The registry child listed invalid read commands.");
  }
  const names = [...new Set(parsed.names)].sort();
  const known = new Set(names);
  const read = parsed.read === null ? null : parsed.read.filter((name) => known.has(name)).sort();
  return { names, read };
}

/**
 * The child: imports a release's registry and classifier from `tree` and
 * writes their listing. Old releases return a `Map` from
 * `createCommandRegistry()`, newer ones a registry with `keys()`.
 */
export async function listReleaseRegistry(tree: string): Promise<RegistryListing> {
  const registryModule = (await import(
    path.join(tree, "apps/backend/src/core/commands-registry.ts")
  )) as { createCommandRegistry?: () => { keys(): Iterable<string> } };
  if (typeof registryModule.createCommandRegistry !== "function") {
    throw new Error(`${tree} has no createCommandRegistry in commands-registry.ts`);
  }
  const names = [...new Set(registryModule.createCommandRegistry().keys())].sort();
  const classifierPath = path.join(tree, "packages/protocol/src/command-nodes.ts");
  let read: string[] | null = null;
  if (existsSync(classifierPath)) {
    const classifier = (await import(classifierPath)) as {
      isNodeReadCommand?: (command: string) => boolean;
    };
    if (typeof classifier.isNodeReadCommand === "function") {
      read = names.filter((name) => classifier.isNodeReadCommand!(name));
    }
  }
  return { names, read };
}

function defaultRuntime(): BackfillRuntime {
  const contractsDirectory = path.join(repoRoot, CONTRACTS_DIRECTORY);
  return {
    contractsDirectory,
    listPublishedReleases() {
      const result = spawnSync(GH_RELEASE_LIST_COMMAND[0], GH_RELEASE_LIST_COMMAND.slice(1), {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status !== 0) {
        throw new Error(`gh release list failed: ${result.stderr.trim() || result.status}`);
      }
      return parseGitHubReleases(result.stdout);
    },
    resolveTag: (tag) => git(repoRoot, ["rev-parse", `${tag}^{commit}`]).trim(),
    manifestAt(commit) {
      const result = spawnSync("git", ["-C", repoRoot, "show", `${commit}:${MANIFEST_PATH}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return result.status === 0 ? result.stdout : null;
    },
    listRegistry: (release, commit) =>
      listRegistryInWorktree(release, commit, {
        repoRoot,
        workDirectory: path.join(repoRoot, BACKFILL_WORK_DIRECTORY),
        log: (line) => console.log(line),
      }),
    log: (line) => console.log(line),
  };
}

function cleanUpAndExit(signal: NodeJS.Signals): void {
  for (const { repoRoot: root, tree } of activeWorktrees) removeWorktree(root, tree);
  process.exit(signal === "SIGINT" ? 130 : 143);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === CHILD_FLAG && args.length === 3) {
    // No module of the release may reach the network while loading.
    globalThis.fetch = (async () => {
      throw new Error("network is disabled while listing a release's registry");
    }) as unknown as typeof fetch;
    try {
      await writeFile(args[2]!, JSON.stringify(await listReleaseRegistry(args[1]!)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    // Background work a registry module started must not keep the child alive.
    process.exit(0);
  }
  process.once("SIGINT", cleanUpAndExit);
  process.once("SIGTERM", cleanUpAndExit);
  try {
    process.exitCode = await backfillContractSnapshots(parseArguments(args), defaultRuntime());
  } catch (error) {
    console.error(`contract:backfill: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
