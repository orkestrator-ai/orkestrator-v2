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
  gaugeTrends,
  soakCacheGauges,
  soakFootprint,
  soakLeaks,
  summarizeWindow,
  type GaugeTrend,
  type LiveSample,
  type ProcessSample,
  type SoakLeak,
  type SoakTrendSample,
  type WindowSummary,
} from "./recurring-live-ab-summary";
import {
  BUSY_DEFAULTS,
  busyFailed,
  busyRuntime,
  busySummaryLines,
  measureBusy,
  parseBusyClients,
  type BusyOptions,
  type BusyResult,
} from "./recurring-live-ab-busy";
import {
  playwrightBusyClients,
  playwrightSoakReader,
  type SoakReader,
} from "./recurring-live-ab-busy-clients";
import {
  FAKE_PI_MODEL_REF,
  startFakeModelServer,
  writeFakePiModels,
  type FakeModelServer,
} from "./recurring-live-ab-fake-model";

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
 * the profile's guard lines are counted after the soak. After every cycle it
 * also reads one trend sample (footprint, cache gauges and backend RSS), and
 * reports which gauges kept rising over the soak (`gaugeTrends`).
 * `--soak-cycle-gap-ms` idles between cycles, so a soak can span an hour.
 *
 * With `--soak-sessions N` the soak keeps real Pi agent sessions open on a
 * fake model (`recurring-live-ab-fake-model.ts`): a loopback OpenAI-compatible
 * endpoint this process serves, named in the new profile's own Pi
 * `models.json`. N sessions on the fixture's local environment stay open for
 * the whole soak and get one prompt per cycle, and every cycle's local
 * environment gets a session of its own before it is deleted. No credential
 * or provider is involved.
 *
 * With `--soak-readers 1` (which needs `--soak-sessions`) one headless
 * Playwright reader opens each cycle's session tab, and then every long-lived
 * session's tab, and waits for the fake reply to render before moving on, so
 * the projection's progressive-read caches fill as a browser fills them and
 * their gauges show in the trend (todo 7100 task 4).
 *
 * With `--busy-rounds N` it runs the busy phase (`recurring-live-ab-busy.ts`)
 * before any soak: `--busy-environments` local environments, real Pi
 * sessions on the fake model, and for each `--busy-clients` count (0 to 2
 * headless Playwright clients) N rounds of a file burst in every environment,
 * a held turn with a queued prompt, a parked approval, agent mail, an outage
 * or hidden client, a Multi Review to completion and a client resume, timed
 * as each client saw it and checked for duplicate or lost dispatches.
 *
 * Arms: `candidate` (defaults), `rollback`
 * (`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=all`; native queues, backend
 * activity and Multi Review stay keyed and native observation stays shared in
 * both arms, their rollback drivers and the observation-sharing switch having
 * been removed by todo 0048 task 13) and `metrics-off`
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
  "ORKESTRATOR_RECURRING_METRICS",
] as const;
const ARM_ENV: Record<Arm, Record<string, string>> = {
  candidate: {},
  rollback: {
    ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK: "all",
  },
  "metrics-off": { ORKESTRATOR_RECURRING_METRICS: "0" },
};

export type Options = BusyOptions & {
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
  /** Idle time after each soak cycle. */
  soakCycleGapMs: number;
  /** Fake-model Pi sessions kept open on the fixture's local environment. */
  soakSessions: number;
  /** Headless browser readers that open each soak session's tab (0 or 1). */
  soakReaders: number;
  /**
   * `dev:test --agent-platforms`: the managed toolchains a profile prepares.
   * Unset keeps the profile default (every platform, some downloaded at start).
   */
  agentPlatforms?: string;
  /**
   * Another checkout (absolute path) whose launcher, lifecycle scripts and CLI
   * run the profile: a worktree at an older commit gives the "before" side of
   * a before-and-after pair. Unset runs this checkout.
   */
  checkout?: string;
  /** A name for the checkout, recorded in the artifact (`base`, `after`). */
  label?: string;
  /**
   * The Electron window: `hidden` passes `--headless`, `visible` passes
   * `--no-headless`, `launcher-default` passes neither, for a checkout whose
   * launcher predates both flags (it shows the window).
   */
  window: "hidden" | "visible" | "launcher-default";
  /**
   * `--host-seed`: let `dev:test` seed toolchains and model caches from the
   * host's installation. Off by default, so the profile passes
   * `--no-host-seed` and reads nothing from the production data directory;
   * a launcher older than that flag needs `--host-seed` (it then passes
   * neither).
   */
  hostSeed: boolean;
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
    soakCycleGapMs: 0,
    soakSessions: 0,
    soakReaders: 0,
    window: "hidden",
    hostSeed: false,
    ...BUSY_DEFAULTS,
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
    else if (name === "--host-seed") options.hostSeed = true;
    else if (name === "--soak-cycles") options.soakCycles = positive(value(index++, name), name);
    else if (name === "--soak-cycle-gap-ms")
      options.soakCycleGapMs = positive(value(index++, name), name);
    else if (name === "--soak-sessions")
      options.soakSessions = positive(value(index++, name), name);
    else if (name === "--soak-readers") options.soakReaders = positive(value(index++, name), name);
    else if (name === "--busy-rounds") options.busyRounds = positive(value(index++, name), name);
    else if (name === "--busy-environments")
      options.busyEnvironments = positive(value(index++, name), name);
    else if (name === "--busy-clients")
      options.busyClients = parseBusyClients(value(index++, name));
    else if (name === "--busy-burst-files")
      options.busyBurstFiles = positive(value(index++, name), name);
    else if (name === "--busy-turn-files")
      options.busyTurnFiles = positive(value(index++, name), name);
    else if (name === "--agent-platforms") {
      const platforms = value(index++, name);
      if (!/^[a-z]+(,[a-z]+)*$/.test(platforms))
        throw new Error("--agent-platforms takes a comma list of platform names");
      options.agentPlatforms = platforms;
    } else if (name === "--checkout") {
      const checkout = value(index++, name);
      if (!path.isAbsolute(checkout)) throw new Error("--checkout takes an absolute path");
      options.checkout = checkout;
    } else if (name === "--label") {
      const label = value(index++, name);
      if (!/^[a-z0-9-]{1,24}$/.test(label))
        throw new Error("--label accepts up to 24 lowercase letters, digits and dashes");
      options.label = label;
    } else if (name === "--window") {
      const window = value(index++, name);
      if (window !== "hidden" && window !== "visible" && window !== "launcher-default")
        throw new Error("--window accepts hidden, visible or launcher-default");
      options.window = window;
    } else if (name === "--soak-environments") {
      const kinds = value(index++, name).split(",").filter(Boolean);
      if (kinds.length === 0 || kinds.some((kind) => kind !== "local" && kind !== "container"))
        throw new Error("--soak-environments accepts local,container");
      options.soakEnvironments = [...new Set(kinds)] as Options["soakEnvironments"];
    } else throw new Error(`Unknown option ${name}`);
  }
  if (!Number.isInteger(options.soakCycles)) throw new Error("--soak-cycles must be an integer");
  if (!Number.isInteger(options.soakSessions) || options.soakSessions > 8)
    throw new Error("--soak-sessions must be an integer from 0 to 8");
  if (options.soakReaders !== 0 && options.soakReaders !== 1)
    throw new Error("--soak-readers must be 0 or 1");
  if (options.soakReaders > 0 && options.soakSessions === 0)
    throw new Error("--soak-readers needs --soak-sessions: a reader opens session tabs");
  if (!Number.isInteger(options.busyRounds)) throw new Error("--busy-rounds must be an integer");
  if (
    !Number.isInteger(options.busyEnvironments) ||
    options.busyEnvironments < 3 ||
    options.busyEnvironments > 20
  )
    throw new Error("--busy-environments must be an integer from 3 to 20");
  if (!Number.isInteger(options.busyBurstFiles) || options.busyBurstFiles < 1)
    throw new Error("--busy-burst-files must be a positive integer");
  if (!Number.isInteger(options.busyTurnFiles))
    throw new Error("--busy-turn-files must be an integer");
  if (options.busyRounds > 0 && !options.fixtureEnvironments.split(",").includes("local"))
    throw new Error(
      "--busy-rounds needs a local fixture environment (--fixture-environments local)",
    );
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
  dataDir?: string;
  processStartTimes?: { launcher?: number };
  status?: string;
  browserUrl?: string;
  rendererUrl?: string;
  authFile?: string;
  logDir?: string;
  pids?: Partial<Record<"launcher" | "vite" | "electron" | "backend", number>>;
  live?: { launcher?: boolean };
};

/**
 * The environment for a process run in `checkout`. mise reads a checkout's
 * `mise.toml` only once trusted; trusting it for this process alone leaves
 * mise's own trust list untouched.
 */
export function checkoutEnv(
  checkout: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return checkout ? { ...env, MISE_TRUSTED_CONFIG_PATHS: checkout } : env;
}

const commandProcesses = { spawn, spawnSync };

function mise(args: string[], checkout?: string) {
  return commandProcesses.spawnSync("mise", ["run", ...args], {
    encoding: "utf8",
    env: checkoutEnv(checkout),
    ...(checkout ? { cwd: checkout } : {}),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function readStatus(profile: string, checkout?: string): Status | null {
  const result = mise(["dev:status", "--profile", profile, "--json"], checkout);
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
    /** One registry command; throws on a transport or command error. */
    async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
      const response = await fetch(`${origin.origin}/__orkestrator/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ command, args }),
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`${command} failed with HTTP ${response.status}`);
      return ((await response.json()) as { result?: unknown }).result;
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
function cliRunner(profile: string, configDir: string, checkout?: string) {
  return (args: string[]) =>
    commandProcesses.spawnSync(
      "bun",
      ["packages/cli/bin/orkestrator.js", "--profile", profile, ...args],
      {
        encoding: "utf8",
        env: { ...checkoutEnv(checkout), ORKESTRATOR_CLI_CONFIG_DIR: configDir },
        ...(checkout ? { cwd: checkout } : {}),
        maxBuffer: 16 * 1024 * 1024,
      },
    );
}

type CliResult = { status: number | null; stdout: string };
type AsyncCli = (args: string[], signal?: AbortSignal) => Promise<CliResult>;

/**
 * Wait for the CLI to exit before profile cleanup, escalating a stuck
 * cancellation to SIGKILL after `killGraceMs` (shortened only by tests).
 */
function asyncCliRunner(
  profile: string,
  configDir: string,
  checkout?: string,
  killGraceMs = 1_000,
): AsyncCli {
  return (args, signal) => {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = commandProcesses.spawn(
        "bun",
        ["packages/cli/bin/orkestrator.js", "--profile", profile, ...args],
        {
          env: { ...checkoutEnv(checkout), ORKESTRATOR_CLI_CONFIG_DIR: configDir },
          ...(checkout ? { cwd: checkout } : {}),
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let stdout = "";
      let failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), killGraceMs);
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
  gateway: Pick<ReturnType<typeof gatewayFor>, "metrics">,
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

type SoakStep = "create" | "start" | "stop" | "restart" | "delete" | "session" | "prompt" | "read";

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
  /** One sample after every cycle: footprint, cache gauges and backend RSS. */
  trend: SoakTrendSample[];
  /** Footprint and cache gauges still rising over the cycles (`gaugeTrends`). */
  growing: GaugeTrend[];
  /** Every cache gauge's trend, for the record. */
  cacheTrends: GaugeTrend[];
  /** Backend RSS over the trend samples, as a gauge. */
  rssTrend: GaugeTrend | null;
  /** Fake-model agent sessions, when `--soak-sessions` asked for them. */
  sessions: {
    requested: number;
    /** Long-lived sessions opened on the fixture's local environment. */
    opened: number;
    /** Sessions opened in a cycle's own local environment. */
    cycleSessions: number;
    /** Follow-up prompts the long-lived sessions answered. */
    prompts: number;
    /** Chat completions the fake model answered. */
    modelRequests: number;
  };
  /** The browser reader, when `--soak-readers` asked for one. */
  reader?: {
    /** Environments whose Pi tabs the reader opened and saw the reply in. */
    reads: number;
    /** Tabs it opened in all. */
    tabs: number;
  };
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

/** An environment's display name, which the sidebar shows (a reader selects by it). */
async function environmentName(
  cli: AsyncCli,
  environmentId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const listed = cliJson(await cli(["environment", "list", "--json"], signal)) as {
    items?: unknown[];
  } | null;
  for (const raw of listed?.items ?? []) {
    const entry = raw as Record<string, unknown>;
    if (entry.id === environmentId && typeof entry.name === "string") return entry.name;
  }
  return null;
}

/** A ready local environment of the fixture, for long-lived soak sessions. */
async function fixtureLocalEnvironmentId(
  cli: AsyncCli,
  signal?: AbortSignal,
): Promise<string | null> {
  const listed = cliJson(await cli(["environment", "list", "--json"], signal)) as {
    items?: unknown[];
  } | null;
  for (const raw of listed?.items ?? []) {
    const entry = raw as Record<string, unknown>;
    if (entry.environmentType === "local" && entry.ready === true && typeof entry.id === "string")
      return entry.id;
  }
  return null;
}

const soakRuntime = {
  fixtureProjectId,
  fixtureLocalEnvironmentId,
  environmentName,
  startFakeModel: (): FakeModelServer => startFakeModelServer(),
  writeFakePiModels,
  now: () => performance.now(),
  sleep,
};

/** Exit 7 is `run-unknown`: Pi runs cannot report completion, so it is the normal end. */
const PI_RUN_ENDED = new Set([0, 7]);

/** The session a `session start` named, from its result or (Pi) its receipt. */
function startedSessionId(result: CliResult): string | null {
  try {
    const envelope = JSON.parse(result.stdout) as {
      result?: { sessionId?: unknown };
      receipt?: { resources?: { sessionId?: unknown } };
    };
    const id = envelope.result?.sessionId ?? envelope.receipt?.resources?.sessionId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export async function measureSoak(
  gateway: Pick<ReturnType<typeof gatewayFor>, "metrics">,
  cli: AsyncCli,
  options: Pick<Options, "soakCycles" | "soakEnvironments" | "settleMs"> &
    Partial<Pick<Options, "soakCycleGapMs" | "soakSessions">> & {
      /** The profile's data directory; needed only for `soakSessions`. */
      dataDir?: string;
      /** A browser reader for the sessions' tabs (`--soak-readers`). */
      reader?: SoakReader;
    },
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
  const sessionCount = options.soakSessions ?? 0;
  const result: SoakResult = {
    cyclesRequested: options.soakCycles,
    cyclesCompleted: 0,
    durationMs: 0,
    failures: [],
    baseline: null,
    final: null,
    leaks: [],
    backendRssKiB: { baseline: null, final: null },
    trend: [],
    growing: [],
    cacheTrends: [],
    rssTrend: null,
    sessions: {
      requested: sessionCount,
      opened: 0,
      cycleSessions: 0,
      prompts: 0,
      modelRequests: 0,
    },
    ...(options.reader ? { reader: { reads: 0, tabs: 0 } } : {}),
  };
  const reader = options.reader;
  if (reader && sessionCount === 0) throw new Error("A soak reader needs soak sessions to read");
  /** One reader pass over an environment's Pi tabs; a failure is the cycle's `read` step. */
  const readTabs = async (cycle: number, kind: "local" | "container", name: string | null) => {
    if (!reader || !result.reader) return;
    signal?.throwIfAborted();
    try {
      if (!name) throw new Error("no environment name");
      result.reader.tabs += await reader.read(name);
      result.reader.reads += 1;
    } catch {
      result.failures.push({ cycle, kind, step: "read" });
    }
  };
  const projectId = await runtime.fixtureProjectId(cli, signal);
  if (!projectId) throw new Error("Soak found no fixture project");
  const step = async (args: string[]) => {
    signal?.throwIfAborted();
    const value = await cli([...args, "--timeout", SOAK_STEP_TIMEOUT, "--json"], signal);
    signal?.throwIfAborted();
    return value;
  };
  let fakeModel: FakeModelServer | null = null;
  /** A turn counts only when it ended and the fake model answered a request for it. */
  const turn = async (args: string[]): Promise<CliResult | null> => {
    const before = fakeModel?.counts().completions ?? 0;
    const value = await step([...args, "--wait"]);
    const answered = (fakeModel?.counts().completions ?? 0) > before;
    return value.status !== null && PI_RUN_ENDED.has(value.status) && answered ? value : null;
  };
  const openSession = async (environmentId: string, prompt: string) => {
    const started = await turn([
      "session",
      "start",
      "--environment",
      environmentId,
      "--agent",
      "pi",
      "--model",
      FAKE_PI_MODEL_REF,
      "--prompt",
      prompt,
    ]);
    return started ? startedSessionId(started) : null;
  };
  const longLived: string[] = [];
  let fixtureEnvironmentName: string | null = null;
  try {
    if (sessionCount > 0) {
      if (!options.dataDir) throw new Error("Soak sessions need the profile's data directory");
      fakeModel = runtime.startFakeModel();
      runtime.writeFakePiModels(options.dataDir, fakeModel.baseUrl);
      const fixtureEnvironment = await runtime.fixtureLocalEnvironmentId(cli, signal);
      if (!fixtureEnvironment) throw new Error("Soak sessions need a ready local environment");
      if (reader)
        fixtureEnvironmentName = await runtime.environmentName(cli, fixtureEnvironment, signal);
      // The catalogue was read before the fake provider existed. `agent
      // options` takes no `--timeout`, so it is not a `step`.
      const refreshed = await cli(
        ["agent", "options", "--environment", fixtureEnvironment, "--refresh", "--json"],
        signal,
      );
      if (refreshed.status !== 0 || !refreshed.stdout.includes(FAKE_PI_MODEL_REF))
        throw new Error("The Pi catalogue did not list the fake model after a refresh");
      for (let index = 1; index <= sessionCount; index += 1) {
        const id = await openSession(fixtureEnvironment, `Soak session ${index}: reply briefly.`);
        if (!id) throw new Error("A soak session did not answer on the fake model");
        longLived.push(id);
      }
      result.sessions.opened = longLived.length;
    }
    // The baseline includes the long-lived sessions: they stay open throughout.
    result.baseline = combineFootprints(await footprints(), "max");
    result.backendRssKiB.baseline = backendRssKiB();
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
          // The cycle's own session opens on the ready environment and is
          // still open when the environment is stopped and deleted.
          if (name === "start" && kind === "local" && sessionCount > 0) {
            if (await openSession(id, `Soak cycle ${cycle}: reply briefly.`)) {
              result.sessions.cycleSessions += 1;
              // Read it once, then leave it: it is deleted with the cycle.
              await readTabs(cycle, kind, `soak-${kind}-${cycle}`);
            } else result.failures.push({ cycle, kind, step: "session" });
          }
        }
        // Always delete, so one failed step does not leave the soak's
        // environment behind to read as a leak.
        if ((await step(["environment", "delete", id, "--wait", "deleted"])).status !== 0) {
          result.failures.push({ cycle, kind, step: "delete" });
        }
      }
      for (const session of longLived) {
        if (await turn(["session", "prompt", session, "--prompt", `Cycle ${cycle}.`]))
          result.sessions.prompts += 1;
        else result.failures.push({ cycle, kind: "local", step: "prompt" });
      }
      // The long-lived sessions are read every cycle and never invalidated by
      // a deletion: the maps 7100 task 3 bounded are the ones they would fill.
      if (longLived.length > 0) await readTabs(cycle, "local", fixtureEnvironmentName);
      result.cyclesCompleted = cycle;
      signal?.throwIfAborted();
      const metrics = await gateway.metrics();
      result.trend.push({
        cycle,
        atMs: Math.round(runtime.now() - startedAt),
        backendRssKiB: backendRssKiB(),
        footprint: soakFootprint(metrics),
        caches: soakCacheGauges(metrics),
      });
      const gap = options.soakCycleGapMs ?? 0;
      if (gap > 0 && cycle < options.soakCycles) await runtime.sleep(gap, signal);
    }
    // The reader's page holds an event stream of its own, which the baseline
    // (taken before its first read) did not; close it before the final
    // footprint so it is not reported as a leaked subscriber. Its owner closes
    // it again, which is a no-op.
    await reader?.close();
    await runtime.sleep(options.settleMs, signal);
    result.final = combineFootprints(await footprints(), "min");
    result.backendRssKiB.final = backendRssKiB();
  } finally {
    result.sessions.modelRequests = fakeModel?.counts().completions ?? 0;
    await fakeModel?.stop();
  }
  result.leaks = result.baseline && result.final ? soakLeaks(result.baseline, result.final) : [];
  result.cacheTrends = gaugeTrends(result.trend.map((sample) => sample.caches));
  result.growing = [
    ...gaugeTrends(result.trend.map((sample) => sample.footprint)),
    ...result.cacheTrends,
  ].filter((trend) => trend.growing);
  result.rssTrend =
    gaugeTrends(
      result.trend.map((sample) =>
        sample.backendRssKiB === null ? null : { "backend:rssKiB": sample.backendRssKiB },
      ),
    )[0] ?? null;
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
  busy?: BusyResult;
  /** `recurringWork` rates over the busy phase, from its round-boundary samples. */
  busyWindow?: WindowSummary | null;
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

/** The launcher's arguments for one profile. */
export function profileArguments(profile: string, options: Options): string[] {
  return [
    "apps/desktop/scripts/dev-test.ts",
    "--profile",
    profile,
    "--fixture",
    "--fixture-environments",
    options.fixtureEnvironments,
    "--no-agent-credentials",
    // By default never open a window on the host's desktop; the gateway
    // serves the app.
    ...(options.window === "hidden"
      ? ["--headless"]
      : options.window === "visible"
        ? ["--no-headless"]
        : []),
    // Read nothing from the host's own installation unless asked to.
    ...(options.hostSeed ? [] : ["--no-host-seed"]),
    ...(options.agentPlatforms ? ["--agent-platforms", options.agentPlatforms] : []),
  ];
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
    return commandProcesses.spawn("bun", profileArguments(profile, options), {
      env: checkoutEnv(options.checkout, env),
      ...(options.checkout ? { cwd: options.checkout } : {}),
      stdio: ["ignore", output, output],
    });
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
  measureBusy,
  busyClients: playwrightBusyClients,
  soakReader: playwrightSoakReader,
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
  // Headless Electron, and no display for anything the profile spawns.
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  // The host reachability probe creates Docker networks; a soak counts its own.
  env.ORKESTRATOR_HOST_REACHABILITY_CHECK = "off";
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
    const current = runtime.readStatus(profile, options.checkout);
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
        const current = runtime.readStatus(profile, options.checkout);
        if (owned(current)) {
          owner ??= current;
          log(`${profile}: stopping`);
          if (runtime.mise(["dev:stop", "--profile", profile], options.checkout).status !== 0) {
            // Stop may report failure for an already stopped profile, and
            // gives up after a few seconds while the launcher is still
            // shutting down, before it records `stopped`. Wait for our own
            // launcher to exit first. Reset still owns the profile's
            // resources, but only after verifying it is stopped.
            for (let waited = 0; !exited && waited < 60_000; waited += 1_000)
              await runtime.sleep(1_000);
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
          if (runtime.mise(["dev:reset", "--profile", profile], options.checkout).status !== 0)
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
    const existing = runtime.readStatus(profile, options.checkout);
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
      const current = runtime.readStatus(profile, options.checkout);
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
        runtime.cliRunner(profile, cliConfig(), options.checkout),
        options.freshnessProbes,
        signal,
      );
      result.freshness = freshness.map((entry) => ({
        ...entry,
        p50Ms: percentile(entry.latenciesMs, 50),
        p95Ms: percentile(entry.latenciesMs, 95),
      }));
    }
    if (options.busyRounds > 0) {
      checkedStatus();
      log(`${profile}: busy phase, ${options.busyRounds} rounds per client count`);
      if (!status.dataDir) throw new Error("The busy phase needs the profile's data directory");
      const clients = runtime.busyClients(profile, status, logDir);
      try {
        result.busy = await runtime.measureBusy(
          gateway,
          runtime.asyncCliRunner(profile, cliConfig(), options.checkout),
          { ...options, dataDir: status.dataDir },
          signal,
          {
            ...busyRuntime,
            openClients: clients.open,
            processes: () => runtime.processSamples(checkedStatus().pids),
          },
        );
        result.busyWindow = summarizeWindow(result.busy.windowSamples);
      } finally {
        await clients.close();
      }
    }
    if (options.soakCycles > 0) {
      checkedStatus();
      log(`${profile}: soak, ${options.soakCycles} cycles`);
      const reader =
        options.soakReaders > 0 ? runtime.soakReader(profile, status, logDir) : undefined;
      try {
        result.soak = await runtime.measureSoak(
          gateway,
          runtime.asyncCliRunner(profile, cliConfig(), options.checkout),
          {
            ...options,
            ...(status.dataDir ? { dataDir: status.dataDir } : {}),
            ...(reader ? { reader } : {}),
          },
          () => runtime.processSamples(checkedStatus().pids).backend?.rssKiB ?? null,
          signal,
        );
      } finally {
        await reader?.close();
      }
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
  for (const run of results) {
    if (!run.busy) continue;
    lines.push(...busySummaryLines(`${run.arm} repeat ${run.repeat}`, run.busy));
    const kinds = Object.entries(run.busyWindow?.kinds ?? {}).sort();
    if (kinds.length > 0) {
      lines.push(
        "",
        `| Busy window (${run.arm}) kind | Starts/min | Work units/min |`,
        "| --- | --- | --- |",
      );
      for (const [kind, rates] of kinds) {
        const units = Object.entries(rates.workUnitsPerMinute)
          .map(([unit, count]) => `${unit} ${count}`)
          .join(", ");
        lines.push(`| ${kind} | ${rates.startedPerMinute} | ${units} |`);
      }
    }
    const backend = run.busyWindow?.processes.backend;
    if (backend)
      lines.push(
        "",
        `Busy window backend: ${backend.cpuMsPerMinute} CPU ms/min, RSS median ${Math.round(
          backend.rssKiBMedian / 1024,
        )} MiB, max ${Math.round(backend.rssKiBMax / 1024)} MiB.`,
      );
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
  for (const run of soaks) {
    const soak = run.soak!;
    if (soak.trend.length === 0) continue;
    const mib = (kib: number) => Math.round(kib / 1024);
    lines.push(
      "",
      `Soak trend, ${run.arm} repeat ${run.repeat}: ${soak.trend.length} samples over ${Math.round(
        soak.durationMs / 60_000,
      )} min; sessions ${soak.sessions.opened}/${soak.sessions.requested} long-lived, ${
        soak.sessions.cycleSessions
      } per-cycle, ${soak.sessions.prompts} prompts, ${soak.sessions.modelRequests} model requests${
        soak.reader
          ? `; reader ${soak.reader.reads} environment reads, ${soak.reader.tabs} tabs`
          : ""
      }.`,
    );
    if (soak.rssTrend) {
      const rss = soak.rssTrend;
      lines.push(
        `Backend RSS MiB: first ${mib(rss.first)}, last ${mib(rss.last)}, min ${mib(rss.min)}, max ${mib(
          rss.max,
        )}, first-third max ${mib(rss.earlyMax)}, last-third min ${mib(rss.lateMin)}${
          rss.growing ? " (still rising)" : ""
        }.`,
      );
    }
    lines.push(
      "",
      "| Cache gauge | First | Last | Min | Max | First-third max | Last-third min | Rising |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const trend of soak.cacheTrends) {
      if (trend.max === 0) continue;
      lines.push(
        `| ${trend.gauge} | ${trend.first} | ${trend.last} | ${trend.min} | ${trend.max} | ${
          trend.earlyMax
        } | ${trend.lateMin} | ${trend.growing ? "yes" : ""} |`,
      );
    }
    lines.push(
      "",
      `Rising gauges: ${soak.growing.map((trend) => `${trend.gauge} ${trend.first}→${trend.last}`).join(", ") || "none"}`,
    );
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
    ...(options.checkout ? { cwd: options.checkout } : {}),
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
            ...(options.label ? { label: options.label } : {}),
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

function resultExitCode(
  results: Array<Pick<RunResult, "error" | "soak" | "guardLines" | "busy">>,
): number {
  return results.some(
    (run) =>
      run.error ||
      (run.busy && (busyFailed(run.busy) || run.guardLines !== 0)) ||
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
  commandProcesses,
  armRuntime,
  freshnessRuntime,
  soakRuntime,
  printSummary,
  resultExitCode,
};

if (import.meta.main) {
  process.exitCode = await withTerminationSignals(main);
}
