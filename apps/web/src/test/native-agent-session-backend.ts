/**
 * A fake native-agent session backend for UI suites: the progressive reads
 * `useNativeAgentSession` issues, answered from one whole projection the test
 * controls. Not bundled: only tests import this.
 *
 * The renderer reads sessions only through projection sync v1 with
 * progressive views v1 (transcript, session state and discovery as separate
 * domains, see `docs/architecture/version-compatibility.md`). A suite about
 * the composer, approvals or steering does not care how a projection is split
 * across those domains, so it describes the session as one
 * `NativeAgentSessionProjection` (or `null` for "no session") and this fake
 * splits it the way the backend does:
 *
 * - transcript: `messages`, `messageWindow` and `title`;
 * - discovery: `slashCommands`/`slashCommandCatalogue` and `runtime`;
 * - session state: everything else (`turn`, `interactions`, `composer`,
 *   `queue`, `notices`, …).
 *
 * Rows from before the live tail come from the optional `readHistory`. When it
 * returns any, the transcript reports earlier messages without naming a
 * cursor, so they stay behind "Load earlier messages" (a direct cursor would
 * page them in as the tab opens). A click mints a cursor through the joined
 * snapshot and `getNativeAgentMessagePage` pages through them.
 *
 * Every domain answers `unchanged` against a token that names its current
 * content, so polls of an unchanged session transfer nothing, exactly as a
 * real backend's would. The projection is read once per read round: the
 * transcript, state and discovery requests one refresh issues together share a
 * single `readProjection` call, so a suite can still count reads or hold one
 * open with a deferred promise.
 *
 * Usage, inside a suite's `mock.module("@/lib/backend", …)`:
 *
 * ```ts
 * const sessionProjectionMock = mock(defaultProjection);
 * const sessionBackend = createNativeAgentSessionBackend({ readProjection: sessionProjectionMock });
 * mock.module("@/lib/backend", () => ({ ...realBackendSnapshot, ...sessionBackend.api }));
 * ```
 *
 * Each `api` entry is a `mock()`, so a suite can assert on the reads it made
 * (`sessionBackend.api.getNativeAgentMessagePage`) and `reset()` clears them.
 */
import { mock } from "bun:test";
import {
  NATIVE_AGENT_LIVE_UPDATE_VERSION,
  type NativeAgentMessagePage,
  type NativeAgentDiscoveryUpdate,
  type NativeAgentDiscoveryView,
  type NativeAgentLiveUpdate,
  type NativeAgentProjectionUpdate,
  type NativeAgentSessionProjection,
  type NativeAgentSessionStateUpdate,
  type NativeAgentSessionStateView,
  type NativeAgentTranscriptUpdate,
  type NativeAgentTranscriptView,
  type NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { NATIVE_AGENT_OBSERVATION_EVENT_VERSION } from "@orkestrator/protocol/native-agent-observation";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "@orkestrator/protocol/native-agent-transcript-patch";

/** Which session a read names: what every session command carries. */
export interface NativeAgentSessionReadInput {
  environmentId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
}

/** The session as the test describes it; `null` when it does not exist. */
export type NativeAgentSessionProjectionSource = (
  input: NativeAgentSessionReadInput,
) =>
  | NativeAgentSessionProjection<unknown>
  | null
  | Promise<NativeAgentSessionProjection<unknown> | null>;

/** Rows from before the projection's live tail, oldest first. */
export type NativeAgentSessionHistorySource = (
  input: NativeAgentSessionReadInput,
) => readonly unknown[] | Promise<readonly unknown[]>;

export interface NativeAgentSessionBackendOptions {
  readProjection: NativeAgentSessionProjectionSource;
  /** Earlier rows "Load earlier messages" pages in. None by default. */
  readHistory?: NativeAgentSessionHistorySource;
  /**
   * Optional protocol features to advertise beyond the floor every supported
   * backend speaks (sync v1, history paging v1, progressive views v1). Off by
   * default, so a suite opts into combined live reads or stamped observation
   * announcements only when it tests them.
   */
  capabilities?: {
    liveUpdate?: boolean;
    observationEvents?: boolean;
    transcriptPatches?: boolean;
  };
}

/** The history epoch every transcript view and joined snapshot names. */
export const FAKE_NATIVE_AGENT_HISTORY_EPOCH = "fake-history-epoch";
/** The backend instance every view identity names. */
export const FAKE_NATIVE_AGENT_BACKEND_ID = "fake-backend";

/** Projection fields the transcript and discovery domains carry, or no domain does. */
const NON_STATE_FIELDS = new Set<string>([
  "platform",
  "environmentId",
  "sessionId",
  "messages",
  "messageWindow",
  "revision",
  "generation",
  "cursor",
  "runtime",
  "slashCommands",
  "slashCommandCatalogue",
  "turnBoundaries",
  "suborks",
]);

/** A short content hash: tokens only need to change when content does. */
function contentToken(domain: string, value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return `${domain}:${hash.toString(36)}:${text.length.toString(36)}`;
}

function readKey(input: NativeAgentSessionReadInput): string {
  return `${input.environmentId}\u0000${input.agent}\u0000${input.logicalSessionKey}`;
}

export function fakeNativeAgentViewIdentity(
  input: NativeAgentSessionReadInput,
  projection: NativeAgentSessionProjection<unknown>,
): NativeAgentViewIdentity {
  return {
    backendInstanceId: FAKE_NATIVE_AGENT_BACKEND_ID,
    environmentId: input.environmentId,
    platform: input.agent,
    logicalSessionKey: input.logicalSessionKey,
    providerSessionId: projection.sessionId ?? "",
    sourceGeneration: projection.generation,
  };
}

const HISTORY_CURSOR_PREFIX = "fake-history:";

/** The cursor naming every history row before index `end`. */
function historyCursor(end: number): string {
  return `${HISTORY_CURSOR_PREFIX}${end}`;
}

/**
 * The transcript domain of `projection`, as the backend would send it. With
 * `historyRows` earlier rows exist: the view reports them, pageable through
 * the joined snapshot's cursor.
 */
export function fakeNativeAgentTranscriptView(
  input: NativeAgentSessionReadInput,
  projection: NativeAgentSessionProjection<unknown>,
  historyRows = 0,
): NativeAgentTranscriptView<unknown> {
  const messageWindow =
    historyRows > 0
      ? {
          limit: projection.messages.length,
          truncated: true,
          truncationReason: "count" as const,
          canLoadEarlier: true,
          ...projection.messageWindow,
        }
      : projection.messageWindow;
  return {
    identity: fakeNativeAgentViewIdentity(input, projection),
    freshness: projection.messages.length === 0 ? "empty" : "current",
    messages: projection.messages,
    ...(messageWindow ? { messageWindow } : {}),
    ...(projection.title ? { title: projection.title } : {}),
    historyEpoch: FAKE_NATIVE_AGENT_HISTORY_EPOCH,
    historyComplete: historyRows === 0 && projection.messageWindow?.truncated !== true,
  };
}

/** The session-state domain of `projection`: every action-critical field. */
export function fakeNativeAgentSessionStateView(
  input: NativeAgentSessionReadInput,
  projection: NativeAgentSessionProjection<unknown>,
): NativeAgentSessionStateView {
  const state: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(projection)) {
    if (!NON_STATE_FIELDS.has(key) && value !== undefined) state[key] = value;
  }
  return {
    ...(state as unknown as Omit<NativeAgentSessionStateView, "identity" | "notices">),
    identity: fakeNativeAgentViewIdentity(input, projection),
    notices: projection.notices ?? [],
  };
}

/** The discovery domain of `projection`: commands and the runtime summary. */
export function fakeNativeAgentDiscoveryView(
  input: NativeAgentSessionReadInput,
  projection: NativeAgentSessionProjection<unknown>,
): NativeAgentDiscoveryView {
  const sections: NativeAgentDiscoveryView["sections"] = {};
  if (projection.slashCommands || projection.slashCommandCatalogue) {
    sections.commands = {
      availability: projection.slashCommands ? "ready" : "loading",
      ...(projection.slashCommands ? { value: projection.slashCommands } : {}),
      revision: 1,
      ...(projection.slashCommandCatalogue ? { catalogue: projection.slashCommandCatalogue } : {}),
    };
  }
  if (projection.runtime) {
    const { notices, mcp, mcpServers: _mcpServers, ...summary } = projection.runtime;
    sections.runtime = {
      availability: "ready",
      value: { summary, notices: notices ?? [] },
      revision: 1,
    };
    if (mcp) sections.mcp = { availability: "ready", value: mcp, revision: 1 };
  }
  return { identity: fakeNativeAgentViewIdentity(input, projection), sections };
}

type DomainRead = { knownToken?: string; forceSnapshot?: boolean };

function domainUpdate<T extends { identity: NativeAgentViewIdentity }>(
  domain: string,
  value: T,
  request: DomainRead,
):
  | { viewVersion: 1; status: "snapshot"; token: string; value: T }
  | { viewVersion: 1; status: "unchanged"; token: string; identity: NativeAgentViewIdentity } {
  const token = contentToken(domain, value);
  if (!request.forceSnapshot && request.knownToken === token) {
    return { viewVersion: 1, status: "unchanged", token, identity: value.identity };
  }
  return { viewVersion: 1, status: "snapshot", token, value };
}

type ReadInput<T = object> = NativeAgentSessionReadInput & T;

export type NativeAgentSessionBackend = ReturnType<typeof createNativeAgentSessionBackend>;

export function createNativeAgentSessionBackend(options: NativeAgentSessionBackendOptions) {
  /** One projection read per session per synchronous read round. */
  const round = new Map<string, Promise<NativeAgentSessionProjection<unknown> | null>>();
  const read = (input: NativeAgentSessionReadInput) => {
    const key = readKey(input);
    const held = round.get(key);
    if (held) return held;
    let pending: Promise<NativeAgentSessionProjection<unknown> | null>;
    try {
      pending = Promise.resolve(
        options.readProjection({
          environmentId: input.environmentId,
          agent: input.agent,
          logicalSessionKey: input.logicalSessionKey,
        }),
      );
    } catch (error) {
      pending = Promise.reject(error);
    }
    if (round.size === 0) queueMicrotask(() => round.clear());
    round.set(key, pending);
    return pending;
  };

  const history = async (input: NativeAgentSessionReadInput) =>
    options.readHistory ? await options.readHistory(input) : [];

  const transcript = async (
    input: ReadInput<DomainRead>,
  ): Promise<NativeAgentTranscriptUpdate<unknown>> => {
    const [projection, rows] = await Promise.all([read(input), history(input)]);
    if (!projection) return { viewVersion: 1, status: "missing" };
    return domainUpdate(
      "transcript",
      fakeNativeAgentTranscriptView(input, projection, rows.length),
      input,
    );
  };
  const state = async (input: ReadInput<DomainRead>): Promise<NativeAgentSessionStateUpdate> => {
    const projection = await read(input);
    if (!projection) return { viewVersion: 1, status: "missing" };
    return domainUpdate("state", fakeNativeAgentSessionStateView(input, projection), input);
  };

  const api = {
    getNativeAgentSyncCapabilities: mock(async () => ({
      projectionSyncVersions: [1],
      historyPagingVersions: [1],
      progressiveViewVersions: [1],
      ...(options.capabilities?.observationEvents
        ? { observationEventVersions: [NATIVE_AGENT_OBSERVATION_EVENT_VERSION] }
        : {}),
      ...(options.capabilities?.transcriptPatches
        ? { transcriptPatchVersions: [NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION] }
        : {}),
      ...(options.capabilities?.liveUpdate
        ? { liveUpdateVersions: [NATIVE_AGENT_LIVE_UPDATE_VERSION] }
        : {}),
    })),
    getNativeAgentTranscriptUpdate: mock(transcript),
    getNativeAgentSessionStateUpdate: mock(state),
    getNativeAgentDiscoveryUpdate: mock(
      async (input: ReadInput<DomainRead>): Promise<NativeAgentDiscoveryUpdate> => {
        const projection = await read(input);
        if (!projection) return { viewVersion: 1, status: "missing" };
        return domainUpdate("discovery", fakeNativeAgentDiscoveryView(input, projection), input);
      },
    ),
    getNativeAgentLiveUpdate: mock(
      async (
        input: ReadInput<{ transcriptToken?: string; stateToken?: string }>,
      ): Promise<NativeAgentLiveUpdate<unknown>> => {
        const [transcriptUpdate, stateUpdate] = await Promise.all([
          transcript({ ...input, knownToken: input.transcriptToken }),
          state({ ...input, knownToken: input.stateToken }),
        ]);
        return {
          viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION,
          transcript: transcriptUpdate,
          state: stateUpdate,
        };
      },
    ),
    /*
     * The joined snapshot "load earlier" mints a cursor from when the live
     * tail names none: a cursor to the history rows, or none without any.
     */
    getNativeAgentProjectionUpdate: mock(
      async (input: ReadInput): Promise<NativeAgentProjectionUpdate<unknown>> => {
        const [projection, rows] = await Promise.all([read(input), history(input)]);
        if (!projection) return { syncVersion: 1, status: "missing" };
        return {
          syncVersion: 1,
          status: "snapshot",
          token: contentToken("projection", projection),
          projection,
          ...(rows.length > 0 ? { historyCursor: historyCursor(rows.length) } : {}),
          historyEpoch: FAKE_NATIVE_AGENT_HISTORY_EPOCH,
          historyComplete: rows.length === 0,
        };
      },
    ),
    getNativeAgentMessagePage: mock(
      async (
        input: ReadInput<{ before: string; limit?: number }>,
      ): Promise<NativeAgentMessagePage<unknown>> => {
        const rows = await history(input);
        const end = input.before.startsWith(HISTORY_CURSOR_PREFIX)
          ? Math.min(rows.length, Number(input.before.slice(HISTORY_CURSOR_PREFIX.length)))
          : Number.NaN;
        if (!Number.isInteger(end) || end < 0) throw new Error(`Unknown cursor ${input.before}`);
        const start = Math.max(0, end - (input.limit ?? end));
        return {
          syncVersion: 1,
          messages: rows.slice(start, end),
          historyEpoch: FAKE_NATIVE_AGENT_HISTORY_EPOCH,
          ...(start > 0 ? { nextCursor: historyCursor(start) } : {}),
          complete: true,
          truncated: start > 0,
        };
      },
    ),
  };

  return {
    api,
    /** Forget recorded calls (the answers stay as configured). */
    reset() {
      for (const entry of Object.values(api)) entry.mockClear();
    },
  };
}
