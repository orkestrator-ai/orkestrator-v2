// The Claude model catalogue behind `GET /config/models`.
//
// It is bridge-wide, and a read may have to spawn a whole CLI to answer, so
// each read takes the first of these that answers:
//
//   1. A CLI already running on this bridge: its held initialize answer.
//   2. The last answer, while the CLI binary, the config directory and the
//      account it was read under are unchanged.
//   3. One control-only probe, shared by every read waiting on it.
//   4. The shared static catalogue, reported as `source: "fallback"` and never
//      remembered, so the next read tries again.

import type { AccountInfo, ModelInfo as SdkModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_FALLBACK_MODEL_CATALOG } from "@orkestrator/protocol/claude-model-catalog";
import { stat } from "node:fs/promises";
import type { ModelInfo } from "../types/index.js";
import {
  claudeAccountKey,
  claudeObservedAccountKey,
  normalizeClaudeAccount,
} from "./claude-sign-in.js";
import { controlOnlyQuery } from "./control-only-query.js";
import { liveInitializationResult, readFromLiveClaude } from "./live-claude-control.js";
import { debugLog } from "./logger.js";
import { claudeExecutableOptions } from "./session-manager-core.js";

/**
 * A backstop for a change nothing reported, such as a login made in a terminal
 * while no account read ran. The backend re-reads every 5 minutes without a
 * running CLI, so this keeps one probe an hour rather than twelve.
 */
export const CLAUDE_MODEL_CACHE_TTL_MS = 60 * 60_000;

/**
 * How long a probe may take before the read answers from the static catalogue.
 * Inside the backend's 30 s request bound, and a read shares its probe, so a
 * wedged CLI must not hold every later read with it.
 */
export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 25_000;

export interface ClaudeModelCatalog {
  models: ModelInfo[];
  source: "sdk" | "fallback";
}

interface RememberedModels {
  cli: string;
  account: string;
  models: readonly SdkModelInfo[];
  expiresAt: number;
}

let remembered: RememberedModels | undefined;
/** Bumped by an invalidation, so an older probe cannot repopulate the cache. */
let generation = 0;
let probe: { generation: number; read: Promise<ClaudeModelCatalog> } | undefined;

/** Drop what is remembered: an explicit catalogue refresh. */
export function invalidateClaudeModelCatalog(): void {
  remembered = undefined;
  generation += 1;
}

export function resetClaudeModelCatalogForTesting(): void {
  invalidateClaudeModelCatalog();
  probe = undefined;
}

function catalogModels(models: readonly SdkModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    id: model.value,
    resolvedModel: model.resolvedModel,
    name: model.displayName,
    description: model.description,
    supportsFastMode: model.supportsFastMode,
    supportsEffort: model.supportsEffort,
    supportedEffortLevels: model.supportedEffortLevels,
    supportsAdaptiveThinking: model.supportsAdaptiveThinking,
    supportsAutoMode: model.supportsAutoMode,
  }));
}

/**
 * The CLI a remembered answer came from, without running it: the file standing
 * for its version, and the config directory that holds its login. The bundled
 * CLI cannot change under a running bridge. An account switch replaces the
 * bridge, so the directory is only ever a safeguard.
 */
async function claudeCliIdentity(): Promise<string> {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() ?? "";
  const executable = process.env.CLAUDE_CLI_PATH?.trim();
  if (!executable) return JSON.stringify([configDir]);
  const file = await stat(executable).catch(() => undefined);
  return JSON.stringify([configDir, executable, file?.size, file?.mtimeMs]);
}

/** The account an initialize answer describes, when it says. */
function accountKeyOf(account: unknown): string | undefined {
  if (!account || typeof account !== "object") return undefined;
  return claudeAccountKey(normalizeClaudeAccount(account as AccountInfo));
}

/**
 * Remember an answer only for an account a later read can compare against. A
 * signed-out list is not kept: a login made since would have to be noticed
 * before the right list could come back.
 */
async function rememberModels(
  models: readonly SdkModelInfo[],
  account: unknown,
  at = generation,
): Promise<void> {
  if (!account || typeof account !== "object" || models.length === 0) return;
  const status = normalizeClaudeAccount(account as AccountInfo);
  if (status.state !== "signed-in") return;
  const cli = await claudeCliIdentity();
  if (at !== generation) return;
  remembered = {
    cli,
    account: claudeAccountKey(status),
    models,
    expiresAt: Date.now() + CLAUDE_MODEL_CACHE_TTL_MS,
  };
}

async function rememberedModels(): Promise<readonly SdkModelInfo[] | undefined> {
  const entry = remembered;
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  const observed = claudeObservedAccountKey();
  if (observed !== undefined && observed !== entry.account) return undefined;
  return entry.cli === (await claudeCliIdentity()) ? entry.models : undefined;
}

/**
 * The models a running CLI listed in its initialize answer, if one is running.
 *
 * An empty or malformed list is no answer: the probe decides then. So is one
 * from a CLI launched under another account than the bridge last saw, such as
 * before a sign-in. An answer that does not say is taken as it always was.
 */
function liveModels(): Promise<{ models: SdkModelInfo[]; account: unknown } | undefined> {
  const observed = claudeObservedAccountKey();
  return readFromLiveClaude((control) =>
    liveInitializationResult(control)?.then((result) => {
      if (!Array.isArray(result?.models) || result.models.length === 0) return undefined;
      const account = accountKeyOf(result.account);
      if (observed !== undefined && account !== undefined && account !== observed) {
        return undefined;
      }
      return { models: result.models as SdkModelInfo[], account: result.account };
    }),
  );
}

function fallbackCatalog(): ClaudeModelCatalog {
  // The renderer projects the same protocol constant into its local ClaudeModel shape.
  return {
    source: "fallback",
    models: CLAUDE_FALLBACK_MODEL_CATALOG.map((model) => ({
      ...model,
      ...(model.supportedEffortLevels
        ? { supportedEffortLevels: [...model.supportedEffortLevels] }
        : {}),
    })),
  };
}

/** A control-only query: `supportedModels()` without running a turn. */
async function probeModels(at: number): Promise<ClaudeModelCatalog> {
  let q: ReturnType<typeof controlOnlyQuery> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const cwd = process.env.CWD || process.cwd();
    debugLog("[session-manager] Fetching supported models", { cwd });
    q = controlOnlyQuery({
      cwd,
      env: { ...process.env },
      ...claudeExecutableOptions(),
    });
    const control = q;
    // Both come from the one initialize answer, so the account costs nothing.
    const [models, account] = await Promise.race([
      Promise.all([
        control.supportedModels(),
        typeof control.accountInfo === "function"
          ? control.accountInfo().catch(() => undefined)
          : undefined,
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The model probe did not answer in time")),
          CLAUDE_MODEL_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    debugLog("[session-manager] Supported models fetched", { count: models.length });
    await rememberModels(models, account, at);
    return { source: "sdk", models: catalogModels(models) };
  } catch (error) {
    console.error("[session-manager] Error fetching supported models:", error);
    return fallbackCatalog();
  } finally {
    clearTimeout(timer);
    if (q?.return) {
      try {
        await q.return();
      } catch (error) {
        debugLog("[session-manager] Failed to clean up model query:", error);
      }
    }
  }
}

/** One probe at a time: every read waiting for the same answer shares it. */
function sharedProbe(): Promise<ClaudeModelCatalog> {
  if (probe?.generation === generation) return probe.read;
  const read: Promise<ClaudeModelCatalog> = probeModels(generation).finally(() => {
    if (probe?.read === read) probe = undefined;
  });
  probe = { generation, read };
  return read;
}

export async function getAvailableModelCatalog(): Promise<ClaudeModelCatalog> {
  const live = await liveModels();
  if (live) {
    debugLog("[session-manager] Supported models read from a running CLI", {
      count: live.models.length,
    });
    await rememberModels(live.models, live.account);
    return { source: "sdk", models: catalogModels(live.models) };
  }
  const known = await rememberedModels();
  if (known) return { source: "sdk", models: catalogModels(known) };
  return sharedProbe();
}

export async function getAvailableModels(): Promise<ModelInfo[]> {
  return (await getAvailableModelCatalog()).models;
}
