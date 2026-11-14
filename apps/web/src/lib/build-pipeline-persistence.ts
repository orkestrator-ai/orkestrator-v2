import {
  extractBuildPipelineDetail,
  mergeBuildPipelineDetail,
  type BuildPipelineDetail,
} from "@orkestrator/protocol/build-pipeline-detail";
import { backfillLegacyTestResults } from "@orkestrator/protocol/structured-review";
import { canonicalBuildPipeline } from "@orkestrator/protocol/workflow-vocabulary";
import type { StoreApi } from "zustand/vanilla";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createWorkflowsApi } from "@/lib/backend/workflows";
import { hydrationActivity } from "@/lib/hydration-activity";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import {
  BUILD_PIPELINE_VERSION,
  buildPipelineStore,
  isBuildPipeline,
  type BuildPipeline,
  type BuildPipelineState,
} from "@/stores/buildPipelineStore";
import type { PersistedBuildPipeline } from "@/types";

export { isBuildPipeline } from "@/stores/buildPipelineStore";

type PipelineLoader = (pipelineId: string) => Promise<PersistedBuildPipeline<BuildPipeline> | null>;
type PipelineListLoader = (
  projectId: string,
) => Promise<Array<PersistedBuildPipeline<BuildPipeline>>>;

/**
 * Every function here acts on one node's pipelines: the `scope` it is given,
 * or the app's command scope when it is given none (callers with no scope
 * yet). Pipeline ids belong to one node, so the hydration markers, the
 * unavailable markers, the watched transcripts and the reads in flight are
 * held per scope (plan item 3011).
 */

/** `scope`'s pipeline reads: the suites' mocked named exports on the app's command scope. */
function pipelineReadsApi(scope: NodeScope) {
  return backendApiForScope(scope, createWorkflowsApi, {
    getBuildPipeline: backend.getBuildPipeline,
    getBuildPipelineConditional: backend.getBuildPipelineConditional,
    getBuildPipelineControl: backend.getBuildPipelineControl,
    listBuildPipelinesConditional: backend.listBuildPipelinesConditional,
  });
}

const MAX_PIPELINE_HYDRATION_MARKERS = 2_048;
const MAX_PROJECT_HYDRATION_MARKERS = 512;
/**
 * Held details, by pipeline. A miss costs one full record, never a wrong
 * one. The values are the store's own objects most of the time, so an entry
 * mostly costs a reference.
 */
const MAX_HELD_DETAILS = 256;

/** The detail of the last full record a point read received, and its fingerprint. */
interface HeldDetail {
  fingerprint: string;
  detail: BuildPipelineDetail;
}

type PipelineRead = {
  /** Settles when the read in flight does. */
  settled: Promise<void>;
  /** The one follow-up read every caller that arrived meanwhile shares. */
  queued: { options: HydrateBuildPipelineOptions; result: Promise<BuildPipeline | null> } | null;
};

interface BuildPipelinePersistenceState {
  /** The last hydration generation handed out on this node. */
  hydrationGeneration: number;
  readonly pipelineHydrationGenerations: Map<string, number>;
  readonly projectHydrationGenerations: Map<string, number>;
  readonly pipelineDeletionGenerations: Map<string, number>;
  /**
   * Pipelines whose last point read found no usable record: deleted, or
   * failing validation in this client. Pane-layout restore skips them, so a
   * Build or key-information tab left pointing at a finished pipeline is not
   * fetched again on every layout change. A change event for the id still
   * reads it, and any read that finds a record clears the marker. Bounded
   * like the hydration markers.
   */
  readonly unavailablePipelines: Set<string>;
  /** Transcript views on screen, by pipeline: their session keys, newest last. */
  readonly watchedTranscripts: Map<string, string[]>;
  /** Point reads in flight, by pipeline. */
  readonly pipelineReads: Map<string, PipelineRead>;
  /**
   * The detail (heavy, slow-changing fields) each pipeline's point reads last
   * received whole, so the next read can name its fingerprint and be answered
   * without it (`@orkestrator/protocol/build-pipeline-detail`).
   */
  readonly heldDetails: Map<string, HeldDetail>;
}

const persistenceState = defineScopedSlot<BuildPipelinePersistenceState>(
  "build-pipeline-persistence",
  () => ({
    hydrationGeneration: 0,
    pipelineHydrationGenerations: new Map(),
    projectHydrationGenerations: new Map(),
    pipelineDeletionGenerations: new Map(),
    unavailablePipelines: new Set(),
    watchedTranscripts: new Map(),
    pipelineReads: new Map(),
    heldDetails: new Map(),
  }),
);

function nextHydrationGeneration(state: BuildPipelinePersistenceState): number {
  state.hydrationGeneration += 1;
  return state.hydrationGeneration;
}

function setBoundedGeneration(
  generations: Map<string, number>,
  key: string,
  value: number,
  limit: number,
): void {
  generations.delete(key);
  generations.set(key, value);
  while (generations.size > limit) {
    const oldest = generations.keys().next().value;
    if (oldest === undefined) break;
    generations.delete(oldest);
  }
}

function markPipelineUnavailable(unavailablePipelines: Set<string>, pipelineId: string): void {
  unavailablePipelines.delete(pipelineId);
  unavailablePipelines.add(pipelineId);
  while (unavailablePipelines.size > MAX_PIPELINE_HYDRATION_MARKERS) {
    const oldest = unavailablePipelines.values().next().value;
    if (oldest === undefined) break;
    unavailablePipelines.delete(oldest);
  }
}

/** Whether the last point read of `pipelineId` on `scope`'s node found no usable record. */
export function isBuildPipelineKnownUnavailable(
  pipelineId: string,
  scope: NodeScope = appCommandScope(),
): boolean {
  return persistenceState(scope).unavailablePipelines.has(pipelineId);
}

/** Test seam: forget every unavailable marker of `scope`'s node. */
export function resetBuildPipelineUnavailableMarkersForTests(
  scope: NodeScope = appCommandScope(),
): void {
  persistenceState(scope).unavailablePipelines.clear();
}

function toSnapshot(persisted: PersistedBuildPipeline<BuildPipeline>): BuildPipeline | null {
  // Older remote backends cannot run the storage migration. Backfill only the
  // historical field here; strict pipeline validation still rejects bad reports.
  const raw = canonicalBuildPipeline(persisted.snapshot);
  const snapshot: unknown =
    raw && typeof raw === "object" && raw.structuredReview
      ? { ...raw, structuredReview: backfillLegacyTestResults(raw.structuredReview) }
      : raw;
  if (
    persisted.version !== BUILD_PIPELINE_VERSION ||
    !Number.isSafeInteger(persisted.revision) ||
    persisted.revision < 1 ||
    typeof persisted.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(persisted.updatedAt)) ||
    !isBuildPipeline(snapshot) ||
    snapshot.id !== persisted.id ||
    snapshot.projectId !== persisted.projectId ||
    snapshot.environmentId !== persisted.environmentId
  ) {
    return null;
  }
  return {
    ...snapshot,
    backendRevision: persisted.revision,
    controller: "backend",
  };
}

/**
 * Renderer-only transcript state carried on a cached session.
 *
 * The backend's control record says which transcript revision is committed
 * (`messageRevision`) and references the stored body; it never embeds it.
 * The renderer attaches the body it fetched as `messages` and remembers which
 * revision that body is, so a newer committed revision is detectable.
 */
interface LoadedTranscriptState {
  loadedMessageRevision?: number;
  transcriptUnavailable?: boolean;
}

type CachedSession = BuildPipeline["sessions"][number] & LoadedTranscriptState;

function loadedRevision(session: CachedSession): number | undefined {
  if (session.messages === undefined) return undefined;
  return session.loadedMessageRevision ?? session.messageRevision ?? 0;
}

/** The transcript cursor a cached session can offer the backend, if it holds a body. */
function transcriptCursor(session: CachedSession): { revision: number; count: number } | null {
  const revision = loadedRevision(session);
  return revision === undefined || !session.messages
    ? null
    : { revision, count: session.messages.length };
}

/** True when the backend has committed transcript content this cached session does not hold. */
export function isBuildPipelineTranscriptStale(
  session: BuildPipeline["sessions"][number] | undefined,
): boolean {
  if (!session) return false;
  const cached = session as CachedSession;
  const committed = cached.messageRevision ?? 0;
  if (cached.messages === undefined) {
    return committed > 0 || (cached.transcript?.messageCount ?? 0) > 0;
  }
  return (
    loadedRevision(cached) !== committed ||
    (cached.transcript !== undefined && cached.messages.length < cached.transcript.messageCount)
  );
}

/** True when the backend reported this session's stored transcript unreadable. */
export function isBuildPipelineTranscriptUnavailable(
  session: BuildPipeline["sessions"][number] | undefined,
): boolean {
  return Boolean((session as CachedSession | undefined)?.transcriptUnavailable);
}

/** Keeps the body (and its revision) this renderer already holds for a session. */
function carryTranscript(local: CachedSession | undefined): LoadedTranscriptState & {
  messages?: unknown[];
} {
  if (!local || local.messages === undefined) return {};
  return { messages: local.messages, loadedMessageRevision: loadedRevision(local) };
}

/**
 * Merges a body-free record (a project list entry, or a plain point read)
 * with the transcript bodies this renderer already holds. A session whose
 * committed revision moved on keeps its old body and old loaded revision, so
 * it reads as stale and the next conditional point read patches it.
 */
function withLocalTranscripts(
  persisted: PersistedBuildPipeline<BuildPipeline> | null,
  local: BuildPipeline | undefined,
): PersistedBuildPipeline<BuildPipeline> | null {
  if (!persisted || !local || !persisted.snapshot || !Array.isArray(persisted.snapshot.sessions)) {
    return persisted;
  }
  const localSessions = new Map<string, CachedSession>(
    local.sessions.map((session) => [session.sessionKey, session]),
  );
  return {
    ...persisted,
    snapshot: {
      ...persisted.snapshot,
      sessions: persisted.snapshot.sessions.map((session) =>
        // A legacy backend still embeds bodies; those are authoritative.
        session.messages !== undefined
          ? session
          : { ...session, ...carryTranscript(localSessions.get(session.sessionKey)) },
      ),
    },
  };
}

type ConditionalPipelineRead = Extract<
  backend.ConditionalBuildPipeline<BuildPipeline>,
  { unchanged: false }
>;

function applyMessagePatches(
  loaded: ConditionalPipelineRead,
  localSessions: Map<string, CachedSession>,
): PersistedBuildPipeline<BuildPipeline> {
  const patches = new Map(loaded.messagePatches.map((patch) => [patch.sessionKey, patch]));
  return {
    ...loaded.record,
    snapshot: {
      ...loaded.record.snapshot,
      sessions: loaded.record.snapshot.sessions.map((session) => {
        const patch = patches.get(session.sessionKey);
        const local = localSessions.get(session.sessionKey);
        // No patch: what this renderer holds is current. Deferred: over the
        // response budget, fetched by a later read. Either way keep it.
        if (!patch || patch.deferred) return { ...session, ...carryTranscript(local) };
        if (patch.unavailable) {
          return { ...session, ...carryTranscript(local), transcriptUnavailable: true };
        }
        const localMessages = local?.messages;
        const canApply =
          local !== undefined &&
          localMessages !== undefined &&
          patch.baseRevision === loadedRevision(local) &&
          patch.baseCount === localMessages.length &&
          patch.startIndex >= 0 &&
          patch.startIndex <= localMessages.length;
        const messages = canApply
          ? [...localMessages.slice(0, patch.startIndex), ...patch.messages]
          : patch.startIndex === 0
            ? patch.messages
            : undefined;
        return messages
          ? { ...session, messages, loadedMessageRevision: patch.revision }
          : { ...session };
      }),
    },
  };
}

type PointRead = backend.ConditionalBuildPipeline<BuildPipeline>;

function holdDetail(state: BuildPipelinePersistenceState, pipelineId: string, held: HeldDetail) {
  const { heldDetails } = state;
  heldDetails.delete(pipelineId);
  heldDetails.set(pipelineId, held);
  while (heldDetails.size > MAX_HELD_DETAILS) {
    const oldest = heldDetails.keys().next().value;
    if (oldest === undefined) break;
    heldDetails.delete(oldest);
  }
}

/**
 * Completes a point read's record with the detail held for it, and records
 * the detail of a record that arrived whole. `refetch` when the backend left
 * out detail this renderer does not hold under that fingerprint (it was
 * evicted, or replaced by a concurrent read): ask again naming none.
 *
 * `sent` is the entry whose fingerprint the read named, captured when it was
 * sent, so a later read replacing the entry cannot change what is merged.
 */
function withHeldDetail(
  state: BuildPipelinePersistenceState,
  pipelineId: string,
  loaded: PointRead,
  sent: HeldDetail | undefined,
): PointRead | "refetch" {
  if (loaded === null) {
    // Deleted: nothing left to hold.
    state.heldDetails.delete(pipelineId);
    return loaded;
  }
  if ("unchanged" in loaded && loaded.unchanged) return loaded;
  if (!("unchanged" in loaded)) {
    // An older backend ignored the fingerprint and sent the whole record
    // without one: there is nothing to hold it under.
    state.heldDetails.delete(pipelineId);
    return loaded;
  }
  const fingerprint = loaded.detailFingerprint;
  if (loaded.detailOmitted) {
    if (!sent || sent.fingerprint !== fingerprint) return "refetch";
    const snapshot = mergeBuildPipelineDetail(loaded.record.snapshot, sent.detail);
    if (!snapshot) return "refetch";
    holdDetail(state, pipelineId, sent);
    return {
      unchanged: false,
      record: { ...loaded.record, snapshot },
      messagePatches: loaded.messagePatches,
      detailFingerprint: fingerprint,
    };
  }
  const detail = fingerprint ? extractBuildPipelineDetail(loaded.record.snapshot) : null;
  if (fingerprint && detail) holdDetail(state, pipelineId, { fingerprint, detail });
  else state.heldDetails.delete(pipelineId);
  return loaded;
}

/** Test seam: the detail fingerprint `scope`'s point reads hold for `pipelineId`. */
export function heldBuildPipelineDetailFingerprintForTests(
  pipelineId: string,
  scope: NodeScope = appCommandScope(),
): string | undefined {
  return persistenceState(scope).heldDetails.get(pipelineId)?.fingerprint;
}

export interface HydrateBuildPipelineOptions {
  /** Served first when the response budget runs out. */
  prioritySessionKey?: string;
  /**
   * Also patch the transcript bodies. Without it the read is control state
   * only: held bodies are kept and read as stale, and a visible transcript
   * asks for its own patch, so a pipeline nobody is reading costs one
   * body-free record per change rather than transcript windows.
   */
  transcripts?: boolean;
}

/**
 * Marks a stage transcript as on screen until the returned function runs.
 * Change events for its pipeline then patch bodies too, with that session
 * first, instead of leaving the view to ask in a second read.
 */
export function watchBuildPipelineTranscript(
  pipelineId: string,
  sessionKey: string,
  scope: NodeScope = appCommandScope(),
): () => void {
  const { watchedTranscripts } = persistenceState(scope);
  const keys = watchedTranscripts.get(pipelineId) ?? [];
  keys.push(sessionKey);
  watchedTranscripts.set(pipelineId, keys);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = watchedTranscripts.get(pipelineId);
    if (!current) return;
    const index = current.lastIndexOf(sessionKey);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) watchedTranscripts.delete(pipelineId);
  };
}

/** Read options for a change to `pipelineId`: bodies only while a transcript is on screen. */
export function buildPipelineChangeReadOptions(
  pipelineId: string,
  scope: NodeScope = appCommandScope(),
): HydrateBuildPipelineOptions {
  const prioritySessionKey = persistenceState(scope).watchedTranscripts.get(pipelineId)?.at(-1);
  return prioritySessionKey ? { transcripts: true, prioritySessionKey } : {};
}

function mergeHydrationOptions(
  queued: HydrateBuildPipelineOptions,
  next: HydrateBuildPipelineOptions,
): HydrateBuildPipelineOptions {
  const prioritySessionKey = next.prioritySessionKey ?? queued.prioritySessionKey;
  return {
    ...(prioritySessionKey ? { prioritySessionKey } : {}),
    ...(queued.transcripts || next.transcripts ? { transcripts: true } : {}),
  };
}

/** One node's pipeline reads: its store and slot, held across awaits. */
interface PipelineNode {
  readonly scope: NodeScope;
  readonly store: StoreApi<BuildPipelineState>;
  readonly state: BuildPipelinePersistenceState;
}

function pipelineNode(scope: NodeScope): PipelineNode {
  return { scope, store: scope.store(buildPipelineStore), state: persistenceState(scope) };
}

function startPipelineRead(
  node: PipelineNode,
  pipelineId: string,
  read: PipelineRead,
  options: HydrateBuildPipelineOptions,
): Promise<BuildPipeline | null> {
  const { pipelineReads } = node.state;
  const result = hydrateBuildPipelineOnce(node, pipelineId, undefined, options);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  read.settled = settled;
  pipelineReads.set(pipelineId, read);
  void settled.then(() => {
    if (pipelineReads.get(pipelineId) === read && read.settled === settled && !read.queued) {
      pipelineReads.delete(pipelineId);
    }
  });
  return result;
}

/**
 * Installs one authoritative backend read model into the renderer cache.
 *
 * At most one backend read per pipeline is in flight. A call made while one
 * runs cannot know whether that read saw its change, so it waits for one
 * follow-up read, shared by every caller that arrives in the meantime; a
 * burst of change events costs two reads, not one each.
 */
export function hydrateBuildPipeline(
  pipelineId: string,
  load?: PipelineLoader,
  options: HydrateBuildPipelineOptions = {},
  scope: NodeScope = appCommandScope(),
): Promise<BuildPipeline | null> {
  const node = pipelineNode(scope);
  if (load) return hydrateBuildPipelineOnce(node, pipelineId, load, options);
  const read = node.state.pipelineReads.get(pipelineId);
  if (!read) {
    return startPipelineRead(
      node,
      pipelineId,
      { settled: Promise.resolve(), queued: null },
      options,
    );
  }
  if (read.queued) {
    read.queued.options = mergeHydrationOptions(read.queued.options, options);
    return read.queued.result;
  }
  const queued: NonNullable<PipelineRead["queued"]> = {
    options,
    result: read.settled.then(() => {
      read.queued = null;
      return startPipelineRead(node, pipelineId, read, queued.options);
    }),
  };
  read.queued = queued;
  return queued.result;
}

async function hydrateBuildPipelineOnce(
  node: PipelineNode,
  pipelineId: string,
  load: PipelineLoader | undefined,
  options: HydrateBuildPipelineOptions,
): Promise<BuildPipeline | null> {
  const { store, state } = node;
  const { pipelineHydrationGenerations, pipelineDeletionGenerations, unavailablePipelines } = state;
  const reads = pipelineReadsApi(node.scope);
  const generation = nextHydrationGeneration(state);
  setBoundedGeneration(
    pipelineHydrationGenerations,
    pipelineId,
    generation,
    MAX_PIPELINE_HYDRATION_MARKERS,
  );
  const localBefore = store.getState().pipelines.get(pipelineId);
  const localSessions = new Map<string, CachedSession>(
    localBefore?.sessions.map((session) => [session.sessionKey, session]) ?? [],
  );
  const pointRead = (held: HeldDetail | undefined): Promise<PointRead> =>
    !options.transcripts
      ? reads.getBuildPipelineControl<BuildPipeline>(
          pipelineId,
          localBefore?.backendRevision,
          held?.fingerprint ?? "",
        )
      : reads.getBuildPipelineConditional<BuildPipeline>(
          pipelineId,
          localBefore?.backendRevision,
          Object.fromEntries(
            [...localSessions].flatMap(([sessionKey, session]) => {
              const cursor = transcriptCursor(session);
              return cursor ? [[sessionKey, cursor]] : [];
            }),
          ),
          options.prioritySessionKey,
          held?.fingerprint ?? "",
        );
  const readWithDetail = async (): Promise<PointRead> => {
    const held = state.heldDetails.get(pipelineId);
    const first = withHeldDetail(state, pipelineId, await pointRead(held), held);
    if (first !== "refetch") return first;
    const whole = withHeldDetail(state, pipelineId, await pointRead(undefined), undefined);
    if (whole === "refetch") throw new Error("Invalid get_build_pipeline response");
    return whole;
  };
  const loaded = load ? await load(pipelineId) : await readWithDetail();
  if (loaded && "unchanged" in loaded && loaded.unchanged) {
    unavailablePipelines.delete(pipelineId);
    return store.getState().pipelines.get(pipelineId) ?? null;
  }
  let persisted: PersistedBuildPipeline<BuildPipeline> | null;
  if (loaded && "unchanged" in loaded && loaded.unchanged === false) {
    const invalidPatch = loaded.messagePatches.some((patch) => {
      if (patch.startIndex === 0 || patch.deferred || patch.unavailable) return false;
      const local = localSessions.get(patch.sessionKey);
      return (
        !local ||
        local.messages === undefined ||
        patch.baseRevision !== loadedRevision(local) ||
        patch.baseCount !== local.messages.length ||
        patch.startIndex < 0 ||
        patch.startIndex > local.messages.length
      );
    });
    if (invalidPatch) {
      // Ask again naming no bodies (and no detail): every stale session comes back whole.
      const answer = await reads.getBuildPipelineConditional<BuildPipeline>(
        pipelineId,
        undefined,
        {},
        options.prioritySessionKey,
        "",
      );
      const full = withHeldDetail(state, pipelineId, answer, undefined);
      if (full === "refetch") throw new Error("Invalid get_build_pipeline response");
      if (full && "unchanged" in full && full.unchanged) {
        return store.getState().pipelines.get(pipelineId) ?? null;
      }
      persisted =
        full && "unchanged" in full
          ? applyMessagePatches(full, new Map())
          : (full as PersistedBuildPipeline<BuildPipeline> | null);
    } else {
      persisted = applyMessagePatches(loaded, localSessions);
    }
  } else {
    persisted = withLocalTranscripts(
      loaded as PersistedBuildPipeline<BuildPipeline> | null,
      localBefore,
    );
  }
  if (pipelineHydrationGenerations.get(pipelineId) !== generation) {
    return store.getState().pipelines.get(pipelineId) ?? null;
  }
  if (!persisted || persisted.id !== pipelineId) {
    setBoundedGeneration(
      pipelineDeletionGenerations,
      pipelineId,
      generation,
      MAX_PIPELINE_HYDRATION_MARKERS,
    );
    markPipelineUnavailable(unavailablePipelines, pipelineId);
    return null;
  }
  const snapshot = toSnapshot(persisted);
  if (!snapshot) {
    setBoundedGeneration(
      pipelineDeletionGenerations,
      pipelineId,
      generation,
      MAX_PIPELINE_HYDRATION_MARKERS,
    );
    markPipelineUnavailable(unavailablePipelines, pipelineId);
    return null;
  }
  const local = store.getState().pipelines.get(pipelineId);
  unavailablePipelines.delete(pipelineId);
  if (local && local.backendRevision > snapshot.backendRevision) return local;
  store.getState().replacePipeline(snapshot);
  return snapshot;
}

/** Replaces the project projection with backend snapshots. */
export function hydrateBuildPipelinesForProject(
  projectId: string,
  list?: PipelineListLoader,
  scope: NodeScope = appCommandScope(),
): Promise<BuildPipeline[]> {
  const node = pipelineNode(scope);
  return hydrationActivity.track(() => restoreBuildPipelinesForProject(node, projectId, list));
}

async function restoreBuildPipelinesForProject(
  node: PipelineNode,
  projectId: string,
  list?: PipelineListLoader,
): Promise<BuildPipeline[]> {
  const { store, state } = node;
  const { projectHydrationGenerations, pipelineDeletionGenerations, unavailablePipelines } = state;
  const generation = nextHydrationGeneration(state);
  setBoundedGeneration(
    projectHydrationGenerations,
    projectId,
    generation,
    MAX_PROJECT_HYDRATION_MARKERS,
  );
  const localBefore = Array.from(store.getState().pipelines.values()).filter(
    (pipeline) => pipeline.projectId === projectId,
  );
  const conditional = list
    ? null
    : await pipelineReadsApi(node.scope).listBuildPipelinesConditional<BuildPipeline>(
        projectId,
        Object.fromEntries(localBefore.map((pipeline) => [pipeline.id, pipeline.backendRevision])),
      );
  const persisted = list ? await list(projectId) : conditional!.records;
  if (projectHydrationGenerations.get(projectId) !== generation) {
    return Array.from(store.getState().pipelines.values()).filter(
      (pipeline) => pipeline.projectId === projectId,
    );
  }
  if (!Array.isArray(persisted)) return [];
  const restored: BuildPipeline[] = [];
  for (const entry of persisted) {
    if (entry.projectId !== projectId) continue;
    // A point read that observed this record missing after the list request
    // began is newer authority. Skipping the stale list entry prevents a slow
    // project hydration from resurrecting a pipeline deleted in the meantime.
    if ((pipelineDeletionGenerations.get(entry.id) ?? 0) > generation) continue;
    const local = store.getState().pipelines.get(entry.id);
    // List entries are control state only; keep the transcript bodies this
    // renderer already fetched rather than blanking every open build tab.
    const merged = withLocalTranscripts(entry, local);
    const snapshot = merged ? toSnapshot(merged) : null;
    if (!snapshot) continue;
    unavailablePipelines.delete(snapshot.id);
    if (!local || local.backendRevision <= snapshot.backendRevision) {
      store.getState().replacePipeline(snapshot);
      restored.push(snapshot);
    } else {
      restored.push(local);
    }
  }
  if (conditional) {
    const liveIds = new Set(conditional.ids);
    for (const local of localBefore) {
      if (liveIds.has(local.id) && !restored.some((entry) => entry.id === local.id)) {
        restored.push(local);
      }
    }
  }
  return restored;
}
