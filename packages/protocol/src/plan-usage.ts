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

/**
 * Claude's known OAuth usage window ids, their friendly labels and period.
 *
 * Shared so a window a session reports as a rate limit and the same window read
 * straight from the OAuth endpoint resolve to one identity.
 */
export const CLAUDE_PLAN_WINDOW_LABELS: Record<string, { label: string; windowMinutes: number }> = {
  five_hour: { label: "5-hour limit", windowMinutes: 300 },
  seven_day: { label: "Weekly limit", windowMinutes: 7 * 24 * 60 },
  seven_day_opus: { label: "Weekly Opus limit", windowMinutes: 7 * 24 * 60 },
  seven_day_oauth_apps: { label: "Weekly apps limit", windowMinutes: 7 * 24 * 60 },
};

/** The canonical window id for a Claude rate-limit label, when it is a known one. */
export function claudePlanWindowIdFromLabel(label: string): string | undefined {
  const normalized = label.trim().toLowerCase();
  for (const [id, meta] of Object.entries(CLAUDE_PLAN_WINDOW_LABELS)) {
    if (meta.label.toLowerCase() === normalized) return id;
  }
  return undefined;
}
