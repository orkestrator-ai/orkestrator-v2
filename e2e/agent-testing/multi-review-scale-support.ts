/**
 * Pure helpers for the live Multi Review scale case
 * (`multi-review-live.spec.ts`, `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE`):
 * which platforms the panel uses, how reviewers are spread over them, which
 * model each platform runs, and how much memory the profile backend's whole
 * process tree holds (the backend plus the bridges and agent CLIs it started).
 */
import { spawnSync } from "node:child_process";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";

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
export function parseScalePlatforms(value: string | undefined): AgentPlatform[] {
  const trimmed = value?.trim();
  if (!trimmed) return [...DEFAULT_SCALE_PLATFORMS];
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
