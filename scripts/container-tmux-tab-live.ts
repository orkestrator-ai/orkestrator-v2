import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { installFakeClaudeApiFixture } from "../e2e/agent-testing/container-fake-claude-install";
import type { KindCounters } from "./recurring-live-ab-summary";
import { checkoutEnv, withTerminationSignals } from "./recurring-live-ab";
import { gatewayFor, gatewayMetrics } from "./tmux-mail-inject-live";

/**
 * Recurring work with a claude-tmux tab open in a container, on a loopback
 * fake model: the live counts for BG-1, BG-2 and BG-8 that to-do 1202 task 1
 * asked for (docs/todo/cross-cutting/1202-efficiency-review-follow-ups.md).
 *
 * It drives a running, credential-free `dev:test` profile started with
 * `--fixture --fixture-environments local,container --no-agent-credentials`.
 * The model is `e2e/agent-testing/container-fake-claude-api.ts`, run by the
 * container's own Bun on the container's loopback and named in the
 * container's `~/.claude/settings.json` (`container-fake-claude-install.ts`),
 * so the image's real `claude` takes turns with no login and no billed
 * request. Then, reading the gateway's `recurringWork` counters on either
 * side of each window:
 *
 * 1. `no-tab`: the container environment with no tab open.
 * 2. `idle-unbound`: one claude-tmux tab, idle, before its first prompt. The
 *    CLI writes no transcript until then, so the tab is unbound (BG-1).
 * 3. `turns`: `--turns` prompts, queued one at a time and typed into the tab
 *    by the prompt-queue drainer, each waited on to busy and back to idle.
 * 4. `idle-bound`: the same tab idle again, its transcript bound (BG-2).
 * 5. `stopped`: the container stopped behind the app's back with
 *    `docker stop` while the tab is open (BG-8), and the time until the
 *    environment's stored status leaves `running`.
 *
 * Afterwards it starts the container again, undoes the fake model and stops
 * the tab's tmux session. Stopping and resetting the profile is the caller's;
 * the container and everything in it belong to that profile.
 *
 *   PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
 *     mise run dev:test --profile ctab --fixture --fixture-environments local,container \
 *     --no-agent-credentials --agent-platforms claude --headless
 *   mise exec -- bun scripts/container-tmux-tab-live.ts --profile ctab \
 *     [--checkout /abs/older/worktree] [--label base] [--window-ms 120000] [--turns 3] \
 *     [--out output/benchmarks/x.json]
 *
 * The gateway token is read from the profile's mode-0600 auth file and only
 * sent as a loopback request header. The artifact holds kinds, counts,
 * states and durations, never prompts, replies or tokens.
 */

export type Options = {
  profile: string;
  checkout?: string;
  label?: string;
  windowMs: number;
  stoppedMs: number;
  turns: number;
  out: string;
};

export function parseOptions(argv: string[]): Options {
  const options: Partial<Options> = {
    windowMs: 120_000,
    stoppedMs: 60_000,
    turns: 3,
    out: `output/benchmarks/container-tmux-tab-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    index += 1;
    if (name === "--profile") {
      if (!/^[a-z0-9-]+$/.test(value)) throw new Error("--profile takes a profile name");
      options.profile = value;
    } else if (name === "--checkout") {
      if (!path.isAbsolute(value)) throw new Error("--checkout takes an absolute path");
      options.checkout = value;
    } else if (name === "--label") {
      if (!/^[a-z0-9-]{1,24}$/.test(value))
        throw new Error("--label accepts up to 24 lowercase letters, digits and dashes");
      options.label = value;
    } else if (name === "--window-ms" || name === "--stopped-ms" || name === "--turns") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1)
        throw new Error(`${name} needs a positive integer`);
      if (name === "--window-ms") options.windowMs = parsed;
      else if (name === "--stopped-ms") options.stoppedMs = parsed;
      else options.turns = parsed;
    } else if (name === "--out") options.out = value;
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.profile) throw new Error("--profile is required");
  return options as Options;
}

/** One kind's movement over a window, scaled to a minute. */
export type KindRate = {
  started: number;
  failed: number;
  bytes: number;
  units: Record<string, number>;
};

/**
 * Per-minute movement of every kind that moved between two counter reads.
 * A counter that went backwards means the backend restarted mid-window,
 * which would make the whole window meaningless, so it throws.
 */
export function windowRates(
  before: Record<string, KindCounters>,
  after: Record<string, KindCounters>,
  elapsedMs: number,
): Record<string, KindRate> {
  if (!(elapsedMs > 0)) throw new Error("A window needs a positive duration");
  const perMinute = (value: number) => Math.round((value * 60_000 * 100) / elapsedMs) / 100;
  const rates: Record<string, KindRate> = {};
  for (const [kind, counters] of Object.entries(after)) {
    const prior = before[kind];
    const delta = (now: number, then: number | undefined) => {
      const moved = now - (then ?? 0);
      if (!Number.isFinite(moved) || moved < 0)
        throw new Error(`Measurement counters reset or invalid: ${kind}`);
      return moved;
    };
    const started = delta(counters.started, prior?.started);
    const failed = delta(counters.failed, prior?.failed);
    const bytes = delta(counters.bytes, prior?.bytes);
    const units: Record<string, number> = {};
    for (const [unit, count] of Object.entries(counters.workUnits)) {
      const moved = delta(count, prior?.workUnits[unit]);
      if (moved) units[unit] = perMinute(moved);
    }
    if (started || failed || bytes || Object.keys(units).length)
      rates[kind] = {
        started: perMinute(started),
        failed: perMinute(failed),
        bytes: perMinute(bytes),
        units,
      };
  }
  return rates;
}

/**
 * A short, content-free label for one `exec_start` action from
 * `docker events`: the program and its first word of arguments, so a
 * window's execs can be told apart without recording what they ran.
 */
export function execLabel(action: string): string {
  const command = action
    .replace(/^exec_start:\s*/, "")
    .split("\n")[0]!
    .trim();
  const words = command.split(/\s+/).filter(Boolean);
  const program = path.basename(words[0] ?? "?");
  const first = words[1] ?? "";
  // `sh -c <script>`: name the script's first program instead of `-c`.
  if ((program === "sh" || program === "bash" || program === "zsh") && /^-l?c$/.test(first))
    return `${program} -c ${path.basename(words[2] ?? "")}`.trim();
  return /^[A-Za-z][\w.-]{0,30}$/.test(first) ? `${program} ${first}` : program;
}

/**
 * Counts the `docker exec` sessions Docker itself reports for one container,
 * whatever started them, from `docker events`. This is the authoritative
 * count across commits: an older backend does not instrument every loop in
 * its `recurringWork` counters.
 */
export function execCounter(
  containerId: string,
  start: typeof spawn = spawn,
  settle: () => Promise<unknown> = () => delay(1_000),
) {
  const child = start(
    "docker",
    [
      "events",
      "--filter",
      `container=${containerId}`,
      "--filter",
      "event=exec_start",
      "--format",
      "{{json .Action}}",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let stopping = false;
  let failed = false;
  // Observe errors immediately; neither a spawn error nor an early clean exit
  // proves a complete event stream. Never retain Docker's potentially sensitive output.
  const closed = new Promise<void>((resolve) => {
    child.on("error", () => {
      failed = true;
    });
    child.once("exit", () => {
      if (!stopping) failed = true;
    });
    child.once("close", () => {
      if (!stopping) failed = true;
      resolve();
    });
  });
  const labels: Record<string, number> = {};
  let total = 0;
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    let action: unknown;
    try {
      action = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof action !== "string") return;
    total += 1;
    const label = execLabel(action);
    labels[label] = (labels[label] ?? 0) + 1;
  });
  return {
    async stop(): Promise<{ total: number; labels: Record<string, number> }> {
      // Docker delivers events a moment after they happen.
      await settle();
      if (child.exitCode !== null || child.signalCode !== null) failed = true;
      stopping = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(escalation);
        lines.close();
      }
      if (failed) throw new Error("Docker event collector interrupted; measurement invalid");
      return { total, labels };
    },
  };
}

/** A failed read or body never publishes a window; the owned collector is always reaped. */
export async function collectWindow<T>(
  start: () => { stop(): Promise<{ total: number; labels: Record<string, number> }> },
  kinds: () => Promise<Record<string, KindCounters>>,
  body: () => Promise<T>,
) {
  const collector = start();
  let counted;
  let measurement;
  try {
    const before = await kinds();
    const startedAt = Date.now();
    const value = await body();
    const after = await kinds();
    measurement = { value, before, after, elapsedMs: Date.now() - startedAt };
  } finally {
    counted = await collector.stop();
  }
  return { ...measurement, counted };
}

/** One container change signal's content-free health: states held, rings, demotions. */
export type SignalHealth = {
  containers: number;
  states: Record<string, number>;
  fallback: number;
  rings: number;
  demotions: Record<string, number>;
};

/**
 * The `recurringWork.signals` block of the gateway metrics (the doorbell's
 * `tmux-hook-signal` among them), keeping only non-zero states. `null` when
 * the backend publishes none, as older commits do not.
 */
export function signalHealth(metrics: unknown): Record<string, SignalHealth> | null {
  const raw = (metrics as { recurringWork?: { signals?: unknown } } | null)?.recurringWork?.signals;
  if (!Array.isArray(raw)) return null;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const nonZero = (record: unknown) => {
    const result: Record<string, number> = {};
    if (record && typeof record === "object")
      for (const [key, value] of Object.entries(record))
        if (count(value) > 0) result[key] = count(value);
    return result;
  };
  const health: Record<string, SignalHealth> = {};
  for (const entry of raw as Array<{ name?: unknown; status?: Record<string, unknown> }>) {
    if (typeof entry?.name !== "string" || !entry.status) continue;
    health[entry.name] = {
      containers: count(entry.status.containers),
      states: nonZero(entry.status.states),
      fallback: count(entry.status.fallback),
      rings: count(entry.status.rings),
      demotions: nonZero(entry.status.demotions),
    };
  }
  return health;
}

/** Every `docker exec` a window's kinds made, per minute. */
export function dockerExecPerMinute(rates: Record<string, KindRate>): number {
  let total = 0;
  for (const rate of Object.values(rates)) total += rate.units["docker-exec"] ?? 0;
  return Math.round(total * 100) / 100;
}

type Status = { status?: string; dataDir?: string; browserUrl?: string; authFile?: string };
type Environment = {
  id: string;
  name?: string;
  environmentType?: string;
  containerId?: string | null;
  status?: string;
};
type TmuxStatus = { running?: boolean; busy?: boolean; session_id?: string | null };

const log = (message: string) => console.error(`[container-tmux-tab-live] ${message}`);

function profileStatus(options: Options): Status {
  const result = spawnSync("mise", ["run", "dev:status", "--profile", options.profile, "--json"], {
    encoding: "utf8",
    env: checkoutEnv(options.checkout),
    ...(options.checkout ? { cwd: options.checkout } : {}),
  });
  return JSON.parse(result.stdout) as Status;
}

/**
 * The real Docker CLI for the container's own commands. The qualification
 * shim, when it is first on PATH, passes these through unchanged.
 */
function docker(args: string[], input?: string, timeout = 30_000): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout, input });
  if (result.status !== 0) throw new Error(`docker ${args[0]} ${args[1] ?? ""} failed`);
  return result.stdout.trim();
}

/**
 * Whether the tab's Claude transcript (`<session id>.jsonl` under the
 * container's `~/.claude/projects`) exists, which is what decides whether
 * the poll can bind it; `null` when the tab reports no session id.
 */
function transcriptExists(containerId: string, sessionId: string | null | undefined) {
  if (!sessionId || !/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  const found = spawnSync(
    "docker",
    [
      "exec",
      "--user",
      "node",
      containerId,
      "sh",
      "-c",
      `ls "$HOME"/.claude/projects/*/${sessionId}.jsonl >/dev/null 2>&1`,
    ],
    { timeout: 15_000 },
  );
  return found.status === 0;
}

const FAKE_API_SOURCE = path.join(
  import.meta.dirname,
  "..",
  "e2e",
  "agent-testing",
  "container-fake-claude-api.ts",
);

async function installFakeModel(containerId: string, signal: AbortSignal): Promise<() => void> {
  return installFakeClaudeApiFixture({
    asNode: (script, input) =>
      docker(["exec", "-i", "--user", "node", containerId, "sh", "-c", script], input),
    startServer: (args) => docker(["exec", "-d", "--user", "node", containerId, ...args]),
    stopServer: () => {
      // The bracket keeps pkill from matching its own command line; exit 1 is fine.
      spawnSync(
        "docker",
        ["exec", containerId, "pkill", "-f", "orkestrator-qa-fake-claude-ap[i]"],
        {
          timeout: 15_000,
        },
      );
    },
    source: readFileSync(FAKE_API_SOURCE, "utf8"),
    waitUntilReady: async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const probe = spawnSync(
          "docker",
          ["exec", containerId, "curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:47123/"],
          { timeout: 10_000 },
        );
        // Any HTTP answer, even a 404, means the server is listening.
        if (probe.status === 0 || probe.status === 22) return;
        if (Date.now() > deadline) throw new Error("The container's fake model never started");
        await delay(500, undefined, { signal });
      }
    },
  });
}

async function containerEnvironment(
  gateway: ReturnType<typeof gatewayFor>,
): Promise<Environment | undefined> {
  for (const project of await gateway.invoke<Array<{ id: string }>>("get_projects")) {
    const environments = await gateway.invoke<Environment[]>("get_environments", {
      projectId: project.id,
    });
    const found = environments.find(
      (environment) => environment.environmentType === "containerized",
    );
    if (found) return found;
  }
  return undefined;
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  probe: () => Promise<T | null | undefined | false>,
  signal: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(250, undefined, { signal });
  }
}

type WindowResult = {
  name: string;
  elapsedMs: number;
  /** What Docker saw: every exec in the container, whoever started it. */
  containerExecs: { total: number; perMinute: number; labels: Record<string, number> };
  /** The `docker-exec` work units the backend's own counters recorded. */
  dockerExecPerMinute: number;
  kinds: Record<string, KindRate>;
  /** Change-signal health read either side of the window (the doorbell's state and rings). */
  signals: {
    before: Record<string, SignalHealth> | null;
    after: Record<string, SignalHealth> | null;
  };
  note?: string;
};

const runtime = {
  profileStatus,
  gatewayFor,
  gatewayMetrics,
  docker,
  waitFor,
  delay,
  installFakeModel,
  execCounter,
  transcriptExists,
};

export async function runContainerTabBenchmark(
  options: Options,
  signal: AbortSignal,
  dependencies: Partial<typeof runtime> = {},
): Promise<number> {
  const {
    profileStatus,
    gatewayFor,
    gatewayMetrics,
    docker,
    waitFor,
    delay,
    installFakeModel,
    execCounter,
    transcriptExists,
  } = { ...runtime, ...dependencies };
  const status = profileStatus(options);
  if (status.status !== "ready") throw new Error("Profile is not ready");
  const gateway = gatewayFor(status, signal);
  const environment = await waitFor(
    "a running container environment",
    600_000,
    async () => {
      const found = await containerEnvironment(gateway);
      return found?.containerId && found.status === "running" ? found : null;
    },
    signal,
  );
  const containerId = environment.containerId!;
  const tabId = `q1202-${randomUUID().slice(0, 8)}`;
  const windows: WindowResult[] = [];
  const result: Record<string, unknown> = {
    profile: options.profile,
    label: options.label ?? null,
    commit: spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      ...(options.checkout ? { cwd: options.checkout } : {}),
    }).stdout.trim(),
    platform: process.platform,
    arch: process.arch,
    image: docker(["inspect", "--format", "{{.Config.Image}}", containerId]),
    imageCapabilities: docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "org.orkestrator.image.capabilities"}}',
      containerId,
    ]),
    model:
      "loopback fake inside the container (e2e/agent-testing/container-fake-claude-api.ts); no provider was called",
    at: new Date().toISOString(),
    turnsIncludeDriverStatusProbes: true,
    windows,
  };
  const sleep = (ms: number) => delay(ms, undefined, { signal });
  /** Runs `body` inside a window: counters and Docker's exec count on either side. */
  const signals = () =>
    gatewayMetrics(status, signal)
      .then(signalHealth)
      .catch(() => null);
  const inWindow = async <T>(name: string, body: () => Promise<T>, note?: string): Promise<T> => {
    const signalsBefore = await signals();
    const { value, before, after, elapsedMs, counted } = await collectWindow(
      () => execCounter(containerId),
      () => gateway.kinds(),
      body,
    );
    const kinds = windowRates(before, after, elapsedMs);
    windows.push({
      name,
      elapsedMs,
      containerExecs: {
        ...counted,
        perMinute: Math.round((counted.total * 60_000 * 100) / elapsedMs) / 100,
      },
      dockerExecPerMinute: dockerExecPerMinute(kinds),
      kinds,
      signals: { before: signalsBefore, after: await signals() },
      ...(note ? { note } : {}),
    });
    return value;
  };
  const measure = async (name: string, ms: number, note?: string) => {
    log(`window ${name}: ${Math.round(ms / 1000)} s`);
    await inWindow(name, () => sleep(ms), note);
  };
  const tab = () =>
    gateway.invoke<TmuxStatus | null>("claude_tmux_status", {
      environmentId: environment.id,
      tabId,
    });

  let undoFake: (() => void) | undefined;
  let launched = false;
  let stoppedContainer = false;
  let exitCode = 0;
  try {
    await sleep(30_000);
    await measure("no-tab", options.windowMs);

    undoFake = await installFakeModel(containerId, signal);
    log("opening a claude-tmux tab on the container environment");
    const launchAt = Date.now();
    launched = true; // An interrupted launch may already have reached the backend.
    await gateway.invoke("launch_terminal_job", {
      environmentId: environment.id,
      requestId: `q1202-${tabId}`,
      tabId,
      tabType: "claude-tmux",
      title: "1202 container tab",
    });
    await waitFor(
      "the tab to run idle",
      180_000,
      async () => {
        const current = await tab();
        return current?.running && current.busy !== true ? current : null;
      },
      signal,
    );
    result.tabReadyMs = Date.now() - launchAt;
    await sleep(20_000);
    const sessionId = (await tab())?.session_id;
    result.transcriptBeforeFirstPrompt = transcriptExists(containerId, sessionId);
    await measure("idle-unbound", options.windowMs, "before the first prompt");

    const stateKey = `env:${environment.id}:tab:${tabId}`;
    const queueKey = `claude-tmux\0${stateKey}`;
    const turns: Array<{ busyMs: number | null; idleMs: number | null }> = [];
    log(`window turns: ${options.turns} prompts`);
    await inWindow(
      "turns",
      async () => {
        for (let turn = 0; turn < options.turns; turn += 1) {
          const id = `q1202-${tabId}-${turn}`;
          const sentAt = Date.now();
          await gateway.invoke("enqueue_prompt_queue_message", {
            queueKey,
            environmentId: environment.id,
            message: { id, text: `Fixture prompt ${turn}. Reply with one word.`, attachments: [] },
          });
          const busyAt = await waitFor(
            "the tab to go busy",
            60_000,
            async () => ((await tab())?.busy === true ? Date.now() : null),
            signal,
          ).catch(() => null);
          // Keep failed transitions in the artifact; they invalidate bound-idle.
          const idleAt = await waitFor(
            "the tab to go idle",
            90_000,
            async () => {
              const current = await tab();
              return current?.running && current.busy !== true ? Date.now() : null;
            },
            signal,
          ).catch(() => null);
          turns.push({
            busyMs: busyAt === null ? null : busyAt - sentAt,
            idleMs: idleAt === null ? null : idleAt - sentAt,
          });
          await sleep(5_000);
        }
      },
      `${options.turns} queued prompts, 5 s apart; raw counts include driver claude_tmux_status liveness probes and are not a polling-cost comparison`,
    );
    result.turns = turns;
    await sleep(20_000);
    const boundIdle = async () => {
      const current = await tab();
      const transcript = transcriptExists(containerId, current?.session_id);
      return current?.running === true && current.busy === false && transcript === true;
    };
    result.transcriptAfterTurns = transcriptExists(containerId, (await tab())?.session_id);
    if (
      turns.some((turn) => turn.busyMs === null || turn.idleMs === null) ||
      !(await boundIdle())
    ) {
      result.idleBoundInvalid = "Missing turn transition, idle running tab, or transcript";
      exitCode = 1;
    } else {
      // Only append a window after its end state has also been validated.
      try {
        await inWindow(
          "idle-bound",
          async () => {
            await sleep(options.windowMs);
            if (!(await boundIdle()))
              throw new Error("Bound tab did not remain running and idle with a transcript");
          },
          "after the turns, transcript bound; running and idle at both boundaries",
        );
      } catch {
        result.idleBoundInvalid = "Bound-idle window failed its measurement or end-state check";
        exitCode = 1;
      }
    }

    log("stopping the container behind the app's back");
    const leftRunning = await inWindow(
      "stopped",
      async () => {
        const stopAt = Date.now();
        docker(["stop", "--time", "5", containerId], undefined, 60_000);
        stoppedContainer = true;
        const left = await waitFor(
          "the stored status to leave running",
          options.stoppedMs,
          async () => {
            const found = await containerEnvironment(gateway);
            return found && found.status !== "running"
              ? { ms: Date.now() - stopAt, status: found.status ?? null }
              : null;
          },
          signal,
        ).catch(() => null);
        const remaining = options.stoppedMs - (Date.now() - stopAt);
        if (remaining > 0) await sleep(remaining);
        return left;
      },
      "docker stop outside the app with the tab open; counted from the stop",
    );
    result.statusLeftRunning = leftRunning;
  } catch (error) {
    exitCode = 1;
    result.error = error instanceof Error ? error.message : "failed";
    log(`failed: ${String(result.error)}`);
  } finally {
    const cleanupFailures: string[] = [];
    if (stoppedContainer) {
      try {
        docker(["start", containerId], undefined, 60_000);
        await delay(10_000);
      } catch {
        cleanupFailures.push("container-restart");
        log("could not start the container again; dev:reset removes it");
      }
    }
    if (launched) {
      await gateway
        .invoke("claude_tmux_stop", { environmentId: environment.id, tabId }, true)
        .catch(() => {
          cleanupFailures.push("tab-stop");
          log("could not stop the tab's tmux session");
        });
    }
    try {
      undoFake?.();
    } catch {
      cleanupFailures.push("fake-model-restore");
      log("could not undo the fake model; dev:reset removes the container");
    }
    if (cleanupFailures.length) {
      exitCode = 1;
      result.cleanupFailed = true;
      result.cleanupFailures = cleanupFailures;
    }
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
    log(`wrote ${options.out}`);
    for (const window of windows) {
      const poll = window.kinds["tmux-poll"];
      log(
        `${window.name}: container execs ${window.containerExecs.perMinute}/min (counted ${window.dockerExecPerMinute}/min); tmux-poll starts ${poll?.started ?? 0}/min, docker exec ${poll?.units["docker-exec"] ?? 0}/min`,
      );
    }
  }
  return exitCode;
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  process.exitCode = await withTerminationSignals((signal) =>
    runContainerTabBenchmark(options, signal),
  );
}
