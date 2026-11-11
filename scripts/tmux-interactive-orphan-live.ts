import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  CLAUDE_TMUX_INTERACTIVE_LEASE_MS,
  CLAUDE_TMUX_INTERACTIVE_RENEW_MS,
} from "@orkestrator/protocol/contract/domains/claude-tmux";
import {
  collectWindow,
  containerEnvironment,
  docker,
  execCounter,
  installFakeModel,
  profileStatus,
  waitFor,
  windowRates,
  type KindRate,
  type TmuxStatus,
} from "./container-tmux-tab-live";
import { withTerminationSignals } from "./recurring-live-ab";
import { gatewayFor } from "./tmux-mail-inject-live";

/**
 * To-do 7745 task 2: the interactive terminal's capture loop (B19) left
 * behind by a client that vanished without detaching, before and after the
 * client lease, counted live in a container.
 *
 * It drives a running, credential-free `dev:test` profile started with
 * `--fixture --fixture-environments local,container --no-agent-credentials
 * --agent-platforms claude`, the container's `claude` answering from the
 * loopback fake model of `e2e/agent-testing/container-fake-claude-api.ts`, so
 * nothing is billed and no login is used. It opens one claude-tmux tab on the
 * container environment, then attaches interactive terminals through the
 * gateway exactly as the renderer does (create, then start) and never
 * detaches them, which is what a page reload, a closed window or a cut link
 * leaves behind. Each window counts Docker's own `exec_start` events for the
 * container and the backend's `tmux-interactive-capture` attempts with the
 * `docker exec` work units charged to them:
 *
 * 1. `tab-only`: the tab open, no interactive terminal.
 * 2. `unleased-orphan`: a terminal created without a lease, as every client
 *    before the lease did and an older client still does; the backend can
 *    only keep capturing it.
 * 3. `leased-renewed`: a leased terminal whose client renews it every
 *    {@link CLAUDE_TMUX_INTERACTIVE_RENEW_MS}, as a live renderer does.
 * 4. `leased-orphan`: a leased terminal nobody renews, measured once its
 *    lease ({@link CLAUDE_TMUX_INTERACTIVE_LEASE_MS}) and one capture tick
 *    have passed.
 *
 * Every terminal it creates is detached afterwards, the tab's tmux session is
 * stopped and the fake model undone; stopping and resetting the profile is
 * the caller's.
 *
 *   PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
 *     mise run dev:test --profile orphan --fixture --fixture-environments local,container \
 *     --no-agent-credentials --agent-platforms claude --headless
 *   mise exec -- bun scripts/tmux-interactive-orphan-live.ts --profile orphan \
 *     [--window-ms 120000] [--out output/benchmarks/x.json]
 *
 * The gateway token is read from the profile's mode-0600 auth file and only
 * sent as a loopback request header. The artifact holds counts, labels and
 * durations, never pane contents, prompts or tokens.
 */

export type Options = { profile: string; windowMs: number; out: string };

export function parseOptions(argv: string[]): Options {
  const options: Partial<Options> = {
    windowMs: 120_000,
    out: `output/benchmarks/tmux-interactive-orphan-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]!;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    if (name === "--profile") {
      if (!/^[a-z0-9-]+$/.test(value)) throw new Error("--profile takes a profile name");
      options.profile = value;
    } else if (name === "--window-ms") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 10_000)
        throw new Error("--window-ms needs an integer of at least 10000");
      options.windowMs = parsed;
    } else if (name === "--out") options.out = value;
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.profile) throw new Error("--profile is required");
  return options as Options;
}

export type OrphanWindow = {
  name: string;
  elapsedMs: number;
  /** Docker's `exec_start` events for the container, per minute, by content-free label. */
  execsPerMinute: Record<string, number>;
  /** Every exec Docker saw in the container, a minute. */
  totalExecsPerMinute: number;
  /** The backend's `tmux-interactive-capture` attempts a minute. */
  interactiveCapturesPerMinute: number;
  /** The `docker exec` work units those attempts were charged. */
  interactiveDockerExecPerMinute: number;
  /** Interactive terminals the window held, and whether each was leased. */
  terminals: Array<{ leased: boolean; renewed: boolean }>;
  note: string;
};

/** Scales a window's raw exec counts to a minute. */
export function perMinute(
  labels: Record<string, number>,
  elapsedMs: number,
): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const [label, count] of Object.entries(labels))
    rates[label] = Math.round((count * 60_000 * 100) / elapsedMs) / 100;
  return rates;
}

export function interactiveCaptures(kinds: Record<string, KindRate>): {
  started: number;
  dockerExec: number;
} {
  const kind = kinds["tmux-interactive-capture"];
  return { started: kind?.started ?? 0, dockerExec: kind?.units["docker-exec"] ?? 0 };
}

const log = (message: string) => console.error(`[tmux-interactive-orphan-live] ${message}`);

export async function runOrphanBenchmark(options: Options, signal: AbortSignal): Promise<number> {
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
  const tabId = `q7745-${randomUUID().slice(0, 8)}`;
  const windows: OrphanWindow[] = [];
  const created: string[] = [];
  const result: Record<string, unknown> = {
    profile: options.profile,
    commit: spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    platform: process.platform,
    arch: process.arch,
    model:
      "loopback fake inside the container (e2e/agent-testing/container-fake-claude-api.ts); no provider was called",
    leaseMs: CLAUDE_TMUX_INTERACTIVE_LEASE_MS,
    renewMs: CLAUDE_TMUX_INTERACTIVE_RENEW_MS,
    at: new Date().toISOString(),
    windows,
  };
  const sleep = (ms: number) => delay(ms, undefined, { signal });
  const tab = () =>
    gateway.invoke<TmuxStatus | null>("claude_tmux_status", {
      environmentId: environment.id,
      tabId,
    });
  const attach = async (leased: boolean) => {
    const id = await gateway.invoke<string>("claude_tmux_create_interactive_terminal", {
      environmentId: environment.id,
      tabId,
      cols: 120,
      rows: 40,
      ...(leased ? { leased: true } : {}),
    });
    created.push(id);
    await gateway.invoke("claude_tmux_start_interactive_terminal", { terminalSessionId: id });
    return id;
  };
  const renew = (id: string) =>
    gateway.invoke<{ renewed: boolean }>("claude_tmux_renew_interactive_terminal", {
      terminalSessionId: id,
    });
  const measure = async (
    name: string,
    terminals: OrphanWindow["terminals"],
    note: string,
    body: () => Promise<void> = () => sleep(options.windowMs),
  ) => {
    log(`window ${name}: ${Math.round(options.windowMs / 1000)} s`);
    const { before, after, elapsedMs, counted } = await collectWindow(
      () => execCounter(containerId),
      () => gateway.kinds(),
      body,
    );
    const kinds = windowRates(before!, after!, elapsedMs!);
    const interactive = interactiveCaptures(kinds);
    windows.push({
      name,
      elapsedMs: elapsedMs!,
      execsPerMinute: perMinute(counted.labels, elapsedMs!),
      totalExecsPerMinute: perMinute({ all: counted.total }, elapsedMs!).all ?? 0,
      interactiveCapturesPerMinute: interactive.started,
      interactiveDockerExecPerMinute: interactive.dockerExec,
      terminals,
      note,
    });
  };

  let undoFake: (() => void) | undefined;
  let launched = false;
  let exitCode = 0;
  try {
    undoFake = await installFakeModel(containerId, signal);
    log("opening a claude-tmux tab on the container environment");
    launched = true; // An interrupted launch may already have reached the backend.
    await gateway.invoke("launch_terminal_job", {
      environmentId: environment.id,
      requestId: `q7745-${tabId}`,
      tabId,
      tabType: "claude-tmux",
      title: "7745 orphan probe",
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
    await sleep(20_000);
    await measure("tab-only", [], "the claude-tmux tab open and idle, no interactive terminal");

    const unleased = await attach(false);
    await measure(
      "unleased-orphan",
      [{ leased: false, renewed: false }],
      "one terminal created without a lease and never detached: what a reload leaves on a backend without the lease, or from an older client",
    );
    await gateway.invoke("claude_tmux_detach_interactive_terminal", {
      terminalSessionId: unleased,
    });

    const renewed = await attach(true);
    let renewals = 0;
    let lapsedWhileRenewed = false;
    await measure(
      "leased-renewed",
      [{ leased: true, renewed: true }],
      `one leased terminal renewed every ${CLAUDE_TMUX_INTERACTIVE_RENEW_MS} ms, as a live client does`,
      async () => {
        const end = Date.now() + options.windowMs;
        while (Date.now() < end) {
          await sleep(Math.min(CLAUDE_TMUX_INTERACTIVE_RENEW_MS, end - Date.now()));
          if (!(await renew(renewed)).renewed) lapsedWhileRenewed = true;
          renewals += 1;
        }
      },
    );
    result.renewals = renewals;
    result.lapsedWhileRenewed = lapsedWhileRenewed;
    await gateway.invoke("claude_tmux_detach_interactive_terminal", {
      terminalSessionId: renewed,
    });

    const orphan = await attach(true);
    log("waiting out the lease of a terminal nobody renews");
    await sleep(CLAUDE_TMUX_INTERACTIVE_LEASE_MS + 5_000);
    await measure(
      "leased-orphan",
      [{ leased: true, renewed: false }],
      `one leased terminal never renewed, measured from ${CLAUDE_TMUX_INTERACTIVE_LEASE_MS + 5_000} ms after it was created`,
    );
    result.orphanRenewAfterLapse = (await renew(orphan)).renewed;
    if (lapsedWhileRenewed || result.orphanRenewAfterLapse !== false) exitCode = 1;
  } catch (error) {
    exitCode = 1;
    result.error = error instanceof Error ? error.message : "failed";
    log(`failed: ${String(result.error)}`);
  } finally {
    const cleanupFailures: string[] = [];
    for (const id of created)
      await gateway
        .invoke("claude_tmux_detach_interactive_terminal", { terminalSessionId: id }, true)
        .catch(() => cleanupFailures.push("terminal-detach"));
    if (launched)
      await gateway
        .invoke("claude_tmux_stop", { environmentId: environment.id, tabId }, true)
        .catch(() => cleanupFailures.push("tab-stop"));
    try {
      undoFake?.();
    } catch {
      cleanupFailures.push("fake-model-restore");
    }
    if (cleanupFailures.length) {
      exitCode = 1;
      result.cleanupFailures = cleanupFailures;
    }
    result.image = (() => {
      try {
        return docker(["inspect", "--format", "{{.Config.Image}}", containerId]);
      } catch {
        return null;
      }
    })();
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
    log(`wrote ${options.out}`);
    for (const window of windows)
      log(
        `${window.name}: container execs ${window.totalExecsPerMinute}/min; tmux-interactive-capture ${window.interactiveCapturesPerMinute}/min (docker exec ${window.interactiveDockerExecPerMinute}/min); by label ${JSON.stringify(window.execsPerMinute)}`,
      );
  }
  return exitCode;
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  process.exitCode = await withTerminationSignals((signal) => runOrphanBenchmark(options, signal));
}
