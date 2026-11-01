/**
 * Dismissals of backend-sent notices (native agent notices, coordinator
 * repository-context notices), stored by the backend so a notice dismissed on
 * one client stays dismissed on every client.
 *
 * A dismissal is keyed by a session identity (the client's composite of
 * platform, environment and provider session) and a notice occurrence id.
 * Both dimensions are bounded; the oldest sessions age out first. A
 * reconcile drops dismissals of notices the authoritative snapshot no longer
 * carries, so a recurrence of the same condition surfaces again.
 * Browser-safe.
 */

export const NOTICE_DISMISSAL_LIMITS = Object.freeze({
  sessions: 200,
  occurrencesPerSession: 20,
  identityChars: 1024,
  occurrenceChars: 2048,
  /** Sessions one import or dismiss request may name. */
  sessionsPerRequest: 200,
});

export interface NoticeDismissalSession {
  sessionIdentity: string;
  occurrenceIds: string[];
}

export function isNoticeSessionIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= NOTICE_DISMISSAL_LIMITS.identityChars
  );
}

export function isNoticeOccurrenceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= NOTICE_DISMISSAL_LIMITS.occurrenceChars
  );
}

/** Bounded, de-duplicated sessions from an untrusted value; later entries win. */
export function normalizeNoticeDismissalSessions(value: unknown): NoticeDismissalSession[] {
  if (!Array.isArray(value)) return [];
  const byIdentity = new Map<string, string[]>();
  for (const entry of value.slice(-NOTICE_DISMISSAL_LIMITS.sessionsPerRequest)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!isNoticeSessionIdentity(record.sessionIdentity)) continue;
    if (!Array.isArray(record.occurrenceIds)) continue;
    const occurrenceIds = Array.from(
      new Set(record.occurrenceIds.filter(isNoticeOccurrenceId)),
    ).slice(-NOTICE_DISMISSAL_LIMITS.occurrencesPerSession);
    byIdentity.delete(record.sessionIdentity);
    byIdentity.set(record.sessionIdentity, occurrenceIds);
  }
  return Array.from(byIdentity, ([sessionIdentity, occurrenceIds]) => ({
    sessionIdentity,
    occurrenceIds,
  }));
}

/** The stored dismissals, newest-touched session last, with a revision that moves on every change. */
export interface NoticeDismissalSnapshot {
  revision: number;
  sessions: NoticeDismissalSession[];
}

export function parseNoticeDismissalSnapshot(value: unknown): NoticeDismissalSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) return null;
  return {
    revision: record.revision as number,
    sessions: normalizeNoticeDismissalSessions(record.sessions),
  };
}
