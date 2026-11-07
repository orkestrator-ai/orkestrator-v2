#!/usr/bin/env bun
/**
 * Mixed-version qualification (plan item 1012; docs/reports/unified-federation.md
 * §11.3 step 4; docs/architecture/version-compatibility.md, "Mixed-version
 * qualification"). Scheduled weekly by `.github/workflows/mixed-version-qualification.yml`,
 * not run per pull request.
 *
 *   mise run qualify:mixed-versions -- [options]
 *
 *   --old-version <spec>  `floor` (default): the support floor computed from
 *                         `packages/protocol/contracts/releases/index.json`
 *                         as `contract:ci` does; when npm lacks it (v2.21.0 and
 *                         v2.21.1 never reached npm), the oldest published
 *                         release above it that npm carries. `latest-stable`:
 *                         the newest published Stable release. `current`: this
 *                         checkout on both sides (a control run for a new
 *                         scenario module). Or an exact version.
 *   --topology <t>        `current-command`, `old-command` or `both` (default)
 *   --scenarios <list>    comma-separated domains (default: every module)
 *   --profiles <cmd>,<leaf>  run against two running `dev:test` profiles of this
 *                         checkout instead of starting backends (live checks)
 *   --now <ISO date>      compute the floor as on that day
 *   --report <file>       write the report as JSON
 *   --keep                keep the temporary root
 *   --list                list the scenario modules and exit
 *
 * Generalises `scripts/qualify-design-mixed-versions.ts` (which stays as the
 * design canvas's on-disk upgrade and downgrade run over one data directory):
 * the release is the real published `orkestrator` npm package, installed with
 * `--ignore-scripts` into the run's private directory, and every backend runs
 * on its own temporary data directory, HOME and loopback port with a
 * constructed environment (`mixed-version/harness.ts`). For each topology
 * (`mixed-version/scenario.ts`) the runner starts a command node and a leaf,
 * attaches the leaf, and runs each scenario module (`mixed-version/scenarios/`).
 *
 * Exits 0 when every scenario passed or could not apply to the pair, 1 when
 * one failed, 2 on a setup error.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { supportFloor, windowReleases } from "./contract-ci.ts";
import {
  compareVersions,
  CONTRACTS_DIRECTORY,
  readReleaseIndex,
  readReleaseSnapshot,
  type ReleaseIndex,
} from "./contract-snapshots.ts";
import { PairFixtures } from "./mixed-version/fixtures.ts";
import {
  attachedNode,
  installRelease,
  makeNode,
  ROOT,
  SetupError,
  tokenLeaks,
  type Build,
  type PeerNode,
} from "./mixed-version/harness.ts";
import {
  NotApplicable,
  requirementGaps,
  scenarioStatus,
  TOPOLOGIES,
  type ScenarioCheck,
  type ScenarioContext,
  type ScenarioModule,
  type ScenarioResult,
  type Topology,
} from "./mixed-version/scenario.ts";
import { SCENARIOS } from "./mixed-version/scenarios/index.ts";

export interface RunnerOptions {
  readonly oldVersion: string;
  readonly topologies: readonly Topology[];
  readonly scenarios?: readonly string[];
  readonly profiles?: readonly [string, string];
  readonly now?: Date;
  readonly report?: string;
  readonly keep: boolean;
  readonly list: boolean;
}

const USAGE =
  "usage: bun scripts/qualify-contract-mixed-versions.ts [--old-version floor|latest-stable|current|<version>] [--topology current-command|old-command|both] [--scenarios <domain,...>] [--profiles <command>,<leaf>] [--now <ISO date>] [--report <file>] [--keep] [--list]";

export function parseArguments(argv: readonly string[]): RunnerOptions {
  let oldVersion = "floor";
  let topologies: readonly Topology[] = TOPOLOGIES;
  let scenarios: string[] | undefined;
  let profiles: [string, string] | undefined;
  let now: Date | undefined;
  let report: string | undefined;
  let keep = false;
  let list = false;
  const value = (index: number) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(USAGE);
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--old-version") {
      oldVersion = value(index++);
      if (!/^(floor|latest-stable|current|\d+\.\d+\.\d+(-[a-z]+)?)$/u.test(oldVersion)) {
        throw new Error(`${USAGE}\nbad --old-version ${oldVersion}`);
      }
    } else if (arg === "--topology") {
      const topology = value(index++);
      if (topology === "both") topologies = TOPOLOGIES;
      else if ((TOPOLOGIES as readonly string[]).includes(topology)) {
        topologies = [topology as Topology];
      } else throw new Error(`${USAGE}\nbad --topology ${topology}`);
    } else if (arg === "--scenarios") {
      scenarios = value(index++)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (arg === "--profiles") {
      const names = value(index++).split(",");
      if (names.length !== 2 || names.some((name) => !/^[a-z0-9][a-z0-9-]*$/u.test(name))) {
        throw new Error(`${USAGE}\n--profiles takes two profile names`);
      }
      profiles = [names[0]!, names[1]!];
    } else if (arg === "--now") {
      now = new Date(value(index++));
      if (!Number.isFinite(now.getTime())) throw new Error(`${USAGE}\nbad --now`);
    } else if (arg === "--report") report = value(index++);
    else if (arg === "--keep") keep = true;
    else if (arg === "--list") list = true;
    else throw new Error(USAGE);
  }
  if (profiles && oldVersion !== "floor" && oldVersion !== "current") {
    throw new Error("--profiles runs this checkout on both sides; it takes no --old-version.");
  }
  return {
    oldVersion: profiles ? "current" : oldVersion,
    topologies: profiles ? ["current-command"] : topologies,
    ...(scenarios ? { scenarios } : {}),
    ...(profiles ? { profiles } : {}),
    ...(now ? { now } : {}),
    ...(report ? { report } : {}),
    keep,
    list,
  };
}

export interface ResolvedRelease {
  /** The release to run; `null` runs this checkout on both sides. */
  readonly version: string | null;
  readonly spec: string;
  /** The support floor on that day. */
  readonly floor: string;
  /** Why the version differs from what the spec names, when it does. */
  readonly note?: string;
}

/**
 * The release `spec` names. A floor npm lacks becomes the oldest published
 * in-window release npm carries; `latest-stable` is the newest published
 * Stable release npm carries. An exact version must be on npm.
 */
export function resolveOldVersion(
  spec: string,
  index: ReleaseIndex,
  now: Date,
  onNpm: ReadonlySet<string>,
): ResolvedRelease {
  const floor = supportFloor(index, now).version;
  if (spec === "current") return { version: null, spec, floor };
  if (spec === "floor") {
    if (onNpm.has(floor)) return { version: floor, spec, floor };
    const substitute = windowReleases(index, floor).find(
      (entry) => entry.publishedAt !== null && onNpm.has(entry.version),
    );
    if (!substitute) throw new SetupError(`No in-window release from ${floor} is on npm.`);
    return {
      version: substitute.version,
      spec,
      floor,
      note: `The floor ${floor} is not on npm; ran the oldest published in-window release npm carries.`,
    };
  }
  if (spec === "latest-stable") {
    const newest = [...index.releases]
      .filter(
        (entry) =>
          entry.channel === "stable" && entry.publishedAt !== null && onNpm.has(entry.version),
      )
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!newest) throw new SetupError("No published Stable release is on npm.");
    return { version: newest.version, spec, floor };
  }
  if (!onNpm.has(spec)) throw new SetupError(`orkestrator@${spec} is not on npm.`);
  return { version: spec, spec, floor };
}

/** The versions of `orkestrator` on the npm registry. */
export async function npmVersions(fetcher: typeof fetch = fetch): Promise<Set<string>> {
  const response = await fetcher("https://registry.npmjs.org/orkestrator", {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new SetupError(`npm registry answered ${response.status}.`);
  const body = (await response.json()) as { versions?: Record<string, unknown> };
  return new Set(Object.keys(body.versions ?? {}));
}

/** The commands this checkout registers (the committed manifest). */
export function currentCommands(contractsDirectory = CONTRACTS_DIRECTORY): Set<string> {
  const manifest = JSON.parse(
    readFileSync(path.join(contractsDirectory, "manifest.json"), "utf8"),
  ) as { commands: Record<string, unknown> };
  return new Set(Object.keys(manifest.commands));
}

/** The commands a published release registers (its snapshot). */
export function releaseCommands(
  version: string,
  contractsDirectory = CONTRACTS_DIRECTORY,
): Set<string> {
  return new Set(Object.keys(readReleaseSnapshot(contractsDirectory, version).commands));
}

/** `domain-adapter.backend.*` counts from `get_compatibility_path_usage`. */
export function adapterCounters(usage: unknown): Record<string, number> {
  const paths = (usage as { paths?: Record<string, { count?: unknown }> } | null)?.paths ?? {};
  const counters: Record<string, number> = {};
  for (const [id, entry] of Object.entries(paths)) {
    if (id.startsWith("domain-adapter.backend.") && typeof entry?.count === "number") {
      counters[id] = entry.count;
    }
  }
  return counters;
}

/** Counters that moved between two readings. */
export function counterDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [id, count] of Object.entries(after)) {
    const moved = count - (before[id] ?? 0);
    if (moved !== 0) delta[id] = moved;
  }
  return delta;
}

/**
 * The adapter a current command node picks for `domain` with this leaf: 1 when
 * the leaf's hello advertises a range containing 1, else 0.
 */
export function expectedAdapterFor(
  domain: string,
  leafDomains: Readonly<Record<string, { min: number; max: number }>> | undefined,
): 0 | 1 {
  const range = leafDomains?.[domain];
  return range && range.min <= 1 && range.max >= 1 ? 1 : 0;
}

/** Which side runs the release in a topology. */
export function topologyBuilds(
  topology: Topology,
  old: Build,
): { readonly command: Build; readonly leaf: Build } {
  const current: Build = { kind: "current" };
  return topology === "current-command"
    ? { command: current, leaf: old }
    : { command: old, leaf: current };
}

/** The modules `--scenarios` selects, in `SCENARIOS` order. */
export function selectScenarios(
  modules: readonly ScenarioModule[],
  domains: readonly string[] | undefined,
): ScenarioModule[] {
  if (!domains) return [...modules];
  const known = new Set(modules.map((module) => module.domain));
  const unknown = domains.filter((domain) => !known.has(domain));
  if (unknown.length > 0) throw new Error(`No scenario module for ${unknown.join(", ")}.`);
  return modules.filter((module) => domains.includes(module.domain));
}

export interface TopologyReport {
  readonly topology: Topology;
  readonly command: { readonly build: string; readonly version: string; readonly hello: unknown };
  readonly leaf: { readonly build: string; readonly version: string; readonly hello: unknown };
  readonly results: readonly ScenarioResult[];
  readonly tokenLeaks: readonly string[];
}

export interface QualificationReport {
  readonly release: ResolvedRelease;
  readonly topologies: readonly TopologyReport[];
  readonly setupError?: string;
  readonly exitCode: number;
}

export function exitCodeFor(report: Omit<QualificationReport, "exitCode">): number {
  if (report.setupError) return 2;
  const failed = report.topologies.some(
    (topology) =>
      topology.tokenLeaks.length > 0 ||
      topology.results.some((result) => result.status === "failed"),
  );
  return failed ? 1 : 0;
}

/** Runs `body` as one recorded scenario. */
async function recordScenario(
  base: { domain: string; title: string },
  body: (
    ctx: Pick<ScenarioContext, "check" | "note" | "notApplicable">,
  ) => Promise<Record<string, number> | void>,
): Promise<ScenarioResult> {
  const checks: ScenarioCheck[] = [];
  const evidence: Record<string, unknown>[] = [];
  const started = Date.now();
  let error: unknown;
  let adapterCalls: Record<string, number> | void = undefined;
  try {
    adapterCalls = await body({
      check(id, description, ok, detail) {
        checks.push({ id, description, ok, ...(detail && !ok ? { detail } : {}) });
        console.log(
          `  ${ok ? "PASS" : "FAIL"} ${id} ${description}${ok || !detail ? "" : ` (${detail})`}`,
        );
        return ok;
      },
      note(step, detail = {}) {
        evidence.push({ step, ...detail });
      },
      notApplicable(reason): never {
        throw new NotApplicable(reason);
      },
    });
  } catch (caught) {
    error = caught;
  }
  const status = scenarioStatus(checks, { error });
  const result: ScenarioResult = {
    ...base,
    status,
    ...(error instanceof NotApplicable ? { reason: error.message } : {}),
    ...(error !== undefined && !(error instanceof NotApplicable)
      ? { error: String(error).slice(0, 1_000) }
      : {}),
    checks,
    evidence,
    ...(adapterCalls && Object.keys(adapterCalls).length > 0 ? { adapterCalls } : {}),
    ms: Date.now() - started,
  };
  console.log(
    `  ${status.toUpperCase()} ${base.domain}${result.reason ? `: ${result.reason}` : ""}${
      result.error ? `: ${result.error}` : ""
    }`,
  );
  return result;
}

/**
 * Attach the leaf, or establish that this pair cannot attach and why. A
 * release without command nodes must be refused naming the update.
 */
async function attach(command: PeerNode, leaf: PeerNode): Promise<ScenarioResult> {
  return recordScenario({ domain: "nodes", title: "Attach the leaf" }, async (ctx) => {
    if (!command.has("add_node")) {
      ctx.check(
        "AT-03",
        "the release cannot command nodes: add_node is unknown to it",
        /unknown/iu.test(await command.refusal("add_node", {})),
      );
      ctx.notApplicable(`${command.label} has no command nodes (no add_node)`);
    }
    if (command.has("set_command_node_enabled")) {
      await command.invoke("set_command_node_enabled", { enabled: true });
    }
    const args = {
      routes: [{ id: "loopback", kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
      displayName: leaf.name,
    };
    if (!leaf.has("get_node_status")) {
      const refused = await command.refusal("add_node", args);
      ctx.note("attach refused", { refusal: refused.slice(0, 300) });
      ctx.check(
        "AT-02",
        "the command node refuses a release without command nodes, naming the update",
        /update/iu.test(refused),
        refused,
      );
      ctx.notApplicable(`${leaf.label} has no command nodes; the command node refuses it`);
    }
    const view = await command.invoke<{ nodeId: string; connection: { state: string } }>(
      "add_node",
      args,
    );
    const status = await leaf.invoke<{ mode: string }>("get_node_status");
    ctx.note("attached", { state: view.connection.state, leafMode: status.mode });
    ctx.check(
      "AT-01",
      "the command node attaches the leaf over its gateway, and the leaf is in leaf mode",
      view.connection.state === "connected" && view.nodeId === leaf.id && status.mode === "leaf",
      `${view.connection.state} ${status.mode}`,
    );
  });
}

async function runScenario(
  module: ScenarioModule,
  context: {
    topology: Topology;
    command: PeerNode;
    leaf: PeerNode;
    old: PeerNode | null;
    fixtures: PairFixtures;
    root: string;
  },
): Promise<ScenarioResult> {
  const { command, leaf } = context;
  const readCounters = async () =>
    command.build.kind === "current"
      ? adapterCounters(await command.invoke("get_compatibility_path_usage"))
      : null;
  return recordScenario(module, async (base) => {
    if (module.topologies && !module.topologies.includes(context.topology)) {
      base.notApplicable(`runs only in ${module.topologies.join(", ")}`);
    }
    const gaps = requirementGaps(module, command, leaf);
    if (gaps.current.length > 0) {
      throw new Error(`this checkout lacks ${gaps.current.join(", ")}; update the module`);
    }
    if (gaps.old.length > 0) base.notApplicable(`the release lacks ${gaps.old.join(", ")}`);
    const scratch = await mkdtemp(path.join(context.root, `${module.domain}-`));
    const start = await readCounters();
    const ctx: ScenarioContext = {
      ...base,
      topology: context.topology,
      command,
      leaf,
      old: context.old,
      fixtures: context.fixtures,
      scratch,
      expectedAdapter: (domain) =>
        command.build.kind === "current" ? expectedAdapterFor(domain, leaf.hello.domains) : null,
      async adapterCallsSince(domain, version) {
        if (!start) return null;
        const now = (await readCounters()) ?? {};
        const id = `domain-adapter.backend.${domain}.v${version}`;
        return (now[id] ?? 0) - (start[id] ?? 0);
      },
    };
    await module.run(ctx);
    const end = await readCounters();
    return start && end ? counterDelta(start, end) : undefined;
  });
}

async function runTopology(input: {
  topology: Topology;
  old: Build | null;
  oldCommands: ReadonlySet<string>;
  modules: readonly ScenarioModule[];
  root: string;
  profiles?: readonly [string, string];
}): Promise<TopologyReport> {
  const { topology } = input;
  const current = currentCommands();
  const builds = topologyBuilds(topology, input.old ?? { kind: "current" });
  const commandsOf = (build: Build) => (build.kind === "current" ? current : input.oldCommands);
  const directory = await mkdtemp(path.join(input.root, `${topology}-`));
  const nodes: PeerNode[] = [];
  try {
    const [command, leaf] = input.profiles
      ? await Promise.all(
          input.profiles.map((profile, index) =>
            profileNode(profile, index === 0 ? "command" : "leaf", directory, current),
          ),
        )
      : await Promise.all([
          makeNode({
            name: "Command",
            role: "command",
            build: builds.command,
            root: directory,
            commands: commandsOf(builds.command),
          }),
          makeNode({
            name: "Leaf",
            role: "leaf",
            build: builds.leaf,
            root: directory,
            commands: commandsOf(builds.leaf),
          }),
        ]);
    nodes.push(command!, leaf!);
    console.log(`[${topology}] ${command!.label} commands ${leaf!.label}`);
    await Promise.all(nodes.map((node) => node.start()));
    await Promise.all(nodes.map((node) => node.identify()));
    const old = input.old ? (nodes.find((node) => node.build.kind === "old") ?? null) : null;
    const results: ScenarioResult[] = [await attach(command!, leaf!)];
    const attached = results[0]!.status === "passed";
    const fixtures = new PairFixtures(path.join(directory, "fixtures"));
    for (const module of input.modules) {
      console.log(`[${topology}] ${module.domain}: ${module.title}`);
      if (!attached) {
        results.push({
          domain: module.domain,
          title: module.title,
          status: "not-applicable",
          reason:
            results[0]!.status === "not-applicable"
              ? `the pair cannot attach (${results[0]!.reason})`
              : "the leaf did not attach",
          checks: [],
          evidence: [],
          ms: 0,
        });
        continue;
      }
      results.push(
        await runScenario(module, {
          topology,
          command: command!,
          leaf: leaf!,
          old,
          fixtures,
          root: directory,
        }),
      );
    }
    const describe = (node: PeerNode) => ({
      build: node.build.kind === "current" ? "current" : `npm ${node.build.version}`,
      version: node.version,
      hello: {
        capabilities: node.hello.capabilities ?? null,
        domains: node.hello.domains ?? null,
        nodeMode: node.hello.nodeMode ?? null,
      },
    });
    return {
      topology,
      command: describe(command!),
      leaf: describe(leaf!),
      results,
      tokenLeaks: tokenLeaks(nodes),
    };
  } finally {
    await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  }
}

/** A running `dev:test` profile of this checkout, read from `dev:status --json`. */
async function profileNode(
  profile: string,
  role: "command" | "leaf",
  directory: string,
  commands: ReadonlySet<string>,
): Promise<PeerNode> {
  const status = Bun.spawnSync(
    ["bun", "apps/desktop/scripts/dev-status.ts", "--profile", profile, "--json"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (status.exitCode !== 0) throw new SetupError(`dev:status --profile ${profile} failed.`);
  const manifest = JSON.parse(status.stdout.toString()) as {
    status?: string;
    browserUrl?: string;
    authFile?: string;
  };
  if (manifest.status !== "ready" || !manifest.browserUrl || !manifest.authFile) {
    throw new SetupError(`Profile ${profile} is not ready.`);
  }
  // The token stays in memory; it is never printed or written.
  const token = (JSON.parse(readFileSync(manifest.authFile, "utf8")) as { token?: string }).token;
  if (!token) throw new SetupError(`Profile ${profile} has no gateway token.`);
  const dir = path.join(directory, role);
  await mkdir(dir, { recursive: true });
  return attachedNode({
    name: role === "command" ? "Command" : "Leaf",
    role,
    origin: new URL(manifest.browserUrl).origin,
    token,
    dir,
    commands,
  });
}

export async function runQualification(options: RunnerOptions): Promise<QualificationReport> {
  const modules = selectScenarios(SCENARIOS, options.scenarios);
  const index = readReleaseIndex(CONTRACTS_DIRECTORY);
  const now = options.now ?? new Date();
  let release: ResolvedRelease = {
    version: null,
    spec: options.oldVersion,
    floor: supportFloor(index, now).version,
  };
  const topologies: TopologyReport[] = [];
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-contract-mixed-"));
  let setupError: string | undefined;
  try {
    release = resolveOldVersion(
      options.oldVersion,
      index,
      now,
      options.oldVersion === "current" ? new Set() : await npmVersions(),
    );
    console.log(
      `Release: ${release.version ?? "this checkout"} (spec ${release.spec}, floor ${release.floor})${
        release.note ? `. ${release.note}` : ""
      }`,
    );
    const old: Build | null = release.version
      ? {
          kind: "old",
          version: release.version,
          packageRoot: await installRelease(release.version, path.join(root, "release")),
        }
      : null;
    const oldCommands = release.version ? releaseCommands(release.version) : currentCommands();
    // A control run has one pair; both topologies would be the same.
    const wanted = old ? options.topologies : options.topologies.slice(0, 1);
    for (const topology of wanted) {
      topologies.push(
        await runTopology({
          topology,
          old,
          oldCommands,
          modules,
          root,
          ...(options.profiles ? { profiles: options.profiles } : {}),
        }),
      );
    }
  } catch (error) {
    setupError = String(error).slice(0, 2_000);
    console.error(setupError);
  } finally {
    if (options.keep) console.log(`Kept ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
  const partial = { release, topologies, ...(setupError ? { setupError } : {}) };
  return { ...partial, exitCode: exitCodeFor(partial) };
}

function summary(report: QualificationReport): string {
  const lines: string[] = [];
  for (const topology of report.topologies) {
    lines.push(
      `${topology.topology}: command ${topology.command.build} ${topology.command.version}, leaf ${topology.leaf.build} ${topology.leaf.version}`,
    );
    for (const result of topology.results) {
      const passed = result.checks.filter((entry) => entry.ok).length;
      lines.push(
        `  ${result.status.padEnd(14)} ${result.domain.padEnd(12)} ${passed}/${result.checks.length} checks${
          result.reason ? `; ${result.reason}` : ""
        }${result.error ? `; ${result.error}` : ""}`,
      );
    }
    if (topology.tokenLeaks.length > 0) {
      lines.push(`  FAIL a gateway token appeared in ${topology.tokenLeaks.join(", ")}`);
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  let options: RunnerOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (options.list) {
    for (const module of SCENARIOS) console.log(`${module.domain.padEnd(14)} ${module.title}`);
    process.exit(0);
  }
  const report = await runQualification(options);
  console.log(summary(report));
  if (options.report) {
    const file = path.resolve(options.report);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report: ${path.relative(ROOT, file) || file}`);
  }
  process.exit(report.exitCode);
}
