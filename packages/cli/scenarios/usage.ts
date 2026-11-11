import type { UsageHistoryReport, UsageTotals } from "@orkestrator/protocol/usage-history";
import { readTokenFile } from "../src/client/targets.js";
import type { IsolatedBackend } from "./harness.js";

/**
 * What a scenario's agent turns cost, read from the scenario backend's own
 * usage history before the backend stops (to-do 0014 task 4).
 *
 * The backend records usage from the per-turn counts each provider reports,
 * one row per agent session (`usage-history`), and serves it through the
 * `get_usage_history` command the usage panes read. The harness owns the
 * scenario's data directory and the backend in it, so every recorded row is
 * this scenario's: the report needs no filter. It reads that command over the
 * gateway with the backend's own token rather than opening the SQLite file,
 * so a change to the storage layout cannot silently break it.
 *
 * Content-free by construction: counts, platform and model names only, which
 * is all the report carries. The token never leaves this function.
 *
 * Limits: it counts only what each provider reported and the backend has
 * observed. Usage is recorded when a session projection is read, which every
 * dispatch and transcript read does; a turn the backend never re-read after
 * it ended is not counted. Codex and Grok report tokens without a price, so
 * their tokens land in `unpricedTokens` and `costUsd` stays 0.
 */

const INVOKE_PATH = "/__orkestrator/invoke";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Recording is written off the projection path; give the last write a moment. */
const DEFAULT_SETTLE_MS = 1_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 32;
/** Two days, so a run that crosses local midnight is still counted whole. */
const REPORT_DAYS = 2;

export interface RunUsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Spend the provider priced; 0 when it reported none. */
  costUsd: number;
  /** Tokens of turns the provider did not price. */
  unpricedTokens: number;
  costSource?: string;
}

export interface RunUsage extends RunUsageTotals {
  sessions: number;
  models: Array<{ platform: string; modelId: string; sessions: number } & RunUsageTotals>;
}

export type RunUsageRecord = { usage: RunUsage } | { usage: null; readError: string };

export interface ReadRunUsageOptions {
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  readToken?: (file: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Wait before a second read when the first counted no turns. */
  settleMs?: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function totals(value: Partial<UsageTotals> | undefined): RunUsageTotals {
  return {
    turns: count(value?.turns),
    inputTokens: count(value?.inputTokens),
    outputTokens: count(value?.outputTokens),
    cacheReadTokens: count(value?.cacheReadTokens),
    cacheWriteTokens: count(value?.cacheWriteTokens),
    reasoningTokens: count(value?.reasoningTokens),
    totalTokens: count(value?.totalTokens),
    costUsd: count(value?.costUsd),
    unpricedTokens: count(value?.unpricedTokens),
    ...(typeof value?.costSource === "string" ? { costSource: value.costSource } : {}),
  };
}

/** The bounded, content-free part of a usage report the manifest keeps. */
export function summarizeUsageReport(report: Partial<UsageHistoryReport>): RunUsage {
  const models = Array.isArray(report.models) ? report.models : [];
  return {
    ...totals(report.totals),
    sessions: count(report.sessions),
    models: models.slice(0, MAX_MODELS).map((model) => ({
      platform: String(model.platform).slice(0, 32),
      modelId: String(model.modelId).slice(0, 200),
      sessions: count(model.sessions),
      ...totals(model.totals),
    })),
  };
}

async function readReport(
  backend: Pick<IsolatedBackend, "descriptor">,
  token: string,
  options: ReadRunUsageOptions,
): Promise<RunUsage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("timeout")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(
      `${backend.descriptor.url.replace(/\/+$/, "")}${INVOKE_PATH}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ command: "get_usage_history", args: { days: REPORT_DAYS } }),
        redirect: "manual",
        signal: controller.signal,
      },
    );
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("usage report too large");
    if (!response.ok) throw new Error(`usage read answered HTTP ${response.status}`);
    const payload = JSON.parse(text) as { result?: Partial<UsageHistoryReport> };
    if (!payload.result || typeof payload.result !== "object")
      throw new Error("usage read returned no report");
    return summarizeUsageReport(payload.result);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the scenario backend's recorded usage. Never throws: a failed read is
 * recorded as `readError` (a fixed, content-free message) so the scenario's
 * own outcome stays its verdict.
 */
export async function readRunUsage(
  backend: Pick<IsolatedBackend, "descriptor">,
  options: ReadRunUsageOptions = {},
): Promise<RunUsageRecord> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  try {
    const token = await (options.readToken ?? ((file) => readTokenFile(file, true)))(
      backend.descriptor.authFile,
    );
    let usage = await readReport(backend, token, options);
    if (usage.turns === 0) {
      // The recorder writes off the projection path, so the final turn can
      // still be in flight; one more read after a short wait.
      await sleep(options.settleMs ?? DEFAULT_SETTLE_MS);
      usage = await readReport(backend, token, options);
    }
    return { usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    // Error text from fetch or JSON parsing names no token or content, but
    // bound it all the same.
    return { usage: null, readError: message.slice(0, 200) };
  }
}

/** One line for the run's console output. */
export function formatRunUsage(record: RunUsageRecord): string {
  if (!record.usage) return `usage: unavailable (${record.readError})`;
  const usage = record.usage;
  const models = usage.models.map((model) => `${model.platform}/${model.modelId}`).join(", ");
  return `usage: ${usage.turns} turns, ${usage.inputTokens} in, ${usage.outputTokens} out, ${
    usage.cacheReadTokens
  } cache read, ${usage.cacheWriteTokens} cache write, ${usage.totalTokens} total, $${usage.costUsd.toFixed(
    4,
  )}${usage.unpricedTokens ? ` (${usage.unpricedTokens} unpriced tokens)` : ""}${
    models ? ` [${models}]` : ""
  }`;
}
