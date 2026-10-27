import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  combineFootprints,
  parsePsRows,
  percentile,
  pickKindCounters,
  processTreeTotals,
  soakFootprint,
  soakLeaks,
  summarizeWindow,
  type LiveSample,
  type ProcessSample,
  type SoakLeak,
  type WindowSummary,
} from "./recurring-live-ab-summary";

/**
 * Live idle A/B for recurring work
 * (docs/todo/transcripts-and-observation/0048-recurring-work-qualification.md).
 *
 * For each arm and repeat it starts a disposable, credential-free isolated
 * profile (`mise run dev:test --fixture --fixture-environments …
 * --no-agent-credentials`), waits for `ready`, settles, then samples the
 * gateway's `recurringWork` block and the backend and Electron processes'
 * CPU time and RSS every `--sample-ms` for `--window-ms`. Afterwards it times
 * edit-to-detection freshness: it appends to a tracked file in each fixture
 * environment and waits for the `diff-scan` `changed` counter to move. Then
 * it stops and resets the profile.
 *
 * With `--soak-cycles N` it then soaks the same profile: N cycles that each
 * create, start (to `ready`), stop, restart and delete one environment of
 * every `--soak-environments` kind through the CLI. It compares the live
 * footprint (scheduler keys, admission leases, fetch and signal records,
 * running jobs, event-stream and terminal subscribers) before and after, and
 * the profile's guard lines are counted after the soak.
 *
 * Arms: `candidate` (defaults), `rollback`
 * (`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=all`,
 * `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0`) and `metrics-off`
 * (`ORKESTRATOR_RECURRING_METRICS=0`, CPU/RSS only).
 *
 * The gateway token is read from the profile's mode-0600 auth file and only
 * ever sent as a loopback request header; it is never printed or saved. The
 * artifact holds kinds, counts, durations and process totals only.
 *
 *   bun scripts/recurring-live-ab.ts --arms candidate,rollback --repeats 1 \
 *     --out output/benchmarks/recurring-live-ab.json
 */

type Arm = "candidate" | "rollback" | "metrics-off";
const ARMS: readonly Arm[] = ["candidate", "rollback", "metrics-off"];
const POLICY_SWITCHES = [
  "ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK",
  "ORKESTRATOR_NATIVE_OBSERVATION_SHARING",
  "ORKESTRATOR_RECURRING_METRICS",
] as const;
const ARM_ENV: Record<Arm, Record<string, string>> = {
  candidate: {},
  rollback: {
    ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK: "all",
    ORKESTRATOR_NATIVE_OBSERVATION_SHARING: "0",
  },
  "metrics-off": { ORKESTRATOR_RECURRING_METRICS: "0" },
};

export type Options = {
  arms: Arm[];
  repeats: number;
  settleMs: number;
  windowMs: number;
  sampleMs: number;
  fixtureEnvironments: string;
  profilePrefix: string;
  freshnessProbes: number;
  readyTimeoutMs: number;
  out: string;
  keepProfiles: boolean;
  soakCycles: number;
  soakEnvironments: Array<"local" | "container">;
};

export function parseOptions(argv: string[]): Options {
  const options: Options = {
    arms: ["candidate", "rollback"],
    repeats: 1,
    settleMs: 60_000,
    windowMs: 6 * 60_000,
    sampleMs: 30_000,
    fixtureEnvironments: "local,container",
    profilePrefix: "rw-ab",
    freshnessProbes: 5,
    readyTimeoutMs: 30 * 60_000,
    out: `output/benchmarks/recurring-live-ab-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    keepProfiles: false,
    soakCycles: 0,
    soakEnvironments: ["local"],
  };
  const value = (index: number, name: string) => {
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${name}`);
    return next;
  };
  const positive = (raw: string, name: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a number ≥ 0`);
    return parsed;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (name === "--arms") {
      const arms = value(index++, name).split(",").filter(Boolean);
      for (const arm of arms) if (!ARMS.includes(arm as Arm)) throw new Error(`Unknown arm ${arm}`);
      options.arms = arms as Arm[];
    } else if (name === "--repeats") options.repeats = positive(value(index++, name), name);
    else if (name === "--settle-ms") options.settleMs = positive(value(index++, name), name);
    else if (name === "--window-ms") options.windowMs = positive(value(index++, name), name);
    else if (name === "--sample-ms") options.sampleMs = positive(value(index++, name), name);
    else if (name === "--fixture-environments") options.fixtureEnvironments = value(index++, name);
    else if (name === "--profile-prefix") options.profilePrefix = value(index++, name);
    else if (name === "--freshness-probes")
      options.freshnessProbes = positive(value(index++, name), name);
    else if (name === "--ready-timeout-ms")
      options.readyTimeoutMs = positive(value(index++, name), name);
    else if (name === "--out") options.out = value(index++, name);
    else if (name === "--keep-profiles") options.keepProfiles = true;
    else if (name === "--soak-cycles") options.soakCycles = positive(value(index++, name), name);
    else if (name === "--soak-environments") {
      const kinds = value(index++, name).split(",").filter(Boolean);
      if (kinds.length === 0 || kinds.some((kind) => kind !== "local" && kind !== "container"))
        throw new Error("--soak-environments accepts local,container");
      options.soakEnvironments = [...new Set(kinds)] as Options["soakEnvironments"];
    } else throw new Error(`Unknown option ${name}`);
  }
  if (!Number.isInteger(options.soakCycles)) throw new Error("--soak-cycles must be an integer");
  if (!/^[a-z0-9-]+$/.test(options.profilePrefix)) {
    throw new Error("--profile-prefix accepts lowercase letters, digits and dashes");
  }
  return options;
}

const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await delay(ms, undefined, { signal });
};
const log = (message: string) => console.error(`[recurring-live-ab] ${message}`);

export type Status = {
  startedAt?: string;
  processStartTimes?: { launcher?: number };
  status?: string;
  browserUrl?: string;
  authFile?: string;
  logDir?: string;
  pids?: Partial<Record<"launcher" | "vite" | "electron" | "backend", number>>;
  live?: { launcher?: boolean };
};

function mise(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("mise", ["run", ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function readStatus(profile: string): Status | null {
  const result = mise(["dev:status", "--profile", profile, "--json"]);
  try {
    return JSON.parse(result.stdout) as Status;
  } catch {
    return null;
  }
}

/** Gateway access for one profile; the token stays inside this closure. */
function gatewayFor(status: Status, signal?: AbortSignal) {
  if (!status.browserUrl || !status.authFile) throw new Error("Profile has no browser gateway");
  const origin = new URL(status.browserUrl);
  if (origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") {
    throw new Error("Profile browser gateway is not loopback; refusing to send its token");
  }
  const token = (JSON.parse(readFileSync(status.authFile, "utf8")) as { token?: unknown }).token;
  if (typeof token !== "string" || !token) throw new Error("Gateway auth file has no token");
  return {
    async metrics(): Promise<Record<string, unknown> | null> {
      try {
        const response = await fetch(`${origin.origin}/__orkestrator/metrics`, {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        });
        if (!response.ok) return null;
        return (await response.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
  };
}

function recurringKinds(metrics: Record<string, unknown> | null) {
  const block = metrics?.recurringWork as { metrics?: { kinds?: unknown } } | undefined;
  return block?.metrics ? pickKindCounters(block.metrics.kinds) : null;
}

/** A malformed/missing counter is not a usable cumulative baseline. */
function diffChanged(metrics: Record<string, unknown> | null): number | null {
  const block = metrics?.recurringWork as
    { metrics?: { kinds?: Record<string, { changed?: unknown }> } } | undefined;
  const changed = block?.metrics?.kinds?.["diff-scan"]?.changed;
  return typeof changed === "number" && Number.isSafeInteger(changed) && changed >= 0
    ? changed
    : null;
}

/**
 * The backend alone (its bridges and spawned tools are separate processes),
 * and Electron as its whole process tree: the manifest's `electron` pid is
 * the launcher wrapper, whose children are the app's main, GPU and renderer
 * processes.
 */
function processSamples(
  pids: Status["pids"],
): Partial<Record<"backend" | "electron", ProcessSample>> {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss=,time="], { encoding: "utf8" });
  const rows = parsePsRows(result.stdout);
  const samples: Partial<Record<"backend" | "electron", ProcessSample>> = {};
  if (pids?.backend) {
    const backend = processTreeTotals(rows, pids.backend, false);
    if (backend) samples.backend = backend;
  }
  if (pids?.electron) {
    const electron = processTreeTotals(rows, pids.electron, true);
    if (electron) samples.electron = electron;
  }
  return samples;
}

type FixtureEnvironment = {
  id: string;
  kind: "local" | "container";
  worktreePath?: string;
};

/** `configDir` is the run's CLI config directory, which `runArm` owns and removes. */
function cliRunner(profile: string, configDir: string) {
  return (args: string[]) =>
    spawnSync("bun", ["packages/cli/bin/orkestrator.js", "--profile", profile, ...args], {
      encoding: "utf8",
      env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: configDir },
      maxBuffer: 16 * 1024 * 1024,
    });
}

type CliResult = { status: number | null; stdout: string };
type AsyncCli = (args: string[], signal?: AbortSignal) => Promise<CliResult>;

/** Wait for the CLI to exit before profile cleanup, escalating a stuck cancellation. */
function asyncCliRunner(profile: string, configDir: string): AsyncCli {
  return (args, signal) => {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(
        "bun",
        ["packages/cli/bin/orkestrator.js", "--profile", profile, ...args],
        {
          env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: configDir },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let stdout = "";
      let failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
      };
      const abort = () => stop(new Error("Soak CLI interrupted", { cause: signal?.reason }));
      const timeout = setTimeout(() => stop(new Error("Soak CLI timed out")), 10 * 60_000);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length + chunk.length > 16 * 1024 * 1024)
          stop(new Error("Soak CLI output exceeded limit"));
        else stdout += chunk;
      });
      child.once("error", (error) => {
        failure ??= error;
      });
      child.once("close", (status) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else resolve({ status, stdout });
      });
      if (signal?.aborted) abort();
    });
  };
}

function fixtureEnvironments(cli: ReturnType<typeof cliRunner>): FixtureEnvironment[] {
  const result = cli(["environment", "list", "--json"]);
  let envelope: { result?: unknown };
  try {
    envelope = JSON.parse(result.stdout) as { result?: unknown };
  } catch {
    return [];
  }
  const list = (envelope.result as { items?: unknown[] } | undefined)?.items ?? [];
  return list.flatMap((raw) => {
    const entry = raw as Record<string, unknown>;
    const type = entry.environmentType;
    if (typeof entry.id !== "string" || (type !== "local" && type !== "container")) return [];
    if (entry.ready !== true) return [];
    return [
      {
        id: entry.id,
        kind: type,
        ...(typeof entry.workspacePath === "string" ? { worktreePath: entry.workspacePath } : {}),
      },
    ];
  });
}

/**
 * Appends a line to a tracked file inside the environment and returns once
 * the write has happened. Local worktrees are written directly so the start
 * time is the write itself; containers go through `environment exec`, so
 * their start time includes the exec round trip (an upper bound).
 */
function trackedFileWriter(
  cli: ReturnType<typeof cliRunner>,
  environment: FixtureEnvironment,
): (() => void) | null {
  if (environment.kind === "local" && environment.worktreePath) {
    const listed = spawnSync("git", ["-C", environment.worktreePath, "ls-files"], {
      encoding: "utf8",
    });
    const file = listed.stdout
      .split("\n")
      .find((name) => name.endsWith(".md") || name.endsWith(".ts"));
    if (!file) return null;
    const target = path.join(environment.worktreePath, file);
    return () => appendFileSync(target, "\n<!-- recurring-live-ab probe -->\n");
  }
  const listed = cli(["environment", "exec", environment.id, "--wait", "--", "git", "ls-files"]);
  if (listed.status !== 0) return null;
  const file = listed.stdout.split("\n").find((name) => /^[\w./-]+\.(?:md|ts)$/.test(name)) ?? null;
  if (!file) return null;
  return () => {
    const written = cli([
      "environment",
      "exec",
      environment.id,
      "--wait",
      "--",
      "sh",
      "-c",
      `printf '\\n<!-- recurring-live-ab probe -->\\n' >> '${file}'`,
    ]);
    if (written.status !== 0) throw new Error("Freshness probe write failed");
  };
}

type Freshness = {
  environment: "local" | "container";
  latenciesMs: number[];
  timeouts: number;
  unusable: number;
};

const freshnessRuntime = {
  fixtureEnvironments,
  trackedFileWriter,
  now: () => performance.now(),
  sleep,
};

export async function measureFreshness(
  gateway: ReturnType<typeof gatewayFor>,
  cli: ReturnType<typeof cliRunner>,
  probes: number,
  signal?: AbortSignal,
  runtime = freshnessRuntime,
): Promise<Freshness[]> {
  const results: Freshness[] = [];
  for (const environment of runtime.fixtureEnvironments(cli)) {
    signal?.throwIfAborted();
    const write = runtime.trackedFileWriter(cli, environment);
    if (!write) {
      log(`no tracked file found in the ${environment.kind} environment; skipping freshness`);
      continue;
    }
    const timeoutMs = environment.kind === "local" ? 30_000 : 60_000;
    const entry: Freshness = {
      environment: environment.kind,
      latenciesMs: [],
      timeouts: 0,
      unusable: 0,
    };
    for (let probe = 0; probe < probes; probe += 1) {
      signal?.throwIfAborted();
      const before = diffChanged(await gateway.metrics());
      signal?.throwIfAborted();
      // A missing baseline cannot establish that a subsequent cumulative
      // count belongs to this edit. Leave the fixture alone and reject it.
      if (before === null) {
        entry.unusable += 1;
        continue;
      }
      const startedAt = runtime.now();
      write();
      let seen = false;
      let reset = false;
      while (runtime.now() - startedAt < timeoutMs) {
        signal?.throwIfAborted();
        const metrics = await gateway.metrics();
        signal?.throwIfAborted();
        const changed = diffChanged(metrics);
        if (metrics && (changed === null || changed < before)) {
          reset = true;
          break;
        }
        if (changed !== null && changed > before) {
          entry.latenciesMs.push(Math.round(runtime.now() - startedAt));
          seen = true;
          break;
        }
        await runtime.sleep(100, signal);
      }
      if (reset) entry.unusable += 1;
      else if (!seen) entry.timeouts += 1;
      // Randomize the next write within the container poll's cadence.
      await runtime.sleep(3_000 + Math.floor(Math.random() * 15_000), signal);
    }
    results.push(entry);
  }
  return results;
}

type SoakStep = "create" | "start" | "stop" | "restart" | "delete";

export type SoakResult = {
  cyclesRequested: number;
  cyclesCompleted: number;
  durationMs: number;
  /** Steps whose CLI command failed; a failed delete leaves an environment behind. */
  failures: Array<{ cycle: number; kind: "local" | "container"; step: SoakStep }>;
  /** Per gauge, the highest of the samples before the soak. */
  baseline: Record<string, number> | null;
  /** Per gauge, the lowest of the samples after the soak settled. */
  final: Record<string, number> | null;
  leaks: SoakLeak[];
  backendRssKiB: { baseline: number | null; final: number | null };
};

/** Samples per footprint, and the gap between them. */
const SOAK_SAMPLES = 3;
const SOAK_SAMPLE_GAP_MS = 5_000;
const SOAK_STEP_TIMEOUT = "10m";

function cliJson(result: CliResult): unknown {
  if (result.status !== 0) return null;
  try {
    return (JSON.parse(result.stdout) as { result?: unknown }).result ?? null;
  } catch {
    return null;
  }
}

/** The fixture project, read from the environments the profile seeded. */
async function fixtureProjectId(cli: AsyncCli, signal?: AbortSignal): Promise<string | null> {
  const listed = cliJson(await cli(["environment", "list", "--json"], signal)) as {
    items?: unknown[];
  } | null;
  for (const raw of listed?.items ?? []) {
    const projectId = (raw as Record<string, unknown>).projectId;
    if (typeof projectId === "string" && projectId) return projectId;
  }
  return null;
}

const soakRuntime = {
  fixtureProjectId,
  now: () => performance.now(),
  sleep,
};

export async function measureSoak(
  gateway: ReturnType<typeof gatewayFor>,
  cli: AsyncCli,
  options: Pick<Options, "soakCycles" | "soakEnvironments" | "settleMs">,
  backendRssKiB: () => number | null,
  signal?: AbortSignal,
  runtime = soakRuntime,
): Promise<SoakResult> {
  const startedAt = runtime.now();
  const footprints = async () => {
    const samples: Array<Record<string, number> | null> = [];
    for (let sample = 0; sample < SOAK_SAMPLES; sample += 1) {
      if (sample > 0) await runtime.sleep(SOAK_SAMPLE_GAP_MS, signal);
      signal?.throwIfAborted();
      samples.push(soakFootprint(await gateway.metrics()));
    }
    return samples;
  };
  const result: SoakResult = {
    cyclesRequested: options.soakCycles,
    cyclesCompleted: 0,
    durationMs: 0,
    failures: [],
    baseline: combineFootprints(await footprints(), "max"),
    final: null,
    leaks: [],
    backendRssKiB: { baseline: backendRssKiB(), final: null },
  };
  const projectId = await runtime.fixtureProjectId(cli, signal);
  if (!projectId) throw new Error("Soak found no fixture project");
  const step = async (args: string[]) => {
    signal?.throwIfAborted();
    const value = await cli([...args, "--timeout", SOAK_STEP_TIMEOUT, "--json"], signal);
    signal?.throwIfAborted();
    return value;
  };
  for (let cycle = 1; cycle <= options.soakCycles; cycle += 1) {
    for (const kind of options.soakEnvironments) {
      signal?.throwIfAborted();
      const created = cliJson(
        await cli(
          [
            "environment",
            "create",
            "--project",
            projectId,
            "--type",
            kind,
            "--name",
            `soak-${kind}-${cycle}`,
            "--json",
          ],
          signal,
        ),
      ) as { environment?: { id?: unknown } } | null;
      const id = created?.environment?.id;
      if (typeof id !== "string" || !id) {
        result.failures.push({ cycle, kind, step: "create" });
        continue;
      }
      const lifecycle: Array<[SoakStep, string[]]> = [
        ["start", ["environment", "start", id, "--wait", "ready"]],
        ["stop", ["environment", "stop", id, "--wait", "stopped"]],
        ["restart", ["environment", "start", id, "--wait", "running"]],
      ];
      for (const [name, args] of lifecycle) {
        signal?.throwIfAborted();
        if ((await step(args)).status !== 0) {
          result.failures.push({ cycle, kind, step: name });
          break;
        }
      }
      // Always delete, so one failed step does not leave the soak's
      // environment behind to read as a leak.
      if ((await step(["environment", "delete", id, "--wait", "deleted"])).status !== 0) {
        result.failures.push({ cycle, kind, step: "delete" });
      }
    }
    result.cyclesCompleted = cycle;
  }
  await runtime.sleep(options.settleMs, signal);
  result.final = combineFootprints(await footprints(), "min");
  result.backendRssKiB.final = backendRssKiB();
  result.leaks = result.baseline && result.final ? soakLeaks(result.baseline, result.final) : [];
  result.durationMs = Math.round(runtime.now() - startedAt);
  return result;
}

type RunResult = {
  arm: Arm;
  repeat: number;
  profile: string;
  readyAfterMs: number | null;
  summary: WindowSummary | null;
  freshness: Array<Freshness & { p50Ms: number | null; p95Ms: number | null }>;
  /** `Unhandled promise rejection (continuing)` guard lines in the profile logs. */
  guardLines: number | null;
  soak?: SoakResult;
  error?: string;
};

export function countGuardLines(logDir: string | undefined): number | null {
  if (!logDir) return null;
  const result = spawnSync(
    "grep",
    ["-r", "-c", "Unhandled promise rejection (continuing)", logDir],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0 && result.status !== 1) return null;
  return result.stdout
    .split("\n")
    .map((line) => Number(line.slice(line.lastIndexOf(":") + 1)))
    .filter(Number.isFinite)
    .reduce((total, count) => total + count, 0);
}

function startProfile(
  profile: string,
  options: Options,
  logDir: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const output = openSync(path.join(logDir, `${profile}.log`), "a", 0o600);
  try {
    // Spawn the launcher directly so its manifest PID is the child we own,
    // rather than a descendant of an opaque mise wrapper.
    return spawn(
      "bun",
      [
        "apps/desktop/scripts/dev-test.ts",
        "--profile",
        profile,
        "--fixture",
        "--fixture-environments",
        options.fixtureEnvironments,
        "--no-agent-credentials",
      ],
      { env, stdio: ["ignore", output, output] },
    );
  } finally {
    closeSync(output);
  }
}

const armRuntime = {
  readStatus,
  startProfile,
  mise,
  gatewayFor,
  processSamples,
  cliRunner,
  asyncCliRunner,
  measureFreshness,
  measureSoak,
  countGuardLines,
  now: () => performance.now(),
  sleep,
};

export async function runArm(
  options: Options,
  arm: Arm,
  repeat: number,
  logDir: string,
  signal?: AbortSignal,
  invocation: string = randomUUID(),
  runtime = armRuntime,
): Promise<RunResult> {
  // Runtime profile IDs are normalized and truncated to 48 characters.
  // Reserve the unique suffix and arm/repeat before trimming the prefix.
  const suffix = `-${invocation.replaceAll("-", "").slice(0, 20)}-${arm}-${repeat}`;
  const prefix = options.profilePrefix.slice(0, 48 - suffix.length).replace(/-+$/, "");
  const profile = `${prefix}${suffix}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of POLICY_SWITCHES) delete env[name];
  Object.assign(env, ARM_ENV[arm]);
  const result: RunResult = {
    arm,
    repeat,
    profile,
    readyAfterMs: null,
    summary: null,
    freshness: [],
    guardLines: null,
  };
  // Created on first use and removed once the profile is stopped, so the
  // CLI's config never outlives the run.
  let cliConfigDir: string | undefined;
  const cliConfig = () =>
    (cliConfigDir ??= mkdtempSync(path.join(os.tmpdir(), "recurring-live-ab-cli-")));
  let child: ChildProcess | undefined;
  let exited = false;
  let spawnError: Error | undefined;
  let owner: Status | null = null;
  const startedAt = runtime.now();
  const owned = (status: Status | null): status is Status => {
    if (
      !status ||
      !child?.pid ||
      status.pids?.launcher !== child.pid ||
      status.processStartTimes?.launcher === undefined ||
      !status.startedAt
    )
      return false;
    return (
      !owner ||
      (status.startedAt === owner.startedAt &&
        status.processStartTimes.launcher === owner.processStartTimes?.launcher)
    );
  };
  const checkedStatus = () => {
    const current = runtime.readStatus(profile);
    if (!owned(current))
      throw new Error("Profile launcher ownership changed or could not be verified");
    owner ??= current;
    return current;
  };
  const cleanup = async () => {
    if (child) {
      // Cleanup is deliberately not cancelled. Re-read identity before each
      // destructive command; a reused or replaced manifest is never ours.
      try {
        const current = runtime.readStatus(profile);
        if (owned(current)) {
          owner ??= current;
          log(`${profile}: stopping`);
          if (runtime.mise(["dev:stop", "--profile", profile]).status !== 0) {
            // Stop may report failure for an already stopped profile. Reset
            // still owns its resources, but only after verifying it is stopped.
            const stopped = checkedStatus();
            if (stopped.status !== "stopped" || stopped.live?.launcher !== false)
              throw new Error("Owned profile stop failed");
          }
        } else if (!exited) child.kill("SIGTERM");
        for (let waited = 0; !exited && waited < 60_000; waited += 1_000)
          await runtime.sleep(1_000);
        if (!exited) throw new Error("Owned launcher did not exit after stopping");
        if (owner && !options.keepProfiles) {
          checkedStatus();
          if (runtime.mise(["dev:reset", "--profile", profile]).status !== 0)
            throw new Error("Owned profile reset failed");
        }
      } catch (error) {
        result.error = [result.error, error instanceof Error ? error.message : String(error)]
          .filter(Boolean)
          .join("; ");
      }
    }
  };
  try {
    signal?.throwIfAborted();
    const existing = runtime.readStatus(profile);
    if (!existing || existing.status !== "missing")
      throw new Error("Refusing to reuse an existing or unreadable profile");
    log(`${profile}: starting`);
    child = runtime.startProfile(profile, options, logDir, env);
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", (error) => {
      spawnError = error;
      exited = true;
    });
    let status: Status | null = null;
    while (runtime.now() - startedAt < options.readyTimeoutMs) {
      signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      if (exited) throw new Error("dev:test exited before the profile was ready");
      const current = runtime.readStatus(profile);
      if (current && current.status !== "missing") {
        if (!owned(current)) throw new Error("Profile launcher ownership could not be verified");
        owner ??= current;
        if (current.status === "ready" && current.live?.launcher) {
          status = current;
          break;
        }
        if (current.status === "failed") throw new Error("Profile startup failed");
      }
      await runtime.sleep(5_000, signal);
    }
    if (!status) throw new Error("profile did not become ready in time");
    result.readyAfterMs = Math.round(runtime.now() - startedAt);
    log(`${profile}: ready after ${Math.round(result.readyAfterMs / 1000)} s; settling`);
    const gateway = runtime.gatewayFor(status, signal);
    await runtime.sleep(options.settleMs, signal);
    const samples: LiveSample[] = [];
    const windowStart = runtime.now();
    for (;;) {
      signal?.throwIfAborted();
      status = checkedStatus();
      if (exited || !status.live?.launcher || status.status !== "ready")
        throw new Error("Profile stopped during sampling");
      const atMs = Math.round(runtime.now() - windowStart);
      samples.push({
        atMs,
        kinds: recurringKinds(await gateway.metrics()),
        processes: runtime.processSamples(status.pids),
      });
      if (atMs >= options.windowMs) break;
      await runtime.sleep(Math.min(options.sampleMs, Math.max(0, options.windowMs - atMs)), signal);
    }
    result.summary = summarizeWindow(samples);
    if (arm !== "metrics-off" && options.freshnessProbes > 0) {
      checkedStatus();
      log(`${profile}: freshness probes`);
      const freshness = await runtime.measureFreshness(
        gateway,
        runtime.cliRunner(profile, cliConfig()),
        options.freshnessProbes,
        signal,
      );
      result.freshness = freshness.map((entry) => ({
        ...entry,
        p50Ms: percentile(entry.latenciesMs, 50),
        p95Ms: percentile(entry.latenciesMs, 95),
      }));
    }
    if (options.soakCycles > 0) {
      checkedStatus();
      log(`${profile}: soak, ${options.soakCycles} cycles`);
      result.soak = await runtime.measureSoak(
        gateway,
        runtime.asyncCliRunner(profile, cliConfig()),
        options,
        () => runtime.processSamples(checkedStatus().pids).backend?.rssKiB ?? null,
        signal,
      );
    }
    signal?.throwIfAborted();
    checkedStatus();
    result.guardLines = runtime.countGuardLines(status.logDir);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`${profile}: ${result.error}`);
  } finally {
    await cleanup();
    if (cliConfigDir) rmSync(cliConfigDir, { recursive: true, force: true });
  }
  return result;
}

/** Signal handlers stay installed until the run's asynchronous cleanup settles. */
export async function withTerminationSignals(
  run: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  let exitCode: number | undefined;
  const interrupt = () => {
    exitCode ??= 130;
    controller.abort(new Error("Benchmark interrupted"));
  };
  const terminate = () => {
    exitCode ??= 143;
    controller.abort(new Error("Benchmark terminated"));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const result = await run(controller.signal);
    return exitCode ?? result;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

function printSummary(results: RunResult[]): void {
  const lines = [
    "| Arm | Repeat | Kind | Observed ms | Partial | Starts/min | Work units/min |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const run of results) {
    for (const [kind, rates] of Object.entries(run.summary?.kinds ?? {}).sort()) {
      const units = Object.entries(rates.workUnitsPerMinute)
        .map(([unit, count]) => `${unit} ${count}`)
        .join(", ");
      lines.push(
        `| ${run.arm} | ${run.repeat} | ${kind} | ${rates.observedMs} | ${rates.partial} | ${rates.startedPerMinute} | ${units} |`,
      );
    }
  }
  lines.push(
    "",
    "| Arm | Repeat | Backend CPU ms/min | Backend RSS MiB (median/max) | Electron CPU ms/min | Guard lines |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const run of results) {
    const backend = run.summary?.processes.backend;
    const electron = run.summary?.processes.electron;
    lines.push(
      `| ${run.arm} | ${run.repeat} | ${backend?.cpuMsPerMinute ?? "—"} | ${
        backend
          ? `${Math.round(backend.rssKiBMedian / 1024)}/${Math.round(backend.rssKiBMax / 1024)}`
          : "—"
      } | ${electron?.cpuMsPerMinute ?? "—"} | ${run.guardLines ?? "—"} |`,
    );
  }
  lines.push(
    "",
    "| Arm | Repeat | Environment | p50 ms | p95 ms | Probes | Timeouts | Unusable |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const run of results) {
    for (const entry of run.freshness) {
      lines.push(
        `| ${run.arm} | ${run.repeat} | ${entry.environment} | ${entry.p50Ms ?? "—"} | ${entry.p95Ms ?? "—"} | ${
          entry.latenciesMs.length + entry.timeouts + entry.unusable
        } | ${entry.timeouts} | ${entry.unusable} |`,
      );
    }
  }
  const soaks = results.filter((run) => run.soak);
  if (soaks.length > 0) {
    lines.push(
      "",
      "| Arm | Repeat | Soak cycles | Failed steps | Footprint measurement | Leaked gauges | Backend RSS MiB (before/after) |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const run of soaks) {
      const soak = run.soak!;
      const mib = (kib: number | null) => (kib === null ? "—" : Math.round(kib / 1024));
      lines.push(
        `| ${run.arm} | ${run.repeat} | ${soak.cyclesCompleted}/${soak.cyclesRequested} | ${
          soak.failures.map((entry) => `${entry.kind} ${entry.step} #${entry.cycle}`).join(", ") ||
          "none"
        } | ${missingFootprints(soak).join(", ") || "measured"} | ${
          soak.leaks.map((leak) => `${leak.gauge} ${leak.baseline}→${leak.final}`).join(", ") ||
          (missingFootprints(soak).length > 0 ? "unmeasured" : "none")
        } | ${mib(soak.backendRssKiB.baseline)}/${mib(soak.backendRssKiB.final)} |`,
      );
    }
  }
  console.log(lines.join("\n"));
}

async function main(signal: AbortSignal): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const out = path.resolve(options.out);
  const logDir = path.join(path.dirname(out), "recurring-live-ab-logs");
  mkdirSync(logDir, { recursive: true });
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const results: RunResult[] = [];
  const invocation = randomUUID();
  for (let repeat = 1; repeat <= options.repeats && !signal.aborted; repeat += 1) {
    for (const arm of options.arms) {
      if (signal.aborted) break;
      results.push(await runArm(options, arm, repeat, logDir, signal, invocation));
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            commit,
            platform: process.platform,
            arch: process.arch,
            options: { ...options, out: undefined },
            results,
          },
          null,
          2,
        )}\n`,
      );
    }
  }
  log(`wrote ${out}`);
  printSummary(results);
  // A soak passes only with every step done, every gauge back at its
  // baseline and no guard lines in the profile's logs.
  return resultExitCode(results);
}

function missingFootprints(soak: SoakResult): string[] {
  return [
    soak.baseline === null ? "baseline unavailable" : "",
    soak.final === null ? "final unavailable" : "",
  ].filter(Boolean);
}

function resultExitCode(results: Array<Pick<RunResult, "error" | "soak" | "guardLines">>): number {
  return results.some(
    (run) =>
      run.error ||
      (run.soak &&
        (missingFootprints(run.soak).length > 0 ||
          run.soak.failures.length > 0 ||
          run.soak.leaks.length > 0 ||
          run.guardLines !== 0)),
  )
    ? 1
    : 0;
}

export const __testing = {
  armRuntime,
  freshnessRuntime,
  soakRuntime,
  printSummary,
  resultExitCode,
};

if (import.meta.main) {
  process.exitCode = await withTerminationSignals(main);
}
