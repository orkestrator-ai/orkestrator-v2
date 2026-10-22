import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  parsePsRows,
  percentile,
  pickKindCounters,
  processTreeTotals,
  summarizeWindow,
  type LiveSample,
  type ProcessSample,
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

type Options = {
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
};

function parseOptions(argv: string[]): Options {
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
    else throw new Error(`Unknown option ${name}`);
  }
  if (!/^[a-z0-9-]+$/.test(options.profilePrefix)) {
    throw new Error("--profile-prefix accepts lowercase letters, digits and dashes");
  }
  return options;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message: string) => console.error(`[recurring-live-ab] ${message}`);

type Status = {
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
function gatewayFor(status: Status) {
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
          signal: AbortSignal.timeout(10_000),
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

function cliRunner(profile: string) {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "recurring-live-ab-cli-"));
  return (args: string[]) =>
    spawnSync("bun", ["packages/cli/bin/orkestrator.js", "--profile", profile, ...args], {
      encoding: "utf8",
      env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: configDir },
      maxBuffer: 16 * 1024 * 1024,
    });
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
    cli([
      "environment",
      "exec",
      environment.id,
      "--wait",
      "--",
      "sh",
      "-c",
      `printf '\\n<!-- recurring-live-ab probe -->\\n' >> '${file}'`,
    ]);
  };
}

type Freshness = { environment: "local" | "container"; latenciesMs: number[]; timeouts: number };

async function measureFreshness(
  gateway: ReturnType<typeof gatewayFor>,
  cli: ReturnType<typeof cliRunner>,
  probes: number,
): Promise<Freshness[]> {
  const results: Freshness[] = [];
  for (const environment of fixtureEnvironments(cli)) {
    const write = trackedFileWriter(cli, environment);
    if (!write) {
      log(`no tracked file found in the ${environment.kind} environment; skipping freshness`);
      continue;
    }
    const timeoutMs = environment.kind === "local" ? 30_000 : 60_000;
    const entry: Freshness = { environment: environment.kind, latenciesMs: [], timeouts: 0 };
    for (let probe = 0; probe < probes; probe += 1) {
      const before = recurringKinds(await gateway.metrics())?.["diff-scan"]?.changed ?? 0;
      const startedAt = performance.now();
      write();
      let seen = false;
      while (performance.now() - startedAt < timeoutMs) {
        const changed = recurringKinds(await gateway.metrics())?.["diff-scan"]?.changed ?? 0;
        if (changed > before) {
          entry.latenciesMs.push(Math.round(performance.now() - startedAt));
          seen = true;
          break;
        }
        await sleep(100);
      }
      if (!seen) entry.timeouts += 1;
      // Let the scan settle, then start the next probe at a random point of
      // the 15 s container poll: a fixed gap would phase-lock every write to
      // the same offset after a scan and report one latency over and over.
      await sleep(3_000 + Math.floor(Math.random() * 15_000));
    }
    results.push(entry);
  }
  return results;
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
  error?: string;
};

function countGuardLines(logDir: string | undefined): number | null {
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

async function runArm(
  options: Options,
  arm: Arm,
  repeat: number,
  logDir: string,
): Promise<RunResult> {
  const profile = `${options.profilePrefix}-${arm}-${repeat}`;
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
  const output = openSync(path.join(logDir, `${profile}.log`), "a");
  log(`${profile}: starting`);
  const startedAt = performance.now();
  const child: ChildProcess = spawn(
    "mise",
    [
      "run",
      "dev:test",
      "--profile",
      profile,
      "--fixture",
      "--fixture-environments",
      options.fixtureEnvironments,
      "--no-agent-credentials",
    ],
    { env, stdio: ["ignore", output, output] },
  );
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  let status: Status | null = null;
  try {
    while (performance.now() - startedAt < options.readyTimeoutMs) {
      if (exited) throw new Error("dev:test exited before the profile was ready");
      status = readStatus(profile);
      if (status?.status === "ready" && status.live?.launcher) break;
      status = null;
      await sleep(5_000);
    }
    if (!status) throw new Error("profile did not become ready in time");
    result.readyAfterMs = Math.round(performance.now() - startedAt);
    log(`${profile}: ready after ${Math.round(result.readyAfterMs / 1000)} s; settling`);
    const gateway = gatewayFor(status);
    await sleep(options.settleMs);
    const samples: LiveSample[] = [];
    const windowStart = performance.now();
    for (;;) {
      const atMs = Math.round(performance.now() - windowStart);
      samples.push({
        atMs,
        kinds: recurringKinds(await gateway.metrics()),
        processes: processSamples(status.pids),
      });
      if (atMs >= options.windowMs) break;
      await sleep(Math.min(options.sampleMs, Math.max(0, options.windowMs - atMs)));
    }
    result.summary = summarizeWindow(samples);
    if (arm !== "metrics-off" && options.freshnessProbes > 0) {
      log(`${profile}: freshness probes`);
      const freshness = await measureFreshness(
        gateway,
        cliRunner(profile),
        options.freshnessProbes,
      );
      result.freshness = freshness.map((entry) => ({
        ...entry,
        p50Ms: percentile(entry.latenciesMs, 50),
        p95Ms: percentile(entry.latenciesMs, 95),
      }));
    }
    result.guardLines = countGuardLines(status.logDir);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`${profile}: ${result.error}`);
  } finally {
    log(`${profile}: stopping`);
    mise(["dev:stop", "--profile", profile]);
    for (let waited = 0; !exited && waited < 60_000; waited += 1_000) await sleep(1_000);
    if (!exited) child.kill("SIGTERM");
    if (!options.keepProfiles) mise(["dev:reset", "--profile", profile, "--stop-first"]);
  }
  return result;
}

function printSummary(results: RunResult[]): void {
  const lines = [
    "| Arm | Repeat | Kind | Starts/min | Work units/min |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const run of results) {
    for (const [kind, rates] of Object.entries(run.summary?.kinds ?? {}).sort()) {
      const units = Object.entries(rates.workUnitsPerMinute)
        .map(([unit, count]) => `${unit} ${count}`)
        .join(", ");
      lines.push(`| ${run.arm} | ${run.repeat} | ${kind} | ${rates.startedPerMinute} | ${units} |`);
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
    "| Arm | Repeat | Environment | p50 ms | p95 ms | Probes | Timeouts |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const run of results) {
    for (const entry of run.freshness) {
      lines.push(
        `| ${run.arm} | ${run.repeat} | ${entry.environment} | ${entry.p50Ms ?? "—"} | ${entry.p95Ms ?? "—"} | ${
          entry.latenciesMs.length + entry.timeouts
        } | ${entry.timeouts} |`,
      );
    }
  }
  console.log(lines.join("\n"));
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const out = path.resolve(options.out);
  const logDir = path.join(path.dirname(out), "recurring-live-ab-logs");
  mkdirSync(logDir, { recursive: true });
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const results: RunResult[] = [];
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    for (const arm of options.arms) {
      results.push(await runArm(options, arm, repeat, logDir));
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
  return results.some((run) => run.error) ? 1 : 0;
}

process.exitCode = await main();
