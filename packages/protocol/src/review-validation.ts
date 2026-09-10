/** A fresh, repository-specific plan. Never inferred from a package-manager name. */
export interface ReviewValidationPlan {
  headRef: string;
  commands: Array<{
    id: string;
    command: string;
    cwd: string;
    dependsOn: string[];
    /** Commands with overlapping resources never run together; "*" is exclusive. */
    resources: string[];
    /** Internally parallel or memory-heavy commands reserve the whole runner. */
    weight: 1 | 2;
    timeoutMs: number;
  }>;
  limitations: string[];
}

export interface ReviewValidationResult {
  id: string;
  command: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  exitCode: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256?: string;
  stderrSha256?: string;
  startedAt?: string;
  durationMs: number;
  limitation: string | null;
}

/** Maximum tail returned for each validation output stream in one UI snapshot. */
export const REVIEW_VALIDATION_OUTPUT_MAX_BYTES = 512 * 1024;

export interface ReviewValidationOutputStream {
  contentBase64: string;
  totalBytes: number;
  startOffset: number;
}

export interface ReviewValidationOutput {
  resultId: string;
  status: ReviewValidationResult["status"];
  stdout: ReviewValidationOutputStream | null;
  stderr: ReviewValidationOutputStream | null;
}

/** Durable projection of an environment-owned process, independent of any agent session. */
export interface ReviewValidationRun {
  id: string;
  plan: ReviewValidationPlan;
  status: "planned" | "running" | "completed" | "cancelled" | "failed";
  startedAt: string;
  completedAt?: string;
  discoveryDurationMs?: number;
  sealingDurationMs?: number;
  error?: string;
  results: ReviewValidationResult[];
}

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 4096): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\0");
const strings = (v: unknown, count = 32): v is string[] =>
  Array.isArray(v) && v.length <= count && v.every((s) => text(s));
const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const uint = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

export function isReviewValidationPlan(value: unknown): value is ReviewValidationPlan {
  if (
    !object(value) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 24000 ||
    !sha(value.headRef) ||
    !strings(value.limitations) ||
    !Array.isArray(value.commands) ||
    value.commands.length > 32 ||
    (value.commands.length === 0 && value.limitations.length === 0)
  )
    return false;
  const ids = new Set<string>();
  for (const cmd of value.commands) {
    if (
      !object(cmd) ||
      !text(cmd.id, 64) ||
      !/^[a-zA-Z0-9_-]+$/.test(cmd.id) ||
      ids.has(cmd.id) ||
      !text(cmd.command, 8192) ||
      !text(cmd.cwd, 1024) ||
      cmd.cwd.startsWith("/") ||
      cmd.cwd.includes("\\") ||
      cmd.cwd.split("/").includes("..") ||
      !strings(cmd.dependsOn) ||
      new Set(cmd.dependsOn).size !== cmd.dependsOn.length ||
      !cmd.dependsOn.every((id) => ids.has(id)) ||
      !strings(cmd.resources) ||
      (cmd.weight !== 1 && cmd.weight !== 2) ||
      !Number.isSafeInteger(cmd.timeoutMs) ||
      (cmd.timeoutMs as number) < 1000 ||
      (cmd.timeoutMs as number) > 7_200_000
    )
      return false;
    ids.add(cmd.id);
  }
  return true;
}

export function parseReviewValidationPlan(value: unknown): ReviewValidationPlan {
  if (!isReviewValidationPlan(value))
    throw new Error(
      "Invalid validation plan: use at most 32 commands in dependency order, relative working directories, bounded timeouts, and the current full HEAD SHA",
    );
  return value;
}

export function isReviewValidationRun(value: unknown): value is ReviewValidationRun {
  if (
    !object(value) ||
    !text(value.id, 200) ||
    !/^[a-zA-Z0-9_-]+$/.test(value.id) ||
    !isReviewValidationPlan(value.plan) ||
    !date(value.startedAt) ||
    !["planned", "running", "completed", "cancelled", "failed"].includes(String(value.status)) ||
    (value.completedAt !== undefined && !date(value.completedAt)) ||
    (value.discoveryDurationMs !== undefined && !uint(value.discoveryDurationMs)) ||
    (value.sealingDurationMs !== undefined && !uint(value.sealingDurationMs)) ||
    (value.error !== undefined && !text(value.error)) ||
    !Array.isArray(value.results) ||
    value.results.length !== value.plan.commands.length
  )
    return false;
  const plan = value.plan;
  return value.results.every(
    (r, i) =>
      object(r) &&
      r.id === plan.commands[i]!.id &&
      r.command === plan.commands[i]!.command &&
      ["pending", "running", "passed", "failed", "skipped"].includes(String(r.status)) &&
      (r.exitCode === null || Number.isSafeInteger(r.exitCode)) &&
      (r.stdoutPath === null || text(r.stdoutPath)) &&
      (r.stderrPath === null || text(r.stderrPath)) &&
      uint(r.stdoutBytes) &&
      uint(r.stderrBytes) &&
      uint(r.durationMs) &&
      (r.limitation === null || text(r.limitation)) &&
      (r.startedAt === undefined || date(r.startedAt)) &&
      (r.stdoutSha256 === undefined || digest(r.stdoutSha256)) &&
      (r.stderrSha256 === undefined || digest(r.stderrSha256)) &&
      (r.status !== "passed" || r.exitCode === 0) &&
      (value.status !== "completed" || ["passed", "failed", "skipped"].includes(String(r.status))),
  );
}

export function newReviewValidationRun(
  id: string,
  plan: ReviewValidationPlan,
): ReviewValidationRun {
  return {
    id,
    plan,
    status: "planned",
    startedAt: new Date().toISOString(),
    results: plan.commands.map((cmd) => ({
      id: cmd.id,
      command: cmd.command,
      status: "pending",
      exitCode: null,
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: 0,
      limitation: null,
    })),
  };
}
