/**
 * Small readers every status reduction in `coordinator-status-wakes.ts` and
 * `coordinator-build-pipeline-status.ts` shares. Snapshots may come from
 * another node or an older record, so every read is defensive.
 */
import { createHash } from "node:crypto";

/** Detail lines a status notice carries; the rest is a tool read away. */
export const MAX_DETAILS = 8;

export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export interface StalledSession {
  key: string;
  label: string;
  since: string;
}

/** The earliest running session that has produced nothing for too long. */
export function stalledSession(candidates: Array<[string, unknown]>): StalledSession | null {
  let earliest: StalledSession | null = null;
  for (const [label, session] of candidates) {
    if (!record(session)) continue;
    const since = text(session.stalledSince);
    if (!since) continue;
    if (session.status !== undefined && session.status !== "running") continue;
    const key = text(session.sessionKey) ?? text(session.id) ?? label;
    if (!earliest || since < earliest.since) earliest = { key, label, since };
  }
  return earliest;
}
