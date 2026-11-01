import type { AgentMailSummarySnapshot } from "@orkestrator/protocol/agent-mail";
import { isWorkingBuildPipeline, type BuildPhase } from "@orkestrator/protocol/build-pipeline";
import { MAX_SUMMARY_MAIL_COUNT } from "@orkestrator/protocol/node-summaries";

export interface EnvironmentMailMarkers {
  agentMailUnread?: number;
  agentMailFailed?: true;
}

/**
 * Per-environment agent-mail markers for a node summary, counted exactly as
 * the machine's own sidebar row counts them (`userUnseenCount`, falling back
 * to `unreadCount`, and any failed injection), so another machine's row shows
 * the same badge. Counts only: no message, subject or sender leaves the node.
 */
export function environmentMailMarkers(
  summary: AgentMailSummarySnapshot,
): Map<string, EnvironmentMailMarkers> {
  const totals = new Map<string, { unread: number; failed: boolean }>();
  for (const mailbox of summary.mailboxes) {
    const total = totals.get(mailbox.environmentId) ?? { unread: 0, failed: false };
    total.unread += mailbox.userUnseenCount ?? mailbox.unreadCount;
    total.failed ||= mailbox.failedInjectCount > 0;
    totals.set(mailbox.environmentId, total);
  }
  const markers = new Map<string, EnvironmentMailMarkers>();
  for (const [environmentId, total] of totals) {
    const unread = Math.min(Math.max(0, Math.trunc(total.unread)), MAX_SUMMARY_MAIL_COUNT);
    if (unread === 0 && !total.failed) continue;
    markers.set(environmentId, {
      ...(unread > 0 ? { agentMailUnread: unread } : {}),
      ...(total.failed ? { agentMailFailed: true as const } : {}),
    });
  }
  return markers;
}

/**
 * Whether a persisted pipeline record is working, by the same rule the
 * machine's own sidebar applies to its pipeline snapshots
 * (`isWorkingBuildPipeline`). A record whose snapshot has no phase is not.
 */
export function isWorkingPipelineRecord(record: { snapshot: unknown }): boolean {
  const snapshot = record.snapshot as { phase?: unknown; stallWarning?: unknown } | null;
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.phase !== "string") return false;
  return isWorkingBuildPipeline({
    phase: snapshot.phase as BuildPhase,
    stallWarning:
      snapshot.stallWarning === undefined
        ? undefined
        : (snapshot.stallWarning as { sessionId: string; detectedAt: string }),
  });
}
