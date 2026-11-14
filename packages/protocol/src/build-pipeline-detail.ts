/**
 * The heavy, slow-changing part of a build pipeline control record ("detail").
 *
 * A pipeline's control record is rewritten every few seconds while a
 * transcript streams (each checkpoint moves a session's transcript cursor),
 * but most of its bytes are reports and inputs that change a handful of times
 * per run: review reports, the structured review, the validation run, key
 * information, the task snapshot. Measured on 2026-11-14 across six completed
 * pipelines (122–212 KB records), these fields were 75–85% of every record.
 *
 * `get_build_pipeline` accepts the detail fingerprint a renderer holds and,
 * when it still matches, answers the record without these fields
 * (`detailOmitted`). The renderer merges the detail it holds back in, so its
 * store still holds the complete record. Everything else that reads a
 * pipeline (coordinator tools, node forwarding, scoped snapshots, list
 * summaries, action responses) keeps receiving the full record.
 *
 * The lists decide only what is cheap to skip, never what is correct: any
 * listed field is covered by the fingerprint, so a change to it always
 * reaches the renderer on its next read.
 */

/** Top-level snapshot fields that make up a pipeline's detail. */
export const BUILD_PIPELINE_DETAIL_FIELDS = [
  "taskSnapshot",
  "reviewPackage",
  "structuredReview",
  "validationRun",
  "validationHistory",
  "roundReviewReports",
  "keyInformation",
  "verificationFeedback",
  "reviewFanout",
  "rewinds",
  "activePromptContext",
] as const;

/** Per-session fields that make up a pipeline's detail. */
export const BUILD_PIPELINE_SESSION_DETAIL_FIELDS = [
  "reviewReport",
  "fixResult",
  "acceptanceCriteriaResults",
  "verificationFeedback",
  "interactionTranscript",
  "sessionlessReviewers",
  "interactionPolicy",
  "reviewWorkspaceBaseline",
  "validationUncommittedPathsAtStart",
  "rewinds",
] as const;

/**
 * The detail of one snapshot: the listed top-level fields that are present,
 * and, in session order, each session (by key) that has any listed field.
 * Its JSON is what the backend fingerprints.
 */
export interface BuildPipelineDetail {
  fields: Record<string, unknown>;
  sessions: Array<[sessionKey: string, fields: Record<string, unknown>]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

/**
 * The detail of `snapshot`, or `null` when it cannot be split exactly: not an
 * object, a malformed session list, or two sessions sharing a key (the
 * merge addresses sessions by key). A `null` detail is never omitted.
 *
 * Values are the snapshot's own objects, not copies.
 */
export function extractBuildPipelineDetail(snapshot: unknown): BuildPipelineDetail | null {
  if (!isRecord(snapshot)) return null;
  const sessions: BuildPipelineDetail["sessions"] = [];
  if (snapshot.sessions !== undefined) {
    if (!Array.isArray(snapshot.sessions)) return null;
    const seen = new Set<string>();
    for (const session of snapshot.sessions as unknown[]) {
      if (!isRecord(session) || typeof session.sessionKey !== "string") return null;
      if (seen.has(session.sessionKey)) return null;
      seen.add(session.sessionKey);
      const fields = pick(session, BUILD_PIPELINE_SESSION_DETAIL_FIELDS);
      if (Object.keys(fields).length > 0) sessions.push([session.sessionKey, fields]);
    }
  }
  return { fields: pick(snapshot, BUILD_PIPELINE_DETAIL_FIELDS), sessions };
}

/** `snapshot` without its detail fields (a shallow copy; `snapshot` is untouched). */
export function omitBuildPipelineDetail<T>(snapshot: T): T {
  if (!isRecord(snapshot)) return snapshot;
  const copy: Record<string, unknown> = { ...snapshot };
  for (const key of BUILD_PIPELINE_DETAIL_FIELDS) delete copy[key];
  if (Array.isArray(snapshot.sessions)) {
    copy.sessions = (snapshot.sessions as unknown[]).map((session) => {
      if (!isRecord(session)) return session;
      if (!BUILD_PIPELINE_SESSION_DETAIL_FIELDS.some((key) => Object.hasOwn(session, key))) {
        return session;
      }
      const bare: Record<string, unknown> = { ...session };
      for (const key of BUILD_PIPELINE_SESSION_DETAIL_FIELDS) delete bare[key];
      return bare;
    });
  }
  return copy as T;
}

/**
 * Puts `detail` back into a snapshot that was sent without it. Returns `null`
 * when `detail` names a session the snapshot does not have, which means the
 * detail does not belong to this snapshot.
 */
export function mergeBuildPipelineDetail<T>(snapshot: T, detail: BuildPipelineDetail): T | null {
  if (!isRecord(snapshot)) return null;
  const bySession = new Map(detail.sessions);
  const sessions = snapshot.sessions;
  if (bySession.size > 0 && !Array.isArray(sessions)) return null;
  let matched = 0;
  const merged: Record<string, unknown> = { ...snapshot, ...detail.fields };
  if (Array.isArray(sessions)) {
    merged.sessions = (sessions as unknown[]).map((session) => {
      if (!isRecord(session) || typeof session.sessionKey !== "string") return session;
      const fields = bySession.get(session.sessionKey);
      if (!fields) return session;
      matched += 1;
      return { ...session, ...fields };
    });
  }
  return matched === bySession.size ? (merged as T) : null;
}
