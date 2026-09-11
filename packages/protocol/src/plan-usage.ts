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
