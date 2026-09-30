import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";
import type { NativeAgentAccountUsageWindow } from "./native-agent.js";

/**
 * Provider plan/quota usage read without an active agent session.
 *
 * The settings page is global, so it cannot borrow a running session's usage
 * snapshot. This is the shape the backend returns for one platform: the same
 * account windows the information panel draws, plus an explicit status so the
 * UI can tell "the plan has no metered limits" from "we could not read it".
 */
export type PlanUsageStatus = "ok" | "unavailable" | "error";

/**
 * Platforms whose plan quota Orkestrator can read outside an agent session.
 *
 * Grok and Pi are deliberately absent: neither exposes an account quota read,
 * and inventing one from session spend is exactly the fake meter the account
 * panel was rewritten to avoid. This list is the single source of truth for
 * both the backend reader and the settings section that offers the card.
 */
export const PLAN_USAGE_PLATFORMS = ["claude", "codex", "cursor", "opencode"] as const;
export type PlanUsagePlatform = (typeof PLAN_USAGE_PLATFORMS)[number];

export function isPlanUsagePlatform(value: unknown): value is PlanUsagePlatform {
  return typeof value === "string" && (PLAN_USAGE_PLATFORMS as readonly string[]).includes(value);
}

export interface PlanUsageSnapshot {
  platform: AgentPlatform;
  status: PlanUsageStatus;
  /** Quota windows the provider reported. Empty is valid only when `status` is `ok`. */
  windows: NativeAgentAccountUsageWindow[];
  /** The account's plan name, when the provider reports one. */
  plan?: string;
  /** User-facing explanation for `unavailable` or `error`. */
  message?: string;
  fetchedAt: string;
}

export function isPlanUsageSnapshot(value: unknown): value is PlanUsageSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isAgentPlatform(candidate.platform)) return false;
  if (
    candidate.status !== "ok" &&
    candidate.status !== "unavailable" &&
    candidate.status !== "error"
  ) {
    return false;
  }
  if (!Array.isArray(candidate.windows)) return false;
  if (candidate.plan !== undefined && typeof candidate.plan !== "string") return false;
  if (candidate.message !== undefined && typeof candidate.message !== "string") return false;
  return typeof candidate.fetchedAt === "string";
}

const WEEK_MINUTES = 7 * 24 * 60;

/**
 * Claude's known plan window ids, their labels and period.
 *
 * The single naming for Claude windows, and the same "5-hour limit" / "Weekly
 * limit" wording Codex windows get. Both the OAuth read and the bridge's
 * session rate limits label from here, so one quota is never shown twice under
 * two names.
 */
export const CLAUDE_PLAN_WINDOW_LABELS: Record<string, { label: string; windowMinutes: number }> = {
  five_hour: { label: "5-hour limit", windowMinutes: 300 },
  seven_day: { label: "Weekly limit", windowMinutes: WEEK_MINUTES },
  seven_day_opus: { label: "Weekly Opus limit", windowMinutes: WEEK_MINUTES },
  seven_day_sonnet: { label: "Weekly Sonnet limit", windowMinutes: WEEK_MINUTES },
  seven_day_oauth_apps: { label: "Weekly apps limit", windowMinutes: WEEK_MINUTES },
};

export interface ClaudePlanWindowIdentity {
  id: string;
  label: string;
  windowMinutes: number;
}

/** A weekly limit that applies to one model, e.g. "Weekly Fable limit". */
export function claudeModelWeeklyWindow(modelName: string): ClaudePlanWindowIdentity | undefined {
  const name = modelName.trim();
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return undefined;
  const id = `seven_day_${slug}`;
  const known = CLAUDE_PLAN_WINDOW_LABELS[id];
  return { id, label: known?.label ?? `Weekly ${name} limit`, windowMinutes: WEEK_MINUTES };
}

/** Identity from Claude's named OAuth limits and in-session `/usage` reports. */
export function claudePlanWindowFromKind(
  kind: unknown,
  modelName?: unknown,
): ClaudePlanWindowIdentity | undefined {
  if (kind === "session") return { id: "five_hour", ...CLAUDE_PLAN_WINDOW_LABELS.five_hour! };
  if (kind === "weekly_all") return { id: "seven_day", ...CLAUDE_PLAN_WINDOW_LABELS.seven_day! };
  if (kind === "weekly_scoped" && typeof modelName === "string") {
    return claudeModelWeeklyWindow(modelName);
  }
  return undefined;
}

/**
 * Labels older Claude bridges gave session rate limits, taken from Claude
 * Code's own `/usage` screen. A container can run an older bridge than the
 * app, so these still resolve to the canonical window.
 */
const LEGACY_CLAUDE_WINDOW_LABELS: Record<string, string> = {
  "five hour": "five_hour",
  session: "five_hour",
  weekly: "seven_day",
  "weekly all": "seven_day",
  "weekly (oauth apps)": "seven_day_oauth_apps",
};

/** The canonical identity for a Claude rate-limit label, when it names a known window. */
export function claudePlanWindowFromLabel(label: string): ClaudePlanWindowIdentity | undefined {
  const normalized = label.trim().toLowerCase();
  const legacyId = LEGACY_CLAUDE_WINDOW_LABELS[normalized];
  for (const [id, meta] of Object.entries(CLAUDE_PLAN_WINDOW_LABELS)) {
    if (id === legacyId || meta.label.toLowerCase() === normalized) return { id, ...meta };
  }
  // "Weekly (Fable)" from an older bridge, or "Weekly Fable limit".
  const model =
    label.trim().match(/^weekly \((.+)\)$/i)?.[1] ??
    label.trim().match(/^weekly (.+) limit$/i)?.[1];
  if (!model) return undefined;
  const known = Object.entries(CLAUDE_PLAN_WINDOW_LABELS).find(
    ([id]) => id === `seven_day_${model.trim().toLowerCase()}`,
  );
  return known ? { id: known[0], ...known[1] } : claudeModelWeeklyWindow(model);
}
