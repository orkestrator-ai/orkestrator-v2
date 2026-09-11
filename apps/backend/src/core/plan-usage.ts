import { randomBytes } from "node:crypto";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentAccountUsageWindow } from "@orkestrator/protocol/native-agent";
import {
  isPlanUsagePlatform,
  PLAN_USAGE_PLATFORMS,
  type PlanUsagePlatform,
  type PlanUsageSnapshot,
} from "@orkestrator/protocol/plan-usage";
import type { CommandContext } from "./commands-context.js";
import { asRecord } from "./agent-provider-runtime.js";
import {
  resolveBunBinary,
  resolveClaudeBinary,
  resolveCodexBinary,
} from "./commands-agent-support.js";
import { bearerBridgeHeaders, claudeBridgeAuthHeaders } from "./commands-server-health.js";
import {
  applyClaudeHostCredentialEnvironment,
  resolveCursorHostCredentialMaterial,
} from "./host-agent-credentials.js";
import { cursorSdkCredentialPath } from "./cursor-sdk-bridge.js";
import {
  bridgeEntrypoint,
  probeWorkingDirectory,
  withShortLivedBridge,
} from "./host-model-catalog-refresh.js";
import { resolveOpenCodeZenApiKey } from "./commands-validation.js";
import {
  APP_VERSION,
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";

/**
 * Platforms whose plan quota Orkestrator can read outside an agent session.
 *
 * Re-exported from the shared protocol module so the backend reader and the
 * settings section cannot drift into disagreeing about who has a plan read.
 */
export { isPlanUsagePlatform, PLAN_USAGE_PLATFORMS };
export type { PlanUsagePlatform };

export const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const PROBE_TIMEOUT_MS = 25_000;
const OPENCODE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;
const ERROR_CACHE_TTL_MS = 10_000;

/**
 * ECMAScript `Date` only represents ±8.64e15 ms around the epoch. A provider
 * reset timestamp outside that range would produce an Invalid Date whose
 * `toISOString()` throws, aborting the whole normalization over one bad field.
 */
const MAX_DATE_MS = 8.64e15;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function finitePercent(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function isoReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Both epoch-second and epoch-millisecond readings are plausible; anything
    // below the year-2001 millisecond mark is treated as seconds.
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > MAX_DATE_MS) return undefined;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > MAX_DATE_MS) return undefined;
  return new Date(timestamp).toISOString();
}

/**
 * Map OpenCode Zen's `usage` payload onto the generic account windows.
 *
 * The plan reports a percentage spent per window, under `rolling`, `weekly`
 * and `monthly`. A window whose `status` is not `ok` is omitted rather than
 * drawn from a percent that may not apply.
 */
export function openCodePlanWindows(value: unknown): NativeAgentAccountUsageWindow[] {
  const usage = asRecord(asRecord(value)?.usage);
  if (!usage) return [];
  const windows: NativeAgentAccountUsageWindow[] = [];
  for (const [id, label] of [
    ["rolling", "Rolling"],
    ["weekly", "Weekly"],
    ["monthly", "Monthly"],
  ] as const) {
    const raw = asRecord(usage[id]);
    if (!raw) continue;
    if (typeof raw.status === "string" && raw.status !== "ok") continue;
    const usedPercent = finitePercent(raw.percent);
    const resetsAt = isoReset(raw.resetsAt);
    if (usedPercent === undefined && resetsAt === undefined) continue;
    windows.push({
      window: id,
      label,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  return windows;
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Usage request failed with HTTP ${response.status}`);
  }
  return await response.json();
}

export type PlanUsageReaderDependencies = {
  fetchImpl?: FetchLike;
  now?: () => number;
};

function okSnapshot(
  platform: AgentPlatform,
  windows: NativeAgentAccountUsageWindow[],
  fetchedAt: string,
): PlanUsageSnapshot {
  return { platform, status: "ok", windows, fetchedAt };
}

function unavailableSnapshot(platform: AgentPlatform, message: string): PlanUsageSnapshot {
  return {
    platform,
    status: "unavailable",
    windows: [],
    message,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * A bridge `/global/usage` read that is worth reporting as "we could not read".
 *
 * An array body — including an empty one — is an authoritative snapshot. An
 * explicit `account: null` (or a missing `account`) means the bridge could not
 * obtain a credential or reach the provider, and must not be shown as a plan
 * with no metered limits.
 */
export function bridgeAccountWindows(body: unknown): NativeAgentAccountUsageWindow[] | null {
  const record = asRecord(body);
  if (!record || record.account === null || record.account === undefined) return null;
  return normalizeAccountWindows(record.account);
}

async function readOpenCodePlanUsage(
  context: CommandContext,
  dependencies: PlanUsageReaderDependencies,
): Promise<PlanUsageSnapshot> {
  const config = await context.storage.loadConfig();
  const allowed =
    context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("opencode");
  const { apiKey } = allowed
    ? resolveOpenCodeZenApiKey(config.global)
    : { apiKey: undefined as string | undefined };
  if (!apiKey) {
    return unavailableSnapshot(
      "opencode",
      "Add an OpenCode Zen API key below to see your plan usage.",
    );
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const body = await fetchJson(
    fetchImpl,
    OPENCODE_USAGE_URL,
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    OPENCODE_TIMEOUT_MS,
  );
  const windows = openCodePlanWindows(body);
  const nowIso = new Date(dependencies.now?.() ?? Date.now()).toISOString();
  return okSnapshot("opencode", windows, nowIso);
}

async function readClaudePlanUsage(context: CommandContext) {
  const { cwd, entrypoint } = bridgeEntrypoint(context, "claude-bridge");
  const workingDirectory = await probeWorkingDirectory(context);
  const token = randomBytes(32).toString("base64url");
  const config = await context.storage.loadConfig();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CWD: workingDirectory,
    CLAUDE_BRIDGE_TOKEN: token,
    CLAUDE_CLI_PATH: resolveClaudeBinary(context),
    ORKESTRATOR_PARENT_PID: String(process.pid),
    ORKESTRATOR_BRIDGE_DEBUG: config.global.debugLogging === true ? "1" : "0",
  };
  await applyClaudeHostCredentialEnvironment(context, env);
  return probeBridgeWindows({
    kind: "claude",
    command: resolveBunBinary(context),
    args: [entrypoint],
    cwd,
    token,
    headers: claudeBridgeAuthHeaders(token),
    env,
  });
}

async function readCodexPlanUsage(context: CommandContext) {
  const { cwd, entrypoint } = bridgeEntrypoint(context, "codex-bridge");
  const workingDirectory = await probeWorkingDirectory(context);
  const token = randomBytes(32).toString("base64url");
  const config = await context.storage.loadConfig();
  return probeBridgeWindows({
    kind: "codex",
    command: resolveBunBinary(context),
    args: [entrypoint],
    cwd,
    token,
    headers: bearerBridgeHeaders(token),
    env: {
      ...process.env,
      CWD: workingDirectory,
      CODEX_BRIDGE_TOKEN: token,
      CODEX_PATH: resolveCodexBinary(context),
      [CODEX_MAX_CONCURRENT_THREADS_ENV]: String(
        resolveCodexMaxConcurrentThreads(config.global.codexMaxConcurrentThreads),
      ),
      ORKESTRATOR_VERSION: APP_VERSION,
      ORKESTRATOR_PARENT_PID: String(process.pid),
      ORKESTRATOR_BRIDGE_DEBUG: config.global.debugLogging === true ? "1" : "0",
    },
  });
}

async function readCursorPlanUsage(context: CommandContext) {
  const { cwd, entrypoint } = bridgeEntrypoint(context, "cursor-bridge");
  const workingDirectory = await probeWorkingDirectory(context);
  const token = randomBytes(32).toString("base64url");
  const config = await context.storage.loadConfig();
  const cursorCredentials = await resolveCursorHostCredentialMaterial(context);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CWD: workingDirectory,
    CURSOR_BRIDGE_TOKEN: token,
    CURSOR_BRIDGE_AUTH_FILE: cursorSdkCredentialPath(context),
    CURSOR_BRIDGE_PROJECT_SETTINGS: "0",
    ORKESTRATOR_PARENT_PID: String(process.pid),
    ORKESTRATOR_BRIDGE_DEBUG: config.global.debugLogging === true ? "1" : "0",
  };
  if (cursorCredentials.apiKey) env.CURSOR_API_KEY = cursorCredentials.apiKey;
  else delete env.CURSOR_API_KEY;
  return probeBridgeWindows({
    kind: "cursor",
    command: resolveBunBinary(context),
    args: [entrypoint],
    cwd,
    token,
    headers: bearerBridgeHeaders(token),
    env,
  });
}

async function probeBridgeWindows(
  probe: Parameters<typeof withShortLivedBridge>[0],
): Promise<NativeAgentAccountUsageWindow[] | null> {
  return withShortLivedBridge(probe, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/global/usage`, {
      headers: probe.headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Plan usage read failed with HTTP ${response.status}`);
    }
    return bridgeAccountWindows(await response.json());
  });
}

export function normalizeAccountWindows(value: unknown): NativeAgentAccountUsageWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: NativeAgentAccountUsageWindow[] = [];
  for (const candidate of value) {
    const entry = asRecord(candidate);
    if (!entry) continue;
    const window = typeof entry.window === "string" ? entry.window : undefined;
    if (!window) continue;
    const usedPercent = finitePercent(entry.usedPercent);
    const resetsAt = isoReset(entry.resetsAt);
    windows.push({
      window,
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(typeof entry.windowMinutes === "number" ? { windowMinutes: entry.windowMinutes } : {}),
    });
  }
  return windows;
}

export type PlanUsageReadOptions = {
  /** Skip the short-lived cache so an explicit refresh actually re-reads. */
  force?: boolean;
};

export type PlanUsageReader = (
  context: CommandContext,
  platform: AgentPlatform,
  options?: PlanUsageReadOptions,
) => Promise<PlanUsageSnapshot>;

function bridgeUnavailableMessage(platform: PlanUsagePlatform): string {
  switch (platform) {
    case "cursor":
      return "Sign in to Cursor and reconnect to see plan usage.";
    case "codex":
      return "Sign in to Codex to see plan usage.";
    default:
      return "This account's plan usage could not be read.";
  }
}

/**
 * Read one platform's plan quota without an agent session.
 *
 * Successful and "not configured" reads are cached briefly so switching
 * between settings panes does not spawn a fresh bridge each time; failures are
 * cached for a shorter window so a retry can recover. `force` bypasses the read
 * cache for a user-triggered refresh while still coalescing an in-flight read.
 */
export function createPlanUsageReader(
  overrides: PlanUsageReaderDependencies = {},
): PlanUsageReader {
  const cache = new Map<string, { expiresAt: number; snapshot: PlanUsageSnapshot }>();
  const flights = new Map<string, Promise<PlanUsageSnapshot>>();
  return (context, platform, options) => {
    if (!isPlanUsagePlatform(platform)) {
      return Promise.resolve(
        unavailableSnapshot(platform, "Plan usage is not available for this platform."),
      );
    }
    const now = overrides.now ?? Date.now;
    const force = options?.force === true;
    if (!force) {
      const cached = cache.get(platform);
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.snapshot);
    }
    const inFlight = flights.get(platform);
    if (inFlight) return inFlight;
    const read = (async (): Promise<PlanUsageSnapshot> => {
      try {
        let snapshot: PlanUsageSnapshot;
        if (platform === "opencode") {
          snapshot = await readOpenCodePlanUsage(context, overrides);
        } else {
          let windows: NativeAgentAccountUsageWindow[] | null;
          if (platform === "claude") windows = await readClaudePlanUsage(context);
          else if (platform === "codex") windows = await readCodexPlanUsage(context);
          else windows = await readCursorPlanUsage(context);
          snapshot =
            windows === null
              ? unavailableSnapshot(platform, bridgeUnavailableMessage(platform))
              : okSnapshot(platform, windows, new Date(now()).toISOString());
        }
        // "Not configured" is cheap to recompute and must not survive a key
        // being saved into the config, or the settings pane would keep
        // reporting the missing-key message for the rest of the TTL.
        if (snapshot.status !== "unavailable") {
          const ttl = snapshot.status === "error" ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
          cache.set(platform, { expiresAt: now() + ttl, snapshot });
        } else {
          // A forced read that finds no credential must replace whatever the
          // cache still holds, including a previously successful snapshot.
          cache.delete(platform);
        }
        return snapshot;
      } catch (error) {
        const snapshot: PlanUsageSnapshot = {
          platform,
          status: "error",
          windows: [],
          message: error instanceof Error ? error.message : "Plan usage is unavailable",
          fetchedAt: new Date(now()).toISOString(),
        };
        cache.set(platform, { expiresAt: now() + ERROR_CACHE_TTL_MS, snapshot });
        return snapshot;
      }
    })().finally(() => {
      if (flights.get(platform) === read) flights.delete(platform);
    });
    flights.set(platform, read);
    return read;
  };
}

export const readPlanUsage = createPlanUsageReader();
