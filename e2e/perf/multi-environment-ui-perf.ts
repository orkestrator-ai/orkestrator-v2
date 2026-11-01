/**
 * UI response while several container environments are busy (real stack,
 * real browser, not part of any suite).
 *
 *   # 1. In its own long-lived terminal (stays attached):
 *   mise run dev:test --profile ui-load --fixture-environments container \
 *     --no-agent-credentials --agent-platforms claude
 *   # 2. Once `mise run dev:status --profile ui-load --json` says ready:
 *   mise exec -- bun e2e/perf/multi-environment-ui-perf.ts --profile ui-load \
 *     [--environments 3] [--workers 2] [--memory-mib 0] [--phases idle,busy,idle] \
 *     [--switches 20] [--status-cycles 3] [--watch-seconds 20] [--settle-seconds 10] \
 *     [--headed] [--out <file.json>]
 *   # 3. Afterwards:
 *   mise run dev:stop --profile ui-load && mise run dev:reset --profile ui-load
 *
 * The probe adds `--environments` container environments (`ui-load-busy-N`)
 * and one more (`ui-load-target`) to the profile's fixture project, starts
 * them, and signs a headless Chromium into the profile with `dev:login`. No
 * agent session is created and no provider is called. Then, per phase:
 *
 * - `busy` phases start a load in every `ui-load-busy-N` container through
 *   `docker exec` (only after checking the container's `environment-id` label):
 *   `--workers` shell spin loops (one CPU each), a file in the workspace
 *   rewritten every second (so Git status changes), and optionally a
 *   `--memory-mib` allocation held by Node. Containers keep the budget the
 *   backend gave them (the built-in default unless the profile set one).
 *   `idle` phases run with the same environments up but no load.
 * - watch: for `--watch-seconds`, animation-frame intervals, long tasks,
 *   timer lag (a 250 ms `setTimeout`) and the round trip of `get_environments`
 *   from the page, one every 100 ms.
 * - switch: `--switches` clicks on environment rows in the sidebar, round
 *   robin over the probe's environments. Each records the time from
 *   `pointerdown` to the first animation frame in which the row is selected,
 *   and to the last change under `<main>` before 300 ms of quiet (`settled`).
 * - status: `--status-cycles` stops and starts of `ui-load-target` sent from
 *   the page (not the UI). Each records the command's round trip and the time
 *   until the sidebar marker shows the new state.
 *
 * Every environment is visited once before the first phase so phases compare
 * warm switches; the cold visits are reported separately. Host load is
 * recorded per phase: load average, host CPU busy from `/proc/stat` (Linux),
 * the probe containers' `docker stats` CPU, and the count of other running
 * containers. Other work on the host changes every number here, so a report
 * is a sample of that host at that time, not a reference figure.
 *
 * Output is numbers only (no tokens, paths, prompts or file contents). A JSON
 * report is written to output/benchmarks/multi-environment-ui/<run-id>.json.
 * The probe deletes the environments it created, also on failure; `dev:reset`
 * removes anything an interrupted run left behind.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import {
  cpuBusyPercent,
  distribution,
  frameSummary,
  longTaskSummary,
  medianRatio,
  parseCpuPercent,
  parseProcStat,
  type CpuCounters,
  type Distribution,
} from "./multi-environment-ui-stats";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const ENVIRONMENT_PREFIX = "ui-load-";
const TARGET_NAME = `${ENVIRONMENT_PREFIX}target`;
const STOP_FILE = "/tmp/orkestrator-ui-load.stop";
const CHURN_FILE = "ui-load-churn.txt";
/** How long `<main>` must stay unchanged before a switch counts as settled. */
const QUIET_MS = 300;
const SWITCH_DEADLINE_MS = 15_000;
const STATUS_DEADLINE_MS = 120_000;
const TIMER_INTERVAL_MS = 250;
/** One `get_environments` round trip per slot, so the probe adds little load of its own. */
const INVOKE_INTERVAL_MS = 100;
/** User think time between two measured switches, so settle windows never overlap. */
const SWITCH_PAUSE_MS = 500;

type Phase = "idle" | "busy";

interface Options {
  profile: string;
  environments: number;
  workers: number;
  memoryMiB: number;
  phases: Phase[];
  switches: number;
  statusCycles: number;
  watchSeconds: number;
  settleSeconds: number;
  headed: boolean;
  out: string | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    profile: process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "",
    environments: 3,
    workers: 2,
    memoryMiB: 0,
    phases: ["idle", "busy", "idle"],
    switches: 20,
    statusCycles: 3,
    watchSeconds: 20,
    settleSeconds: 10,
    headed: false,
    out: null,
  };
  const count = (arg: string, value: string, minimum: number) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
      throw new Error(`${arg} expects an integer of at least ${minimum}`);
    }
    return parsed;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--profile") options.profile = value();
    else if (arg === "--environments") options.environments = count(arg, value(), 1);
    else if (arg === "--workers") options.workers = count(arg, value(), 0);
    else if (arg === "--memory-mib") options.memoryMiB = count(arg, value(), 0);
    else if (arg === "--switches") options.switches = count(arg, value(), 1);
    else if (arg === "--status-cycles") options.statusCycles = count(arg, value(), 0);
    else if (arg === "--watch-seconds") options.watchSeconds = count(arg, value(), 1);
    else if (arg === "--settle-seconds") options.settleSeconds = count(arg, value(), 0);
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--out") options.out = value();
    else if (arg === "--phases") {
      options.phases = value()
        .split(",")
        .filter(Boolean)
        .map((phase) => {
          if (phase !== "idle" && phase !== "busy") throw new Error("--phases expects idle,busy");
          return phase;
        });
      if (options.phases.length === 0) throw new Error("--phases needs at least one phase");
    } else if (arg === "--") continue;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.profile) {
    throw new Error(
      "Pass --profile (or ORKESTRATOR_AGENT_TEST_PROFILE): a running dev:test profile",
    );
  }
  return options;
}

// ---------------------------------------------------------------------------
// Profile, gateway and Docker access.

interface ProfileStatus {
  status: string;
  browserUrl: string;
  testProject?: string;
}

interface Environment {
  id: string;
  name: string;
  status?: string;
  containerId?: string | null;
}

function profileCommand<T>(profile: string, command: string): T {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.slice(-500)}`);
  return JSON.parse(result.stdout) as T;
}

function docker(args: string[], timeoutMs = 60_000): { ok: boolean; stdout: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

/** The container only if its `environment-id` label names this environment. */
function ownedContainer(environment: Environment): string {
  const containerId = environment.containerId;
  if (!containerId) throw new Error(`${environment.name} has no container`);
  const inspected = docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "environment-id"}}',
    containerId,
  ]);
  if (!inspected.ok || inspected.stdout.trim() !== environment.id) {
    throw new Error(`${environment.name}'s container is not labelled for it; refusing to touch it`);
  }
  return containerId;
}

function loadScript(workers: number, memoryMiB: number): string {
  const spinners = Array.from(
    { length: workers },
    () => `(while [ ! -e ${STOP_FILE} ]; do :; done) &`,
  ).join("\n");
  const memory =
    memoryMiB > 0
      ? `node -e 'const held = Buffer.alloc(${memoryMiB} * 1048576, 1); const fs = require("fs"); setInterval(() => { if (fs.existsSync("${STOP_FILE}")) process.exit(held.length > 0 ? 0 : 1); }, 500);' &`
      : "";
  return [
    spinners,
    memory,
    `(n=0; while [ ! -e ${STOP_FILE} ]; do n=$((n+1)); echo "$n" > ${CHURN_FILE}; sleep 1; done; rm -f ${CHURN_FILE}) &`,
    "wait",
  ]
    .filter(Boolean)
    .join("\n");
}

function startLoad(containerId: string, options: Options): void {
  docker(["exec", containerId, "rm", "-f", STOP_FILE]);
  const started = docker([
    "exec",
    "-d",
    "-u",
    "node",
    "-w",
    "/workspace",
    containerId,
    "sh",
    "-c",
    loadScript(options.workers, options.memoryMiB),
  ]);
  if (!started.ok) throw new Error("Could not start the load in a probe container");
}

function stopLoad(containerId: string): void {
  docker(["exec", containerId, "touch", STOP_FILE]);
}

/** `docker stats` CPU for the probe's own containers only. */
function containerCpu(containerIds: string[]): Array<number | null> {
  if (containerIds.length === 0) return [];
  const stats = docker(
    ["stats", "--no-stream", "--format", "{{.ID}}\t{{.CPUPerc}}", ...containerIds],
    30_000,
  );
  if (!stats.ok) return containerIds.map(() => null);
  const byId = new Map(
    stats.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id = "", cpu = ""] = line.split("\t");
        return [id, parseCpuPercent(cpu)] as const;
      }),
  );
  return containerIds.map(
    (containerId) => [...byId.entries()].find(([id]) => containerId.startsWith(id))?.[1] ?? null,
  );
}

function readCpuCounters(): CpuCounters | null {
  try {
    return parseProcStat(readFileSync("/proc/stat", "utf8"));
  } catch {
    return null;
  }
}

function runningContainerCount(): number | null {
  const listed = docker(["ps", "-q"]);
  return listed.ok ? listed.stdout.split("\n").filter(Boolean).length : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// In-page measurement. Each function runs in the page (Playwright serialises
// it), so it must not reference anything outside its body.

const PAGE_PROBE = `(() => {
  const probe = { longTasks: [], slowEvents: [] };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.slowEvents.push([entry.startTime, entry.duration]);
    }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch {}
  window.__uiLoadProbe = probe;
})();`;

interface WatchResult {
  frames: number[];
  invokeMs: Array<number | null>;
  timerLagMs: number[];
  longTasks: number[];
  slowEvents: number[];
}

async function watchWindow(
  page: Page,
  durationMs: number,
  projectId: string,
): Promise<WatchResult> {
  return page.evaluate(
    async ({ durationMs, projectId, timerIntervalMs, invokeIntervalMs }) => {
      const probe = (
        window as unknown as {
          __uiLoadProbe: { longTasks: number[][]; slowEvents: number[][] };
        }
      ).__uiLoadProbe;
      const start = performance.now();
      const frames: number[] = [];
      let running = true;
      const frame = (time: number) => {
        frames.push(time);
        if (running) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);

      const timerLagMs: number[] = [];
      const timers = (async () => {
        while (performance.now() - start < durationMs) {
          const scheduled = performance.now();
          await new Promise((resolve) => setTimeout(resolve, timerIntervalMs));
          timerLagMs.push(performance.now() - scheduled - timerIntervalMs);
        }
      })();
      const invokeMs: Array<number | null> = [];
      const invokes = (async () => {
        while (performance.now() - start < durationMs) {
          const sent = performance.now();
          try {
            const response = await fetch("/__orkestrator/invoke", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ command: "get_environments", args: { projectId } }),
            });
            await response.text();
            invokeMs.push(response.ok ? performance.now() - sent : null);
          } catch {
            invokeMs.push(null);
          }
          const wait = invokeIntervalMs - (performance.now() - sent);
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        }
      })();
      await Promise.all([timers, invokes]);
      running = false;
      const end = performance.now();
      const within = (entries: number[][]) =>
        entries.filter(([at]) => at! >= start && at! <= end).map(([, duration]) => duration!);
      return {
        frames,
        invokeMs,
        timerLagMs,
        longTasks: within(probe.longTasks),
        slowEvents: within(probe.slowEvents),
      };
    },
    {
      durationMs,
      projectId,
      timerIntervalMs: TIMER_INTERVAL_MS,
      invokeIntervalMs: INVOKE_INTERVAL_MS,
    },
  );
}

/** Arms the watcher for one switch; the click itself is a real Playwright click. */
async function armSwitch(page: Page, name: string): Promise<void> {
  await page.evaluate(
    ({ name, quietMs, deadlineMs }) => {
      const row = () => {
        for (const label of Array.from(document.querySelectorAll("span[id]"))) {
          if (label.textContent === name) return label.closest('[role="button"]');
        }
        return null;
      };
      const state: {
        pointerAt: number | null;
        selectedAt: number | null;
        lastMutationAt: number | null;
      } = { pointerAt: null, selectedAt: null, lastMutationAt: null };
      const target = window as unknown as { __uiLoadSwitch?: Promise<unknown> };
      target.__uiLoadSwitch = new Promise((resolve) => {
        const onPointer = (event: Event) => {
          if (state.pointerAt === null) state.pointerAt = event.timeStamp;
        };
        document.addEventListener("pointerdown", onPointer, { capture: true });
        const observer = new MutationObserver(() => {
          if (state.pointerAt !== null) state.lastMutationAt = performance.now();
        });
        const main = document.querySelector("main");
        if (main) {
          observer.observe(main, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        }
        const armedAt = performance.now();
        const finish = (timedOut: boolean) => {
          observer.disconnect();
          document.removeEventListener("pointerdown", onPointer, { capture: true });
          const pointerAt = state.pointerAt;
          const since = (at: number | null) =>
            pointerAt === null || at === null ? null : at - pointerAt;
          resolve({
            selectMs: since(state.selectedAt),
            settledMs: timedOut
              ? null
              : since(Math.max(state.lastMutationAt ?? 0, state.selectedAt ?? 0)),
          });
        };
        const tick = (now: number) => {
          if (
            state.pointerAt !== null &&
            state.selectedAt === null &&
            row()?.classList.contains("text-foreground")
          ) {
            state.selectedAt = now;
          }
          if (state.selectedAt !== null) {
            const quietSince = Math.max(state.lastMutationAt ?? 0, state.selectedAt);
            if (performance.now() - quietSince >= quietMs) return finish(false);
          }
          if (performance.now() - armedAt > deadlineMs) return finish(true);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    { name, quietMs: QUIET_MS, deadlineMs: SWITCH_DEADLINE_MS },
  );
}

interface SwitchResult {
  selectMs: number | null;
  settledMs: number | null;
}

async function measureSwitch(page: Page, name: string): Promise<SwitchResult> {
  await armSwitch(page, name);
  await page.getByText(name, { exact: true }).first().click();
  const result = await page.evaluate(
    () => (window as unknown as { __uiLoadSwitch: Promise<SwitchResult> }).__uiLoadSwitch,
  );
  // A row's hover tooltip would otherwise cover its neighbour for the next click.
  await page.mouse.move(1000, 450);
  return result;
}

interface StatusResult {
  ok: boolean;
  invokeMs: number;
  visibleMs: number | null;
}

/** Sends a lifecycle command from the page and waits for the sidebar to show its result. */
async function measureStatus(
  page: Page,
  environment: Environment,
  command: "stop_environment" | "start_environment",
): Promise<StatusResult> {
  return page.evaluate(
    async ({ environmentId, name, command, deadlineMs }) => {
      const marker = () => {
        for (const label of Array.from(document.querySelectorAll("span[id]"))) {
          if (label.textContent !== name) continue;
          const found = label
            .closest('[role="button"]')
            ?.querySelector('[data-testid="environment-status-marker"]');
          if (found) return found.getAttribute("data-state");
        }
        return null;
      };
      const reached = () => {
        const state = marker();
        return command === "stop_environment"
          ? state === "inactive"
          : state !== null && state !== "inactive";
      };
      const sent = performance.now();
      let visibleAt: number | null = null;
      const visible = new Promise<void>((resolve) => {
        const tick = (now: number) => {
          if (reached()) {
            visibleAt = now;
            resolve();
          } else if (performance.now() - sent > deadlineMs) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const response = await fetch("/__orkestrator/invoke", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, args: { environmentId } }),
      });
      await response.text();
      const invokeMs = performance.now() - sent;
      await visible;
      return {
        ok: response.ok,
        invokeMs,
        visibleMs: visibleAt === null ? null : Math.max(0, visibleAt - sent),
      };
    },
    {
      environmentId: environment.id,
      name: environment.name,
      command,
      deadlineMs: STATUS_DEADLINE_MS,
    },
  );
}

// ---------------------------------------------------------------------------
// The run.

interface HostSample {
  loadAverage: [number, number, number];
  cpuCounters: CpuCounters | null;
  runningContainers: number | null;
}

function hostSample(): HostSample {
  const [one = 0, five = 0, fifteen = 0] = os.loadavg();
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    loadAverage: [round(one), round(five), round(fifteen)],
    cpuCounters: readCpuCounters(),
    runningContainers: runningContainerCount(),
  };
}

interface PhaseReport {
  phase: Phase;
  index: number;
  host: {
    loadAverageStart: [number, number, number];
    loadAverageEnd: [number, number, number];
    hostCpuBusyPercent: number | null;
    runningContainers: number | null;
    probeContainerCpuPercent: Array<number | null>;
  };
  watch: {
    seconds: number;
    frames: ReturnType<typeof frameSummary>;
    longTasks: ReturnType<typeof longTaskSummary>;
    slowEvents: ReturnType<typeof longTaskSummary>;
    timerLagMs: Distribution;
    invokeMs: Distribution;
  };
  switch: { selectMs: Distribution; settledMs: Distribution };
  status: {
    stopInvokeMs: Distribution;
    stopVisibleMs: Distribution;
    startInvokeMs: Distribution;
    startVisibleMs: Distribution;
    /** Seen minus the command's round trip: how far the sidebar trails the reply (negative: ahead). */
    stopLagMs: Distribution;
    startLagMs: Distribution;
    failures: number;
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const status = profileCommand<ProfileStatus>(options.profile, "dev:status");
  if (status.status !== "ready") {
    throw new Error(`Profile ${options.profile} is ${status.status}, not ready`);
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outPath =
    options.out ??
    path.join(repositoryRoot, "output", "benchmarks", "multi-environment-ui", `${runId}.json`);

  const browser = await chromium.launch({ headless: !options.headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  const created: Environment[] = [];
  const loaded: string[] = [];
  let rendererReloads = 0;
  const dismissedDialogs: string[] = [];
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await context.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args }, timeout: 10 * 60_000 },
    );
    if (!response.ok()) throw new Error(`${command} failed with HTTP ${response.status()}`);
    return ((await response.json()) as { result: T }).result;
  };

  try {
    // The one-shot login URL stays in memory and never reaches output.
    const { loginUrl } = profileCommand<{ loginUrl?: unknown }>(options.profile, "dev:login");
    if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
    // Startup dialogs can open over the workspace: "Claude Code Is Not Logged
    // In" in a credential-free profile, or "Docker containers can't reach
    // Orkestrator" behind a host firewall (which this probe never changes; no
    // agent runs). Each is dismissed for this page only, by its "Continue
    // Without" button or Escape, and its title is reported.
    const startupDialog = page
      .locator('[role="dialog"]:visible, [role="alertdialog"]:visible')
      .first();
    const continueWithout = page.getByRole("button", { name: /^Continue Without / }).first();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    const projectToggle = page.getByRole("button", { name: /^(Expand|Collapse) project / }).first();
    // The dev server's transient "Failed to fetch dynamically imported module"
    // on the renderer entry (flake 0167) shows this page; it is reloaded, at
    // most twice, and the report counts the reloads.
    const couldNotConnect = page.getByText("Orkestrator couldn’t connect");
    const shellDeadline = Date.now() + 90_000;
    while (!(await projectToggle.isVisible())) {
      if (Date.now() > shellDeadline) {
        throw new Error(
          `The app shell never showed the project (dialogs dismissed: ${dismissedDialogs.join(", ") || "none"})`,
        );
      }
      if (await startupDialog.isVisible()) {
        const title = await startupDialog
          .evaluate((dialog) => {
            const labelledBy = dialog.getAttribute("aria-labelledby");
            const label = labelledBy ? document.getElementById(labelledBy) : null;
            return (label ?? dialog.querySelector("h1, h2, h3"))?.textContent ?? null;
          })
          .catch(() => null);
        dismissedDialogs.push((title ?? "untitled").slice(0, 80));
        if (await continueWithout.isVisible()) await continueWithout.click();
        else await page.keyboard.press("Escape");
        await startupDialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
      } else if (await couldNotConnect.isVisible()) {
        if (rendererReloads >= 2) throw new Error("The renderer failed to start three times");
        rendererReloads += 1;
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      await sleep(250);
    }

    const projects = await invoke<Array<{ id: string; localPath?: string }>>("get_projects");
    const project =
      projects.find((entry) => entry.localPath === status.testProject) ??
      (projects.length === 1 ? projects[0] : undefined);
    if (!project) throw new Error("Could not find the profile's fixture project");

    // An interrupted earlier run can leave probe environments behind.
    for (const stale of await invoke<Environment[]>("get_environments", {
      projectId: project.id,
    })) {
      if (stale.name.startsWith(ENVIRONMENT_PREFIX)) {
        await invoke("delete_environment", { environmentId: stale.id });
      }
    }
    const names = [
      ...Array.from(
        { length: options.environments },
        (_, i) => `${ENVIRONMENT_PREFIX}busy-${i + 1}`,
      ),
      TARGET_NAME,
    ];
    for (const name of names) {
      console.log(`creating ${name}`);
      const environment = await invoke<Environment>("create_environment", {
        projectId: project.id,
        name,
        networkAccessMode: "restricted",
        environmentType: "containerized",
      });
      created.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
    }
    const environments = await Promise.all(
      created.map((environment) =>
        invoke<Environment>("get_environment", { environmentId: environment.id }),
      ),
    );
    const busy = environments.filter((environment) => environment.name !== TARGET_NAME);
    const target = environments.find((environment) => environment.name === TARGET_NAME)!;
    const busyContainers = busy.map(ownedContainer);
    ownedContainer(target);
    const appliedLimits = docker([
      "inspect",
      "--format",
      "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}",
      busyContainers[0]!,
    ]).stdout.trim();

    const expand = page.getByRole("button", { name: /^Expand project / }).first();
    if (await expand.isVisible()) await expand.click();
    for (const environment of environments) {
      await page.getByText(environment.name, { exact: true }).first().waitFor({ timeout: 60_000 });
    }

    // Cold visits: each environment's first mount, reported separately.
    const coldSelect: Array<number | null> = [];
    const coldSettled: Array<number | null> = [];
    for (const environment of environments) {
      const result = await measureSwitch(page, environment.name);
      coldSelect.push(result.selectMs);
      coldSettled.push(result.settledMs);
      await sleep(SWITCH_PAUSE_MS);
    }

    const phases: PhaseReport[] = [];
    for (const [index, phase] of options.phases.entries()) {
      console.log(`phase ${index + 1}/${options.phases.length}: ${phase}`);
      if (phase === "busy") {
        for (const containerId of busyContainers) {
          startLoad(containerId, options);
          loaded.push(containerId);
        }
      }
      await sleep(options.settleSeconds * 1000);
      const start = hostSample();
      const probeContainerCpuPercent = containerCpu(busyContainers);

      const watch = await watchWindow(page, options.watchSeconds * 1000, project.id);

      const selectMs: Array<number | null> = [];
      const settledMs: Array<number | null> = [];
      for (let round = 0; round < options.switches; round += 1) {
        const result = await measureSwitch(page, environments[round % environments.length]!.name);
        selectMs.push(result.selectMs);
        settledMs.push(result.settledMs);
        await sleep(SWITCH_PAUSE_MS);
      }

      const statusSamples = {
        stopInvokeMs: [] as Array<number | null>,
        stopVisibleMs: [] as Array<number | null>,
        startInvokeMs: [] as Array<number | null>,
        startVisibleMs: [] as Array<number | null>,
        stopLagMs: [] as Array<number | null>,
        startLagMs: [] as Array<number | null>,
        failures: 0,
      };
      const lag = (result: StatusResult) =>
        result.ok && result.visibleMs !== null ? result.visibleMs - result.invokeMs : null;
      for (let cycle = 0; cycle < options.statusCycles; cycle += 1) {
        const stopped = await measureStatus(page, target, "stop_environment");
        statusSamples.stopInvokeMs.push(stopped.ok ? stopped.invokeMs : null);
        statusSamples.stopVisibleMs.push(stopped.visibleMs);
        const started = await measureStatus(page, target, "start_environment");
        statusSamples.startInvokeMs.push(started.ok ? started.invokeMs : null);
        statusSamples.startVisibleMs.push(started.visibleMs);
        statusSamples.stopLagMs.push(lag(stopped));
        statusSamples.startLagMs.push(lag(started));
        if (!stopped.ok || !started.ok) statusSamples.failures += 1;
        await sleep(SWITCH_PAUSE_MS);
      }
      const end = hostSample();

      if (phase === "busy") {
        for (const containerId of loaded.splice(0)) stopLoad(containerId);
      }
      phases.push({
        phase,
        index,
        host: {
          loadAverageStart: start.loadAverage,
          loadAverageEnd: end.loadAverage,
          hostCpuBusyPercent: cpuBusyPercent(start.cpuCounters, end.cpuCounters),
          runningContainers: start.runningContainers,
          probeContainerCpuPercent,
        },
        watch: {
          seconds: options.watchSeconds,
          frames: frameSummary(watch.frames),
          longTasks: longTaskSummary(watch.longTasks),
          slowEvents: longTaskSummary(watch.slowEvents),
          timerLagMs: distribution(watch.timerLagMs),
          invokeMs: distribution(watch.invokeMs),
        },
        switch: { selectMs: distribution(selectMs), settledMs: distribution(settledMs) },
        status: {
          stopInvokeMs: distribution(statusSamples.stopInvokeMs),
          stopVisibleMs: distribution(statusSamples.stopVisibleMs),
          startInvokeMs: distribution(statusSamples.startInvokeMs),
          startVisibleMs: distribution(statusSamples.startVisibleMs),
          stopLagMs: distribution(statusSamples.stopLagMs),
          startLagMs: distribution(statusSamples.startLagMs),
          failures: statusSamples.failures,
        },
      });
    }

    const firstOf = (phase: Phase) => phases.find((entry) => entry.phase === phase);
    const idle = firstOf("idle");
    const loadedPhase = firstOf("busy");
    const ratios =
      idle && loadedPhase
        ? {
            selectMs: medianRatio(loadedPhase.switch.selectMs, idle.switch.selectMs),
            settledMs: medianRatio(loadedPhase.switch.settledMs, idle.switch.settledMs),
            invokeMs: medianRatio(loadedPhase.watch.invokeMs, idle.watch.invokeMs),
            frameIntervalP95: medianRatio(
              {
                ...loadedPhase.watch.frames.interval,
                median: loadedPhase.watch.frames.interval.p95,
              },
              { ...idle.watch.frames.interval, median: idle.watch.frames.interval.p95 },
            ),
            stopInvokeMs: medianRatio(loadedPhase.status.stopInvokeMs, idle.status.stopInvokeMs),
            startInvokeMs: medianRatio(loadedPhase.status.startInvokeMs, idle.status.startInvokeMs),
          }
        : null;

    const gitHead = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).stdout.trim();
    const report = {
      runId,
      commit: gitHead || null,
      note: "a sample of this host at this time, not a reference figure",
      host: {
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
        dockerServer: docker(["version", "--format", "{{.Server.Version}}"]).stdout.trim() || null,
      },
      options: { ...options, out: undefined, profile: undefined },
      rendererReloads,
      dismissedDialogs,
      probeContainers: {
        count: busy.length,
        target: 1,
        appliedLimits: appliedLimits || null,
      },
      coldVisit: { selectMs: distribution(coldSelect), settledMs: distribution(coldSettled) },
      phases,
      busyAgainstIdleMedianRatio: ratios,
    };
    if (!existsSync(path.dirname(outPath))) mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    printSummary(report.coldVisit, phases, ratios);
    console.log(`report: ${path.relative(repositoryRoot, outPath)}`);
  } finally {
    for (const containerId of loaded) stopLoad(containerId);
    for (const environment of created) {
      await invoke("delete_environment", { environmentId: environment.id }).catch((error) =>
        console.error(`could not delete ${environment.name}: ${String(error).slice(0, 200)}`),
      );
    }
    await browser.close();
  }
}

function printSummary(
  coldVisit: { selectMs: Distribution; settledMs: Distribution },
  phases: PhaseReport[],
  ratios: Record<string, number | null> | null,
): void {
  const cell = (summary: Distribution) =>
    summary.count === 0
      ? `missed ${summary.missed}`
      : `${summary.median} / ${summary.p95}${summary.missed ? ` (${summary.missed} missed)` : ""}`;
  console.log(
    `cold visit: select ${cell(coldVisit.selectMs)}, settled ${cell(coldVisit.settledMs)} ms`,
  );
  console.log(
    "phase | load avg | host CPU | probe CPU | select | settled | invoke | frame p95/max | long tasks | stop | start | stop lag | start lag  (median / p95, ms)",
  );
  for (const phase of phases) {
    const probeCpu = phase.host.probeContainerCpuPercent
      .map((value) => (value === null ? "?" : `${Math.round(value)}%`))
      .join(",");
    console.log(
      [
        `${phase.index + 1} ${phase.phase}`,
        phase.host.loadAverageStart[0],
        `${phase.host.hostCpuBusyPercent ?? "?"}%`,
        probeCpu,
        cell(phase.switch.selectMs),
        cell(phase.switch.settledMs),
        cell(phase.watch.invokeMs),
        `${phase.watch.frames.interval.p95} / ${phase.watch.frames.interval.max}`,
        `${phase.watch.longTasks.count} (${phase.watch.longTasks.totalMs} ms)`,
        cell(phase.status.stopInvokeMs),
        cell(phase.status.startInvokeMs),
        cell(phase.status.stopLagMs),
        cell(phase.status.startLagMs),
      ].join(" | "),
    );
  }
  if (ratios) console.log(`busy / idle medians: ${JSON.stringify(ratios)}`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
