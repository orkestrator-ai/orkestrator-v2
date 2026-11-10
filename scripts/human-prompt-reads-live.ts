import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeAnthropicModel } from "../e2e/agent-testing/fake-anthropic-model";
import { checkoutEnv, withTerminationSignals } from "./recurring-live-ab";
import {
  __testing as mailTesting,
  gatewayFor,
  gatewayMetrics,
  isolatedClaudeDirectory,
} from "./tmux-mail-inject-live";

/**
 * BG-9 live (to-do 1202 task 1, docs/todo/cross-cutting/1202-efficiency-review-follow-ups.md):
 * what the human-prompt monitor costs a working native Claude session whose
 * transcript is not changing.
 *
 * The monitor (`AgentHumanPromptMonitor`) runs every 5 s and reads each working
 * session's `/session/:id/human-prompts` from its bridge. BG-9 reuses the last
 * read while the session's content revision is unchanged, for at most 30 s.
 * The monitor is not a recurring job, so each bridge request it makes is
 * charged to the backend's unattributed `provider-request` counter; the
 * activity sweep, queue scan and interaction observer charge their own kinds.
 * With no browser open and no CLI call in flight, the unattributed count over
 * a held turn is the monitor's reads.
 *
 * One session through the profile's own CLI (`--checkout` for an older
 * commit), the profile's isolated Claude directory pointed at a loopback fake
 * model. Two windows: the session idle, then a turn held at the fake model.
 * Afterwards it releases the turn, waits for idle and restores the Claude
 * directory. Stopping and resetting the profile is the caller's. The artifact
 * holds counts and durations only, never prompts, transcript or tokens.
 *
 *   mise exec -- bun scripts/human-prompt-reads-live.ts --profile bg9-after \
 *     [--checkout /abs/older/worktree] [--label base] [--idle-ms 60000] \
 *     [--working-ms 180000] [--out output/benchmarks/x.json]
 */

export type Options = {
  profile: string;
  checkout?: string;
  label?: string;
  idleMs: number;
  workingMs: number;
  out: string;
};

export function parseOptions(argv: string[]): Options {
  const options: Partial<Options> = {
    idleMs: 60_000,
    workingMs: 180_000,
    out: `output/benchmarks/human-prompt-reads-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
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
    } else if (name === "--idle-ms" || name === "--working-ms") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1000)
        throw new Error(`${name} needs an integer of at least 1000`);
      if (name === "--idle-ms") options.idleMs = parsed;
      else options.workingMs = parsed;
    } else if (name === "--out") options.out = value;
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.profile) throw new Error("--profile is required");
  return options as Options;
}

/** Provider requests from the gateway metrics: unattributed, and per kind that made any. */
export type ProviderRequests = { unattributed: number; byKind: Record<string, number> };

export function providerRequests(metrics: unknown): ProviderRequests {
  const block = (metrics as { recurringWork?: { metrics?: unknown } } | null)?.recurringWork
    ?.metrics as
    | {
        kinds?: Record<string, { workUnits?: Record<string, unknown> }>;
        unattributed?: { workUnits?: Record<string, unknown> };
      }
    | undefined;
  const unattributed = block?.unattributed?.workUnits?.["provider-request"] ?? 0;
  if (!block?.kinds || typeof unattributed !== "number" || !Number.isSafeInteger(unattributed))
    throw new Error("Recurring-work provider-request counters unavailable");
  const byKind: Record<string, number> = {};
  for (const [kind, counters] of Object.entries(block.kinds)) {
    const value = counters?.workUnits?.["provider-request"];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`Invalid provider-request counter for ${kind}`);
    if (value > 0) byKind[kind] = value;
  }
  return { unattributed, byKind };
}

/** Per-minute movement between two reads; a counter that went backwards fails. */
export function providerRequestRates(
  before: ProviderRequests,
  after: ProviderRequests,
  elapsedMs: number,
): {
  unattributed: number;
  unattributedPerMinute: number;
  byKindPerMinute: Record<string, number>;
} {
  if (!(elapsedMs > 0)) throw new Error("Window has no duration");
  const perMinute = (count: number) => Math.round((count / elapsedMs) * 60_000 * 100) / 100;
  const unattributed = after.unattributed - before.unattributed;
  if (unattributed < 0) throw new Error("Unattributed provider-request counter went backwards");
  const byKindPerMinute: Record<string, number> = {};
  for (const [kind, value] of Object.entries(after.byKind)) {
    const moved = value - (before.byKind[kind] ?? 0);
    if (moved < 0) throw new Error(`provider-request counter for ${kind} went backwards`);
    if (moved > 0) byKindPerMinute[kind] = perMinute(moved);
  }
  return { unattributed, unattributedPerMinute: perMinute(unattributed), byKindPerMinute };
}

type CliResult = { status: number | null; stdout: string };

function cliRunner(profile: string, configDir: string, checkout: string | undefined) {
  return (args: string[], signal: AbortSignal): Promise<CliResult> =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(
        "bun",
        ["packages/cli/bin/orkestrator.js", "--profile", profile, ...args, "--json"],
        {
          env: { ...checkoutEnv(checkout), ORKESTRATOR_CLI_CONFIG_DIR: configDir },
          ...(checkout ? { cwd: checkout } : {}),
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let stdout = "";
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
      };
      const timeout = setTimeout(stop, 5 * 60_000);
      signal.addEventListener("abort", stop, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 1024 * 1024) stdout += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", stop);
        if (signal.aborted) reject(signal.reason);
        else resolve({ status, stdout });
      });
    });
}

function sessionIdOf(result: CliResult): string | null {
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

const log = (message: string) => console.error(`[human-prompt-reads-live] ${message}`);

type Environment = {
  id: string;
  environmentType?: string;
  worktreePath?: string;
  agentActivityState?: string;
};

export async function runHumanPromptReads(options: Options, signal: AbortSignal): Promise<number> {
  const statusRun = spawnSync(
    "mise",
    ["run", "dev:status", "--profile", options.profile, "--json"],
    {
      encoding: "utf8",
      env: checkoutEnv(options.checkout),
      ...(options.checkout ? { cwd: options.checkout } : {}),
    },
  );
  const status = JSON.parse(statusRun.stdout) as {
    status?: string;
    browserUrl?: string;
    authFile?: string;
    dataDir?: string;
    testProject?: string;
  };
  if (status.status !== "ready" || !status.dataDir) throw new Error("Profile is not ready");
  const directory = isolatedClaudeDirectory(status.dataDir, options.profile);
  const gatewayStatus = status as Parameters<typeof gatewayFor>[0];
  const gateway = gatewayFor(gatewayStatus, signal);
  const sleep = (ms: number) => delay(ms, undefined, { signal });
  const projects = await gateway.invoke<Array<{ id: string; localPath?: string }>>("get_projects");
  const project = projects.find((candidate) => candidate.localPath === status.testProject);
  if (!project) throw new Error("Profile has no seeded fixture project");
  const environmentOf = async () =>
    (await gateway.invoke<Environment[]>("get_environments", { projectId: project.id })).find(
      (candidate) => candidate.environmentType === "local" && candidate.worktreePath,
    );
  const environment = await environmentOf();
  if (!environment?.worktreePath) throw new Error("Profile has no local fixture environment");
  const activity = async () => (await environmentOf())?.agentActivityState ?? "unknown";
  const read = async () => providerRequests(await gatewayMetrics(gatewayStatus, signal));

  const configDir = mkdtempSync(path.join(os.tmpdir(), "bg9-cli-"));
  const cli = cliRunner(options.profile, configDir, options.checkout);
  const model = await startFakeAnthropicModel();
  let restore: (() => void) | undefined;
  const hold = `bg9-${Date.now().toString(36)}`;
  const windows: Array<Record<string, unknown>> = [];
  const result: Record<string, unknown> = {
    profile: options.profile,
    label: options.label ?? null,
    commit: spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      ...(options.checkout ? { cwd: options.checkout } : {}),
    }).stdout.trim(),
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    method:
      "One native Claude session via the profile CLI on a loopback fake model; no browser. Windows: session idle, then a turn held at the model. Unattributed provider-request = the human-prompt monitor's bridge reads.",
    windows,
  };
  const measure = async (name: string, ms: number) => {
    log(`window ${name}: ${Math.round(ms / 1000)} s`);
    const stateBefore = await activity();
    const before = await read();
    const startedAt = Date.now();
    await sleep(ms);
    const after = await read();
    const elapsedMs = Date.now() - startedAt;
    const stateAfter = await activity();
    windows.push({
      name,
      elapsedMs,
      activity: { before: stateBefore, after: stateAfter },
      ...providerRequestRates(before, after, elapsedMs),
    });
  };
  let exitCode = 0;
  try {
    restore = mailTesting.mailRuntime.claudeFixture(
      directory,
      model.origin,
      environment.worktreePath,
    );
    const started = await cli(
      [
        "session",
        "start",
        "--environment",
        environment.id,
        "--agent",
        "claude",
        "--prompt",
        "Reply with one word.",
        "--wait",
        "--timeout",
        "3m",
      ],
      signal,
    );
    const sessionId = sessionIdOf(started);
    if (started.status !== 0 || !sessionId)
      throw new Error(`session start failed (exit ${started.status ?? "signal"})`);
    if (model.calls().length === 0) throw new Error("The session never reached the fake model");
    for (const deadline = Date.now() + 60_000; (await activity()) !== "idle";) {
      if (Date.now() > deadline) throw new Error("The first turn never went idle");
      await sleep(1_000);
    }
    await sleep(15_000);
    await measure("idle", options.idleMs);
    const prompted = await cli(
      ["session", "prompt", sessionId, "--prompt", `Reply with one word. [hold:${hold}]`],
      signal,
    );
    if (prompted.status !== 0)
      throw new Error(`session prompt failed (exit ${prompted.status ?? "signal"})`);
    for (const deadline = Date.now() + 120_000; !model.held().includes(hold);) {
      if (Date.now() > deadline) throw new Error("The held turn never reached the fake model");
      await sleep(250);
    }
    for (const deadline = Date.now() + 60_000; (await activity()) !== "working";) {
      if (Date.now() > deadline) throw new Error("The held turn never reported working");
      await sleep(1_000);
    }
    // Past the dispatch's own follow-up reads.
    await sleep(20_000);
    await measure("working-held", options.workingMs);
    model.release(hold);
    for (const deadline = Date.now() + 120_000; (await activity()) !== "idle";) {
      if (Date.now() > deadline) throw new Error("The released turn never went idle");
      await sleep(1_000);
    }
    result.modelCalls = model.calls().length;
    result.ok = true;
  } catch (error) {
    exitCode = 1;
    result.ok = false;
    result.error = error instanceof Error ? error.message.split("\n")[0] : "failed";
    log(`failed: ${String(result.error)}`);
  } finally {
    model.release(hold);
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => restore?.()),
      model.stop(),
    ]);
    rmSync(configDir, { recursive: true, force: true });
    if (cleanup.some((outcome) => outcome.status === "rejected")) {
      exitCode = 1;
      result.ok = false;
      result.cleanupFailed = true;
    }
    mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
    log(`wrote ${options.out}`);
  }
  return exitCode;
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  process.exitCode = await withTerminationSignals((signal) => runHumanPromptReads(options, signal));
}
