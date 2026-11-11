/**
 * Pure helpers for the live Multi Review scale case
 * (`multi-review-live.spec.ts`, `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE`):
 * which platforms the panel uses, how reviewers are spread over them, which
 * model each platform runs, and how much memory the profile backend's whole
 * process tree holds (the backend plus the bridges and agent CLIs it started).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { piProviderConfig, profilePiAgentDirectory } from "../../scripts/pi-fake-model-shared";

/** Platforms the scale panel uses when none are named. */
export const DEFAULT_SCALE_PLATFORMS: readonly AgentPlatform[] = ["claude", "codex"];

/** Picker label prefixes used when a platform's model variable is unset. */
export const DEFAULT_SCALE_MODEL_LABELS: Partial<Record<AgentPlatform, string>> = {
  claude: "Haiku 4.5",
  codex: "GPT-6-Luna",
};

/**
 * Reads `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE_PLATFORMS` (comma
 * separated). Throws on an unknown or repeated platform, so a typo cannot
 * shrink the panel silently.
 */
export function parseScalePlatforms(
  value: string | undefined,
  fallback: readonly AgentPlatform[] = DEFAULT_SCALE_PLATFORMS,
): AgentPlatform[] {
  const trimmed = value?.trim();
  if (!trimmed) return [...fallback];
  const platforms = trimmed.split(",").map((entry) => entry.trim());
  for (const platform of platforms) {
    if (!(AGENT_PLATFORMS as readonly string[]).includes(platform)) {
      throw new Error(
        `Unknown scale platform ${JSON.stringify(platform)}; use ${AGENT_PLATFORMS.join(", ")}`,
      );
    }
  }
  if (new Set(platforms).size !== platforms.length) {
    throw new Error("Each scale platform may be named once");
  }
  return platforms as AgentPlatform[];
}

/** The environment variable naming one platform's model picker label. */
export function scaleModelVariable(platform: AgentPlatform): string {
  return `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_${platform.toUpperCase()}_MODEL`;
}

/** Reviewer `index`'s platform: round-robin in the configured order. */
export function scalePanelPlatforms(
  platforms: readonly AgentPlatform[],
  size: number,
): AgentPlatform[] {
  if (platforms.length === 0) throw new Error("The scale panel needs at least one platform");
  return Array.from({ length: size }, (_, index) => platforms[index % platforms.length]!);
}

export interface CatalogModel {
  id: string;
  platform: string;
  label: string;
}

/**
 * The model a platform's reviewers run: the first catalogue entry whose label
 * starts with `label`, or, with no label, the platform's first catalogue
 * entry. Undefined when the catalogue has no match.
 */
export function pickScaleModel(
  catalog: readonly CatalogModel[],
  platform: AgentPlatform,
  label: string | undefined,
): CatalogModel | undefined {
  return catalog.find(
    (entry) =>
      entry.platform === platform && (label === undefined || entry.label.startsWith(label)),
  );
}

/**
 * Sums the resident set (KiB) of `rootPid` and every descendant from
 * `ps -A -o pid=,ppid=,rss=` output. Unparseable lines are skipped; a root
 * that is not listed sums to zero.
 */
export function processTreeRssKiB(rootPid: number, psOutput: string): number {
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid, kib] = line.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isFinite(kib)) {
      continue;
    }
    rss.set(pid!, kib!);
    const siblings = children.get(ppid!) ?? [];
    siblings.push(pid!);
    children.set(ppid!, siblings);
  }
  let total = 0;
  const seen = new Set<number>();
  const pending = rss.has(rootPid) ? [rootPid] : [];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    pending.push(...(children.get(pid) ?? []));
  }
  return total;
}

/** Reads one sample of the process table; read-only, signals nothing. */
export function sampleProcessTable(): string {
  return spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }).stdout ?? "";
}

/** Backend-only and whole-tree resident memory, in MiB. */
export function profileRssMiB(backendPid: number): { backend: number; tree: number } {
  const table = sampleProcessTable();
  const backendLine = table
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .find(([pid]) => pid === backendPid);
  return {
    backend: (backendLine?.[2] ?? 0) / 1024,
    tree: processTreeRssKiB(backendPid, table) / 1024,
  };
}

/**
 * The agent-test fan-out stats fixture (`FANOUT_STATS_FIXTURE_DIR`,
 * `FANOUT_STATS_MARKER` and `FANOUT_STATS_FILE` in
 * `apps/backend/src/core/agent-test-fanout-stats.ts`), relative to the
 * profile's data directory. Copied rather than imported so the spec does not
 * load backend modules; the support test pins them equal.
 */
export const FANOUT_STATS_DIR = "agent-test-fixtures/fanout-stats";
export const FANOUT_STATS_MARKER_NAME = "record";
export const FANOUT_STATS_FILE_NAME = "fanout-stats.json";

/** What the backend's recorder writes; counts and platform names only. */
export interface FanoutStats {
  runId: string;
  passes: number;
  maxAdmission: number;
  maxByPlatform: Partial<Record<AgentPlatform, number>>;
}

/**
 * The fan-out caps a profile runs with: `DEFAULT_REVIEW_ADMISSION_CONCURRENCY`
 * and `DEFAULT_REVIEW_PROVIDER_CONCURRENCY` in
 * `apps/backend/src/core/review-fanout-scheduler.ts`. Copied for the same
 * reason as the fixture paths; the support test pins them equal.
 */
export const SCALE_ADMISSION_CAP = 4;
export const SCALE_PROVIDER_CAP = 4;

/**
 * The recorder's stats, or undefined when it wrote none. The recorder writes
 * only after counting a pass, so a run that fails before its first pass
 * (preparation failed, the settle wait ran out) leaves no file; that must
 * surface as a named check after the run's diagnostics, not as ENOENT.
 */
export async function readFanoutStats(file: string): Promise<FanoutStats | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text) as FanoutStats;
}

/** What the concurrency check reads from a settled scale run. */
export interface ScaleConcurrencyInput {
  stats: FanoutStats | undefined;
  runId: string;
  /** Each reviewer's platform, in panel order (`scalePanelPlatforms`). */
  panel: readonly AgentPlatform[];
  admissionCap?: number;
  providerCap?: number;
}

/**
 * Why the recorded scheduler peaks do not show the caps holding and the panel
 * running in parallel, empty when they do. Both bounds are checked: a peak
 * above a cap is a broken limit, and a peak below what the scheduler's
 * synchronous first fill starts (`runBoundedTasks` starts every task that fits
 * before any settles) means it serialized work or the recorder dropped events.
 * Every panel platform ran at least one task, so each must have a peak.
 */
export function scaleConcurrencyProblems(input: ScaleConcurrencyInput): string[] {
  const admissionCap = input.admissionCap ?? SCALE_ADMISSION_CAP;
  const providerCap = input.providerCap ?? SCALE_PROVIDER_CAP;
  const { stats } = input;
  if (!stats) return ["the backend recorded no fan-out pass (no stats file)"];
  const problems: string[] = [];
  if (stats.runId !== input.runId) {
    problems.push(`the fan-out stats belong to run ${stats.runId}, not ${input.runId}`);
  }
  if (!(stats.passes > 0)) problems.push("the backend recorded no fan-out pass");
  const perPlatform = new Map<AgentPlatform, number>();
  for (const platform of input.panel) {
    perPlatform.set(platform, (perPlatform.get(platform) ?? 0) + 1);
  }
  const firstFill = Math.min(
    admissionCap,
    Array.from(perPlatform.values()).reduce((sum, count) => sum + Math.min(count, providerCap), 0),
  );
  if (stats.maxAdmission > admissionCap) {
    problems.push(`admission peak ${stats.maxAdmission} exceeds the cap ${admissionCap}`);
  }
  if (stats.maxAdmission < firstFill) {
    problems.push(`admission peak ${stats.maxAdmission} is below the first fill ${firstFill}`);
  }
  for (const platform of perPlatform.keys()) {
    const peak = stats.maxByPlatform[platform] ?? 0;
    if (peak > providerCap) {
      problems.push(`${platform} peak ${peak} exceeds the provider cap ${providerCap}`);
    }
    if (peak < 1) problems.push(`${platform} has no recorded concurrency peak`);
  }
  return problems;
}

/**
 * The credential-free mode (`ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE_FAKE_MODEL=1`):
 * every reviewer, preparation, consolidation and Fix runs on the profile's
 * real Pi bridge and Pi SDK against the scripted loopback model
 * `auto-pipeline-fake-model.ts`, which answers each Multi Review result tool
 * with a fixed, finding-free result. No login and nothing billed; it measures
 * the control plane (caps, latency, memory), not review quality.
 */
export const SCALE_FAKE_PLATFORMS: readonly AgentPlatform[] = ["pi"];
export const SCALE_FAKE_PI_PROVIDER = "scale-fake";
/** `FAKE_MODEL_ID` in `auto-pipeline-fake-model.ts`, which cannot be imported: it listens on load. */
export const SCALE_FAKE_PI_MODEL = "autopipe-1";
/** The fake model's display name in `models.json`. */
export const SCALE_FAKE_MODEL_LABEL = "Scale fake 1";
/** `provider/modelId`, how a Pi model is selected. */
export const SCALE_FAKE_PI_MODEL_REF = `${SCALE_FAKE_PI_PROVIDER}/${SCALE_FAKE_PI_MODEL}`;

/** The Pi `models.json` naming the fake provider; its key is a literal placeholder. */
export function scaleFakePiModelsConfig(baseUrl: string) {
  const config = piProviderConfig({
    provider: SCALE_FAKE_PI_PROVIDER,
    providerName: "Scale fake",
    baseUrl,
    apiKey: "scale-fake-not-a-key",
    model: SCALE_FAKE_PI_MODEL,
    modelName: SCALE_FAKE_MODEL_LABEL,
  });
  const provider = config.providers[SCALE_FAKE_PI_PROVIDER]!;
  // Large, so a reviewer prompt carrying the review package never makes Pi
  // compact first, which would be another model call per reviewer.
  provider.models = provider.models.map((model) => ({
    ...model,
    contextWindow: 1_000_000,
    maxTokens: 4_096,
  }));
  return config;
}

/**
 * Writes the fake provider into the profile's own isolated Pi `models.json`
 * (never `~/.pi`) and returns the restore, which puts back what was there.
 * Refuses a file that already names another provider: it belongs to someone.
 */
export function writeScaleFakePiModels(dataDir: string, baseUrl: string): () => void {
  const root = path.resolve(dataDir);
  const directory = profilePiAgentDirectory(root);
  const file = path.join(directory, "models.json");
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("models.json escapes the profile");
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (previous !== undefined) {
    const providers = Object.keys(
      (JSON.parse(previous) as { providers?: Record<string, unknown> }).providers ?? {},
    );
    if (providers.some((provider) => provider !== SCALE_FAKE_PI_PROVIDER)) {
      throw new Error("The profile's Pi models.json already names other providers");
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (content: string) => {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, file);
  };
  write(`${JSON.stringify(scaleFakePiModelsConfig(baseUrl), null, 2)}\n`);
  return () => {
    if (previous === undefined) rmSync(file, { force: true });
    else write(previous);
  };
}

/** The submission tool of each Multi Review step the fake model answers. */
export const SCALE_FAKE_SUBMISSION_TOOLS = {
  preparation: "submit_validation_plan",
  reviewer: "submit_review_report",
  consolidation: "submit_consolidated_review",
} as const;

/** What the fake-mode outcome check reads from a settled scale run. */
export interface ScaleFakeOutcome {
  reviewers: number;
  phase: string;
  consolidated: boolean;
  statuses: readonly string[];
  /** The fake model's `GET /__calls` submission counts, by tool. */
  submissions: Readonly<Record<string, number>> | undefined;
}

/**
 * Why a fake-model run did not qualify, empty when it did. The fake answers
 * every step with a valid result, so anything short of a ready, consolidated
 * review in which every reviewer completed and submitted is a failure: a
 * settled-but-failed panel must not report green.
 */
export function scaleFakeOutcomeProblems(outcome: ScaleFakeOutcome): string[] {
  const problems: string[] = [];
  if (outcome.phase !== "ready") problems.push(`phase is ${outcome.phase}, not ready`);
  if (!outcome.consolidated) problems.push("no consolidated report");
  if (outcome.statuses.length !== outcome.reviewers) {
    problems.push(`${outcome.statuses.length} reviewers, expected ${outcome.reviewers}`);
  }
  const completed = outcome.statuses.filter((status) => status === "completed").length;
  if (completed !== outcome.reviewers) {
    problems.push(`${completed} of ${outcome.reviewers} reviewers completed`);
  }
  if (!outcome.submissions) {
    problems.push("the fake model reported no submission counts");
    return problems;
  }
  const minimum = {
    preparation: 1,
    reviewer: outcome.reviewers,
    consolidation: 1,
  } as const;
  for (const [step, tool] of Object.entries(SCALE_FAKE_SUBMISSION_TOOLS)) {
    const count = outcome.submissions[tool] ?? 0;
    const wanted = minimum[step as keyof typeof minimum];
    if (count < wanted) problems.push(`${tool} submitted ${count} times, expected ${wanted}`);
  }
  return problems;
}

/**
 * Runs every teardown step even when an earlier one throws, then rethrows the
 * first failure, so a failed cleanup cannot leave a fake model running or a
 * profile file modified.
 */
export async function runTeardown(
  steps: ReadonlyArray<() => unknown | Promise<unknown>>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "teardown failed");
}

/**
 * Starts the scale case's loopback model (`auto-pipeline-fake-model.ts`, or
 * `script` in tests) and waits for the origin it prints first. A model that
 * stays alive without printing is killed at `startupTimeoutMs`, so the case
 * fails fast rather than at the test's 45-minute timeout.
 */
export async function startScaleFakeModel(
  options: { script?: string; startupTimeoutMs?: number } = {},
): Promise<{ origin: string; child: ChildProcess }> {
  const script = options.script ?? path.join(import.meta.dirname, "auto-pipeline-fake-model.ts");
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const child = spawn("bun", [script], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout! });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      lines.once("line", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("the fake model exited before it listened")));
      timer = setTimeout(
        () => reject(new Error(`the fake model printed no origin within ${startupTimeoutMs} ms`)),
        startupTimeoutMs,
      );
    });
    return { origin, child };
  } catch (error) {
    lines.close();
    await stopChild(child);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stops a child this case started through its own handle: SIGTERM, then
 * SIGKILL after `graceMs`, so a child that ignores SIGTERM cannot stall the
 * teardown.
 */
export function stopChild(child: ChildProcess, graceMs = 5_000): Promise<void> {
  // A child that never spawned has no pid and emits no exit.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const escalate = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(escalate);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
