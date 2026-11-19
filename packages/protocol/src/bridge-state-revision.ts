/**
 * Bridge state revisions: the change signal between an HTTP bridge and the
 * backend (to-do 8102 task 2, design D7). Browser-safe: the wire shapes and
 * their bounded parsers. The bridge-side tracker and observe-stream hub are in
 * `@orkestrator/protocol/node/bridge-state-revision` and
 * `@orkestrator/protocol/node/bridge-observation-stream`.
 *
 * - **`stateRevision`** (`<bridge process generation>:<counter>`) is per
 *   session and moves on every change of anything the backend's state read
 *   returns: the state body and the side routes read with it (questions, plan
 *   approvals, interactions, approvals, Codex's `/config`, Pi's `/queue` and
 *   composer). The counter is process-wide, so a revision is never reused,
 *   even for a session the bounded tracker forgot.
 * - **`transcriptRevision`** is separate and opaque: it moves when the
 *   transcript route's answer would change, and can move while the state does
 *   not (and the reverse).
 * - **`composerRevision`** (Pi) is the composer's own revision inside the
 *   state body, so a state change that leaves the model list alone does not
 *   resend it.
 *
 * The state route answers `{ unchanged: true, stateRevision }` to a
 * `?knownStateRevision=` that is still current, and the backend then reads no
 * side route. A bridge that predates this ignores the query and answers the
 * full body without `stateRevision`, which the backend reads as before.
 */

/** The version a bridge's observe stream advertises in its `connected` frame. */
export const BRIDGE_STATE_REVISION_VERSION = 1;

/** Query parameter of the conditional state read. */
export const BRIDGE_KNOWN_STATE_REVISION_PARAM = "knownStateRevision";
/** Query parameter of Pi's conditional composer (state body field). */
export const BRIDGE_KNOWN_COMPOSER_REVISION_PARAM = "knownComposerRevision";

/** Longest revision either side accepts. */
export const BRIDGE_REVISION_MAX_LENGTH = 96;

/** `<generation>:<counter>`; the generation is a bridge process's own id. */
const STATE_REVISION = /^[A-Za-z0-9_.-]{1,64}:\d{1,16}$/;
/** Opaque but bounded and printable, without quote or backslash. */
const OPAQUE_REVISION = /^[\x21\x23-\x5b\x5d-\x7e]{1,96}$/;

/** The state route's answer to a still-current `knownStateRevision`. */
export interface BridgeStateUnchangedAnswer {
  unchanged: true;
  stateRevision: string;
}

/** The revisions an observe frame carries beside its session id. */
export interface BridgeObservationFrameRevisions {
  stateRevision?: string;
  transcriptRevision?: string;
}

export interface BridgeObservationFrame extends BridgeObservationFrameRevisions {
  sessionId?: string;
}

export function isBridgeStateRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= BRIDGE_REVISION_MAX_LENGTH &&
    STATE_REVISION.test(value)
  );
}

export function isBridgeOpaqueRevision(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_REVISION.test(value);
}

/** Whether a state route body is the `unchanged` answer. */
export function isBridgeStateUnchanged(body: unknown): body is BridgeStateUnchangedAnswer {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return record.unchanged === true && isBridgeStateRevision(record.stateRevision);
}

/**
 * An observe frame's `data`: the session first (the backend reads only a
 * bounded prefix), then the revisions. Never content.
 */
export function bridgeObservationFrameData(
  sessionId: string | undefined,
  revisions: BridgeObservationFrameRevisions = {},
): string {
  if (sessionId === undefined) return "{}";
  return JSON.stringify({
    sessionId,
    ...(isBridgeStateRevision(revisions.stateRevision)
      ? { stateRevision: revisions.stateRevision }
      : {}),
    ...(isBridgeOpaqueRevision(revisions.transcriptRevision)
      ? { transcriptRevision: revisions.transcriptRevision }
      : {}),
  });
}

/** Bytes of a frame's data the parser looks at. Ids and revisions fit well inside. */
export const BRIDGE_OBSERVATION_FRAME_PREFIX_BYTES = 2_048;
const FRAME_SESSION = /^\{"sessionId":"((?:[^"\\]|\\.){1,1024})"/;
const FRAME_STATE_REVISION = /"stateRevision":"([^"\\]{1,96})"/;
const FRAME_TRANSCRIPT_REVISION = /"transcriptRevision":"([^"\\]{1,96})"/;

/**
 * The session and revisions an observe frame names, from a bounded prefix of
 * its data. Anything shaped otherwise yields no session (which the backend
 * treats as "every session may have changed"); a malformed revision is
 * dropped, never trusted.
 */
export function parseBridgeObservationFrame(
  data: string | null | undefined,
): BridgeObservationFrame {
  if (!data) return {};
  const prefix = data.slice(0, BRIDGE_OBSERVATION_FRAME_PREFIX_BYTES);
  const match = FRAME_SESSION.exec(prefix);
  if (!match) return {};
  let sessionId: string;
  try {
    sessionId = JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return {};
  }
  const rest = prefix.slice(match[0].length);
  const state = FRAME_STATE_REVISION.exec(rest)?.[1];
  const transcript = FRAME_TRANSCRIPT_REVISION.exec(rest)?.[1];
  return {
    sessionId,
    ...(isBridgeStateRevision(state) ? { stateRevision: state } : {}),
    ...(isBridgeOpaqueRevision(transcript) ? { transcriptRevision: transcript } : {}),
  };
}

/**
 * The revision contract version a `connected` frame advertises
 * (`"revisions": 1`), or 0 for a bridge that predates it. Bounded: a
 * `connected` frame is a few hundred bytes.
 */
export function bridgeObservationRevisionVersion(connectedData: string | null | undefined): number {
  if (!connectedData || connectedData.length > 4_096) return 0;
  try {
    const parsed = JSON.parse(connectedData) as { revisions?: unknown };
    return typeof parsed.revisions === "number" &&
      Number.isSafeInteger(parsed.revisions) &&
      parsed.revisions > 0
      ? parsed.revisions
      : 0;
  } catch {
    return 0;
  }
}
