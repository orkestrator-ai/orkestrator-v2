import * as backend from "@/lib/backend";
import {
  BUILD_PIPELINE_VERSION,
  isBuildPipeline,
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";
import type { PersistedBuildPipeline } from "@/types";

export { isBuildPipeline } from "@/stores/buildPipelineStore";

interface PendingWrite {
  pipeline: BuildPipeline;
  fingerprint: string;
}

type PipelineLoader = (
  pipelineId: string,
) => Promise<PersistedBuildPipeline<BuildPipeline> | null>;
type PipelineListLoader = (
  projectId: string,
) => Promise<Array<PersistedBuildPipeline<BuildPipeline>>>;
type PipelineSaver = (
  pipelineId: string,
  projectId: string,
  environmentId: string,
  version: number,
  snapshot: BuildPipeline,
  expectedRevision?: number,
) => Promise<PersistedBuildPipeline<BuildPipeline>>;

/**
 * Process-local dirty markers keep a transition made since this client started
 * from being overwritten by an equal-revision backend snapshot. They are only
 * set by the subscriber below, never by hydration: on startup the backend is
 * authoritative for equal revisions.
 */
const dirtyPipelineFingerprints = new Map<string, string>();

function pipelineFingerprint(pipeline: BuildPipeline): string {
  const { backendRevision: _backendRevision, ...durable } = pipeline;
  return JSON.stringify(durable);
}

function isUnsavedLocalPipeline(pipeline: BuildPipeline): boolean {
  return dirtyPipelineFingerprints.get(pipeline.id) === pipelineFingerprint(pipeline);
}

function markPipelineClean(pipelineId: string, fingerprint: string): void {
  if (dirtyPipelineFingerprints.get(pipelineId) === fingerprint) {
    dirtyPipelineFingerprints.delete(pipelineId);
  }
}

/**
 * Clears a completion-comment lease left behind by a client that died mid-post.
 *
 * "posting" is an in-process lease, not a result. Only the initial restore does
 * this: on a later refresh the lease may belong to another *live* client, and
 * clearing it there would invite a double post. The backend's durable marker
 * check (`withGitHubCompletionCommentLock`) remains the actual guard either way.
 */
function releaseStalePostingLease(pipeline: BuildPipeline): BuildPipeline {
  if (pipeline.completionCommentStatus !== "posting") return pipeline;
  const recovered = { ...pipeline };
  delete recovered.completionCommentStatus;
  delete recovered.completionCommentError;
  return recovered;
}

function toSnapshot(
  persisted: PersistedBuildPipeline<BuildPipeline>,
): BuildPipeline | null {
  if (
    persisted.version !== BUILD_PIPELINE_VERSION
    || !Number.isSafeInteger(persisted.revision)
    || persisted.revision < 1
    || typeof persisted.updatedAt !== "string"
    || !Number.isFinite(Date.parse(persisted.updatedAt))
    || !isBuildPipeline(persisted.snapshot)
    || persisted.snapshot.id !== persisted.id
    || persisted.snapshot.projectId !== persisted.projectId
    || persisted.snapshot.environmentId !== persisted.environmentId
  ) {
    return null;
  }
  return { ...persisted.snapshot, backendRevision: persisted.revision };
}

/**
 * Rehydrates one pipeline from the backend authority. The local snapshot is
 * kept only when it has already observed a newer revision, or when it holds an
 * unsaved transition at the same revision.
 */
export async function hydrateBuildPipeline(
  pipelineId: string,
  load: PipelineLoader = backend.getBuildPipeline,
): Promise<BuildPipeline | null> {
  const persisted = await load(pipelineId);
  if (!persisted || persisted.id !== pipelineId) return null;
  const snapshot = toSnapshot(persisted);
  if (!snapshot) return null;

  const local = useBuildPipelineStore.getState().pipelines.get(pipelineId);
  if (local && local.backendRevision > persisted.revision) return local;
  if (
    local
    && local.backendRevision === persisted.revision
    && isUnsavedLocalPipeline(local)
  ) {
    return local;
  }
  useBuildPipelineStore.getState().replacePipeline(snapshot);
  dirtyPipelineFingerprints.delete(pipelineId);
  return snapshot;
}

/**
 * Restores every authoritative pipeline for a project after app restart, or
 * when a client opens a project for the first time.
 */
export async function hydrateBuildPipelinesForProject(
  projectId: string,
  list: PipelineListLoader = backend.listBuildPipelines,
): Promise<BuildPipeline[]> {
  if (typeof list !== "function") return [];
  const persisted = await list(projectId);
  if (!Array.isArray(persisted)) return [];

  const restored: BuildPipeline[] = [];
  for (const entry of persisted) {
    if (entry.projectId !== projectId) continue;
    const snapshot = toSnapshot(entry);
    if (!snapshot) continue;

    const local = useBuildPipelineStore.getState().pipelines.get(entry.id);
    const keepDirtyEqualRevision =
      local
      && local.backendRevision === entry.revision
      && isUnsavedLocalPipeline(local);
    if (
      !local
      || (local.backendRevision <= entry.revision && !keepDirtyEqualRevision)
    ) {
      const recovered = releaseStalePostingLease(snapshot);
      useBuildPipelineStore.getState().replacePipeline(recovered);
      dirtyPipelineFingerprints.delete(entry.id);
      restored.push(recovered);
    } else {
      restored.push(local);
    }
  }
  return restored;
}

/**
 * Key the pre-backend build pipeline store persisted to under zustand's
 * `persist` middleware. Retained only so the one-shot migration below can find
 * what an upgrading client left behind.
 */
export const LEGACY_BUILD_PIPELINE_STORAGE_KEY = "orkestrator-build-pipelines";

/**
 * Adopts pipelines left in `localStorage` by a pre-backend build of the app.
 *
 * Without this an upgrade silently drops every in-flight build: the backend has
 * no record yet, the old entry is orphaned, and a pipeline mid-`building` stops
 * advancing while its environment and agent session carry on existing. Runs
 * once — the key is removed on success — and must run before
 * {@link startBuildPipelinePersistence}, whose seeding pass is what actually
 * writes the adopted pipelines to the backend.
 *
 * A pipeline the backend already knows about wins: hydration may have raced
 * ahead of this call, and the backend copy is by definition the newer one.
 */
export function migrateLegacyBuildPipelines(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined =
    typeof localStorage === "undefined" ? undefined : localStorage,
): BuildPipeline[] {
  if (!storage) return [];

  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_BUILD_PIPELINE_STORAGE_KEY);
  } catch {
    // Private browsing and blocked storage both throw rather than return null.
    return [];
  }
  if (!raw) return [];

  const adopted: BuildPipeline[] = [];
  try {
    const parsed = JSON.parse(raw) as { state?: { pipelines?: unknown } };
    const entries = Array.isArray(parsed?.state?.pipelines) ? parsed.state!.pipelines : [];
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, stored] = entry as [unknown, unknown];
      if (typeof id !== "string" || !id || typeof stored !== "object" || stored === null) continue;
      // The legacy snapshot predates `backendRevision`; 0 is the correct value
      // for it anyway, since the backend has never seen this pipeline.
      const candidate = { ...(stored as Record<string, unknown>), backendRevision: 0 };
      if (!isBuildPipeline(candidate) || candidate.id !== id) continue;
      if (useBuildPipelineStore.getState().pipelines.has(id)) continue;
      const recovered = releaseStalePostingLease(candidate);
      useBuildPipelineStore.getState().replacePipeline(recovered);
      adopted.push(recovered);
    }
  } catch (error) {
    console.warn("[BuildPipeline] Failed to migrate legacy pipelines:", error);
    return adopted;
  }

  try {
    storage.removeItem(LEGACY_BUILD_PIPELINE_STORAGE_KEY);
  } catch {
    // Leaving the key behind only costs a repeated no-op migration next start.
  }
  return adopted;
}

/**
 * Durably records the pipeline before an irreversible side effect.
 *
 * Callers use this ahead of dispatching a prompt or posting a comment, so a
 * client that dies immediately afterwards leaves behind a record that says the
 * attempt was made rather than one that invites a second attempt.
 */
export async function persistBuildPipelineNow(
  pipelineId: string,
  options: Pick<BuildPipelinePersistenceOptions, "save" | "load"> = {},
): Promise<BuildPipeline> {
  const save = options.save ?? backend.saveBuildPipeline;
  const load = options.load ?? backend.getBuildPipeline;
  const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId);
  if (!pipeline) throw new Error(`Build pipeline not found: ${pipelineId}`);
  const fingerprint = pipelineFingerprint(pipeline);

  let saved;
  try {
    saved = await save(
      pipeline.id,
      pipeline.projectId,
      pipeline.environmentId,
      BUILD_PIPELINE_VERSION,
      pipeline,
      pipeline.backendRevision,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("revision conflict")) {
      const winner = await hydrateBuildPipeline(pipelineId, load);
      if (winner) return winner;
    }
    throw error;
  }
  markPipelineClean(pipelineId, fingerprint);
  useBuildPipelineStore.getState().setBackendRevision(pipelineId, saved.revision);
  return useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
}

export interface BuildPipelinePersistenceOptions {
  debounceMs?: number;
  /** Initial retry delay for a transient backend failure. */
  retryMs?: number;
  /** Maximum delay between retries while a pipeline remains dirty. */
  maxRetryMs?: number;
  save?: PipelineSaver;
  load?: PipelineLoader;
  remove?: (pipelineId: string) => Promise<void>;
}

/**
 * Mirrors every pipeline transition into the revisioned backend store.
 *
 * Writes are serialized per pipeline and use compare-and-swap revisions. A
 * conflict rehydrates the backend winner rather than letting two clients each
 * believe they own the next phase of the same build.
 */
export function startBuildPipelinePersistence(
  options: BuildPipelinePersistenceOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 250;
  const retryMs = Math.max(1, options.retryMs ?? 1_000);
  const maxRetryMs = Math.max(retryMs, options.maxRetryMs ?? 30_000);
  const save = options.save ?? backend.saveBuildPipeline;
  const load = options.load ?? backend.getBuildPipeline;
  const remove = options.remove ?? backend.deleteBuildPipeline;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, PendingWrite>();
  const chains = new Map<string, Promise<void>>();
  const lastSavedFingerprint = new Map<string, string>();
  const retryAttempts = new Map<string, number>();
  let stopped = false;

  const cancelTimer = (pipelineId: string) => {
    const timer = timers.get(pipelineId);
    if (timer) clearTimeout(timer);
    timers.delete(pipelineId);
  };

  const scheduleRetry = (pipelineId: string) => {
    if (stopped || timers.has(pipelineId) || !pending.has(pipelineId)) return;
    const attempt = retryAttempts.get(pipelineId) ?? 1;
    const delay = Math.min(maxRetryMs, retryMs * (2 ** Math.min(attempt - 1, 20)));
    timers.set(pipelineId, setTimeout(() => {
      void flush(pipelineId);
    }, delay));
  };

  const retainDirtyWrite = (pipelineId: string) => {
    const latest = useBuildPipelineStore.getState().pipelines.get(pipelineId);
    if (!latest) return;
    const fingerprint = pipelineFingerprint(latest);
    dirtyPipelineFingerprints.set(pipelineId, fingerprint);
    pending.set(pipelineId, { pipeline: latest, fingerprint });
    retryAttempts.set(pipelineId, (retryAttempts.get(pipelineId) ?? 0) + 1);
    scheduleRetry(pipelineId);
  };

  const enqueue = (pipelineId: string): Promise<void> => {
    const previous = chains.get(pipelineId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const current = useBuildPipelineStore.getState().pipelines.get(pipelineId);
      if (!current) return;
      try {
        const saved = await save(
          pipelineId,
          current.projectId,
          current.environmentId,
          BUILD_PIPELINE_VERSION,
          current,
          current.backendRevision,
        );
        const savedFingerprint = pipelineFingerprint(current);
        lastSavedFingerprint.set(pipelineId, savedFingerprint);
        markPipelineClean(pipelineId, savedFingerprint);
        retryAttempts.delete(pipelineId);
        useBuildPipelineStore.getState().setBackendRevision(pipelineId, saved.revision);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("revision conflict")) {
          // Another client advanced this pipeline. Adopt its state rather than
          // retrying ours, which would replay a phase that already ran.
          const winner = await load(pipelineId).catch(() => null);
          if (winner) {
            const snapshot = toSnapshot(winner);
            if (snapshot) {
              useBuildPipelineStore.getState().replacePipeline(snapshot);
              lastSavedFingerprint.set(pipelineId, pipelineFingerprint(snapshot));
              dirtyPipelineFingerprints.delete(pipelineId);
              retryAttempts.delete(pipelineId);
              return;
            }
          }
        }
        retainDirtyWrite(pipelineId);
        console.error(
          `[BuildPipeline] Failed to persist pipeline ${pipelineId}:`,
          message,
        );
      }
    });
    chains.set(pipelineId, next);
    void next.finally(() => {
      if (chains.get(pipelineId) === next) chains.delete(pipelineId);
    });
    return next;
  };

  const flush = (pipelineId: string): Promise<void> | undefined => {
    const write = pending.get(pipelineId);
    if (!write) return undefined;
    cancelTimer(pipelineId);
    pending.delete(pipelineId);
    return enqueue(pipelineId);
  };

  const flushAll = () => Promise.all(
    [...pending.keys()].map((id) => flush(id) ?? Promise.resolve()),
  ).then(() => undefined);

  const unsubscribe = useBuildPipelineStore.subscribe((state, previous) => {
    const ids = new Set([...state.pipelines.keys(), ...previous.pipelines.keys()]);
    for (const id of ids) {
      const pipeline = state.pipelines.get(id);
      if (!pipeline) {
        cancelTimer(id);
        pending.delete(id);
        lastSavedFingerprint.delete(id);
        retryAttempts.delete(id);
        dirtyPipelineFingerprints.delete(id);
        // A non-zero backendRevision means the backend holds a record for this
        // pipeline, so dropping it locally is a real deletion and must remove
        // that record too. A pipeline that was never persisted has nothing to
        // delete, and issuing one anyway would race a sibling client that is
        // mid-way through creating it.
        if (previous.pipelines.get(id)?.backendRevision) {
          void remove(id).catch((error: unknown) => {
            console.warn(
              `[BuildPipeline] Failed to delete pipeline ${id} from the backend:`,
              error,
            );
          });
        }
        continue;
      }
      if (pipeline === previous.pipelines.get(id)) continue;
      const fingerprint = pipelineFingerprint(pipeline);
      if (
        fingerprint === lastSavedFingerprint.get(id)
        || fingerprint === pending.get(id)?.fingerprint
      ) {
        continue;
      }
      dirtyPipelineFingerprints.set(id, fingerprint);
      pending.set(id, { pipeline, fingerprint });
      cancelTimer(id);
      timers.set(id, setTimeout(() => {
        void flush(id);
      }, debounceMs));
    }
  });

  // Pipelines already in the store when persistence starts predate this
  // subscription; seed them so a restart cannot strand an unsaved pipeline.
  for (const id of useBuildPipelineStore.getState().pipelines.keys()) {
    const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
    pending.set(id, { pipeline, fingerprint: pipelineFingerprint(pipeline) });
    timers.set(id, setTimeout(() => {
      void flush(id);
    }, debounceMs));
  }

  const onPageHide = () => {
    void flushAll();
  };
  window.addEventListener("pagehide", onPageHide);

  return () => {
    stopped = true;
    unsubscribe();
    window.removeEventListener("pagehide", onPageHide);
    void flushAll();
  };
}
