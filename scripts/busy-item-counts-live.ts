import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { dockerExecPerMinute, windowRates, type KindRate } from "./container-tmux-tab-live";
import { checkoutEnv, withTerminationSignals } from "./recurring-live-ab";
import { gatewayFor } from "./tmux-mail-inject-live";

/**
 * Per-item recurring-work counts on a populated profile: the live counts of
 * to-do 1202 tasks 2 and 10 that an idle fixture could not give
 * (docs/todo/cross-cutting/1202-efficiency-review-follow-ups.md, task 1).
 *
 * It drives a profile the 0048 busy driver has already filled and kept
 * (`recurring-live-ab.ts --busy-rounds N --keep-profiles`), started again
 * with `dev:test`: ten local environments, Pi sessions and their mailboxes,
 * agent mail, prompt queues, approvals and Multi Reviews in the stores. It
 * reads the gateway's `recurringWork` counters on either side of two windows:
 *
 * 1. `populated`: every environment running, nothing happening.
 * 2. `stopped`: every environment named `busy-*` stopped through the public
 *    `environment.stop` action, so the presence pass meets stopped
 *    environments that own mailboxes (BG-3).
 *
 * It starts the stopped environments again afterwards. Stopping and
 * resetting the profile is the caller's. The artifact holds kinds, counts
 * and durations only.
 *
 *   mise exec -- bun scripts/busy-item-counts-live.ts --profile q48busy-candidate-1 \
 *     [--checkout /abs/older/worktree] [--label base] [--window-ms 180000] \
 *     [--out output/benchmarks/x.json]
 */

export type Options = {
  profile: string;
  checkout?: string;
  label?: string;
  windowMs: number;
  out: string;
};

export function parseOptions(argv: string[]): Options {
  const options: Partial<Options> = {
    windowMs: 180_000,
    out: `output/benchmarks/busy-item-counts-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
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
    } else if (name === "--window-ms") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1)
        throw new Error("--window-ms needs a positive integer");
      options.windowMs = parsed;
    } else if (name === "--out") options.out = value;
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.profile) throw new Error("--profile is required");
  return options as Options;
}

/** The environments the busy driver added, which this run may stop. */
export function busyEnvironments<T extends { name?: string; environmentType?: string }>(
  environments: readonly T[],
): T[] {
  return environments.filter(
    (environment) =>
      environment.environmentType === "local" && (environment.name ?? "").startsWith("busy-"),
  );
}

type Environment = { id: string; name?: string; environmentType?: string; status?: string };

const log = (message: string) => console.error(`[busy-item-counts-live] ${message}`);

export async function runItemCounts(
  options: Options,
  signal: AbortSignal,
  runtime: {
    gateway?: ReturnType<typeof gatewayFor>;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
  } = {},
): Promise<number> {
  const statusRun = runtime.gateway
    ? { stdout: '{"status":"ready"}' }
    : spawnSync("mise", ["run", "dev:status", "--profile", options.profile, "--json"], {
        encoding: "utf8",
        env: checkoutEnv(options.checkout),
        ...(options.checkout ? { cwd: options.checkout } : {}),
      });
  const status = JSON.parse(statusRun.stdout) as {
    status?: string;
    browserUrl?: string;
    authFile?: string;
  };
  if (status.status !== "ready") throw new Error("Profile is not ready");
  const gateway = runtime.gateway ?? gatewayFor(status, signal);
  const sleep = runtime.sleep ?? ((ms: number) => delay(ms, undefined, { signal }));
  const environments = async (): Promise<Environment[]> => {
    const all: Environment[] = [];
    for (const project of await gateway.invoke<Array<{ id: string }>>("get_projects"))
      all.push(
        ...(await gateway.invoke<Environment[]>("get_environments", { projectId: project.id })),
      );
    return all;
  };
  const publicAction = async (action: string, input: Record<string, unknown>, cleanup = false) => {
    const response = (await gateway.invoke(
      "public_action",
      {
        schemaVersion: 1,
        action,
        actionVersion: 1,
        input,
        request: { requestId: `q1202-${randomUUID()}` },
      },
      cleanup,
    )) as { ok?: unknown; error?: { code?: unknown } } | null;
    if (response?.ok !== true)
      throw new Error(`${action} refused: ${String(response?.error?.code ?? "unknown")}`);
  };
  const windows: Array<{
    name: string;
    elapsedMs: number;
    dockerExecPerMinute: number;
    kinds: Record<string, KindRate>;
  }> = [];
  const now = runtime.now ?? Date.now;
  const measure = async (name: string) => {
    log(`window ${name}: ${Math.round(options.windowMs / 1000)} s`);
    const before = await gateway.kinds();
    const startedAt = now();
    await sleep(options.windowMs);
    const after = await gateway.kinds();
    const elapsedMs = now() - startedAt;
    const kinds = windowRates(before, after, elapsedMs);
    windows.push({ name, elapsedMs, dockerExecPerMinute: dockerExecPerMinute(kinds), kinds });
  };
  const initial = await environments();
  const busy = busyEnvironments(initial);
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
    environments: initial.map((environment) => ({
      type: environment.environmentType ?? null,
      status: environment.status ?? null,
    })),
    windows,
  };
  const stopped: string[] = [];
  let exitCode = 0;
  try {
    if (busy.length === 0) throw new Error("No busy-* environments; run the busy driver first");
    await sleep(30_000);
    await measure("populated");
    for (const environment of busy) {
      if (environment.status !== "running") continue;
      await publicAction("environment.stop", { environmentId: environment.id });
      stopped.push(environment.id);
    }
    const deadline = Date.now() + 180_000;
    for (;;) {
      const current = (await environments()).filter((environment) =>
        stopped.includes(environment.id),
      );
      if (current.every((environment) => environment.status !== "running")) break;
      if (Date.now() > deadline) throw new Error("Stopped environments still report running");
      await sleep(1_000);
    }
    result.stoppedEnvironments = stopped.length;
    await sleep(30_000);
    await measure("stopped");
  } catch (error) {
    exitCode = 1;
    result.error = error instanceof Error ? error.message : "failed";
    log(`failed: ${String(result.error)}`);
  } finally {
    for (const environmentId of stopped)
      await publicAction("environment.start", { environmentId }, true).catch(() => {
        exitCode = 1;
        result.cleanupFailed = true;
        log("could not start an environment again; dev:reset removes it");
      });
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
    log(`wrote ${options.out}`);
    for (const window of windows) {
      const line = ["mail-presence", "mail-injection", "native-activity-sweep"]
        .map((kind) => {
          const rate = window.kinds[kind];
          return `${kind} ${rate?.started ?? 0} starts, ${rate?.units["storage-read"] ?? 0} reads, ${rate?.bytes ?? 0} B /min`;
        })
        .join("; ");
      log(`${window.name}: ${line}`);
    }
  }
  return exitCode;
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  process.exitCode = await withTerminationSignals((signal) => runItemCounts(options, signal));
}
