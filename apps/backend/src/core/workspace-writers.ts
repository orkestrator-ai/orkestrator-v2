/**
 * D3 across engines: who else is using an environment's checkout.
 *
 * Graph runs keep their own one-writer lock (`GraphWorkspaceLocks`), but the
 * Build Pipeline and a bespoke Multi Review write the same checkout without
 * going through it. This module is the shared answer both sides consult:
 *
 * - a graph run's pass asks {@link WorkspaceWriters.externalHold} before it
 *   admits an activation that uses the workspace, and waits
 *   (`external-workflow`, naming the engine) while the hold forbids it;
 * - a Build Pipeline stage takes {@link WorkspaceWriters.claim} before it opens
 *   its session, and waits (a {@link WorkspaceBusyError} the supervisor
 *   retries on its cadence) while a graph run holds the workspace in a way the
 *   stage cannot share.
 *
 * The rule is D3's: one writer and nobody else, or any number of readers.
 * Readers count because a graph read-only node's git guard fails on any change
 * a writer makes, and a pipeline reviewer is likewise guarded.
 *
 * Cost: everything here is an in-memory projection. Build pipelines and
 * bespoke Multi Reviews are seeded with one store scan on first use, then
 * kept current from the pipeline's own record notes (synchronous, at every
 * save and read) and from storage resource changes (one row or the cached
 * pipeline store per change). Graph holds come from the run service's lock
 * table. A pass or a stage start reads a map entry, never the store.
 *
 * Interactive agent tabs (and Multi Review's interactive Fix tab) are not
 * workflows and are not tracked: a person drives them.
 */
import {
  isActiveBuildPhase,
  isBuildPipeline,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import type { GraphWorkspaceHolderKind } from "@orkestrator/protocol/graphs/run";
import type { GraphWorkspaceAccess } from "@orkestrator/protocol/graphs/template";
import {
  isMultiReviewWorkflow,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import { buildPipelineSessionStage } from "./build-pipeline-stages.js";
import type { PersistedBuildPipeline, PersistedMultiReviewWorkflow } from "./models.js";

/** How another engine uses a checkout: the same vocabulary as a graph node's access. */
export type WorkspaceUse = Exclude<GraphWorkspaceAccess, "none">;

export interface WorkspaceHolder {
  kind: GraphWorkspaceHolderKind;
  id: string;
  access: WorkspaceUse;
}

/** Counts in the shape `selectGraphAdmissions` reads, plus the first holder's engine. */
export interface ExternalWorkspaceHold {
  writers: number;
  readers: number;
  holder?: GraphWorkspaceHolderKind;
  holderAccess?: WorkspaceUse;
}

/** What graph runs hold on a workspace; null while the run service has not seeded its locks. */
export type GraphWorkspaceHoldProbe = (
  environmentId: string,
) => { writers: number; readers: number } | null;

/** Thrown by {@link WorkspaceWriters.claim}: the stage should wait and retry, not fail. */
export class WorkspaceBusyError extends Error {
  constructor(
    readonly holder: "graph-run",
    readonly reason: "writing" | "reading" | "recovering",
  ) {
    super(
      reason === "recovering"
        ? "Waiting for graph runs on this environment to be recovered"
        : reason === "writing"
          ? "Waiting: a graph run is writing this environment"
          : "Waiting: a graph run is reading this environment",
    );
    this.name = "WorkspaceBusyError";
  }
}

const SETUP_WRITES = new Set(["waiting-for-setup"]);

function stageUse(phase: BuildPipeline["sessions"][number]["phase"]): WorkspaceUse | null {
  const turn = buildPipelineSessionStage(phase).turn;
  if (turn === "write" || turn === "guarded") return "write";
  if (turn === "read-only") return "read";
  return null;
}

function strongest(left: WorkspaceUse | null, right: WorkspaceUse | null): WorkspaceUse | null {
  if (left === "write" || right === "write") return "write";
  return left ?? right;
}

/**
 * How a Build Pipeline uses its checkout now: `write` in a writing stage
 * (Build, Fix and package preparation, Address, Verify — whose shell may write
 * build outputs — PR, conflicts) or while setup runs, `read` while reviewing;
 * a session still running counts by its own stage, whatever the phase says.
 */
export function buildPipelineWorkspaceUse(snapshot: unknown): WorkspaceUse | null {
  if (!isBuildPipeline(snapshot)) return null;
  let use: WorkspaceUse | null = null;
  if (isActiveBuildPhase(snapshot.phase)) {
    if (SETUP_WRITES.has(snapshot.phase)) use = "write";
    else if (snapshot.phase === "reviewing") use = "read";
    else if (
      snapshot.phase !== "creating-environment" &&
      snapshot.phase !== "starting-environment"
    ) {
      use = "write";
    }
  }
  for (const session of snapshot.sessions) {
    if (session.status === "running") use = strongest(use, stageUse(session.phase));
  }
  return use;
}

/**
 * How a bespoke Multi Review uses its checkout: preparation (validation and
 * the package) and the backend Fix turn write; reviewers and consolidation
 * read. A graph-engine review (item 301) runs as a graph run and holds the
 * graph lock instead, so it is not counted twice. The interactive Fix tab is
 * a person's agent tab and is not tracked.
 */
export function multiReviewWorkspaceUse(snapshot: unknown): WorkspaceUse | null {
  if (!isMultiReviewWorkflow(snapshot)) return null;
  const workflow: MultiReviewWorkflow = snapshot;
  if (workflow.engine === "graph") return null;
  switch (workflow.phase) {
    case "preparing":
    case "fixing":
      return "write";
    case "reviewing":
    case "consolidating":
      return "read";
    default:
      return null;
  }
}

interface Entry {
  environmentId: string;
  revision: number;
  use: WorkspaceUse | null;
}

export interface WorkspaceWritersStorage {
  listAllBuildPipelines(): Promise<PersistedBuildPipeline[]>;
  getBuildPipeline(id: string): Promise<PersistedBuildPipeline | null>;
  listAllMultiReviewWorkflows(): Promise<PersistedMultiReviewWorkflow[]>;
  getMultiReviewWorkflow(id: string): Promise<PersistedMultiReviewWorkflow | null>;
  addResourceChangeListener?(listener: (change: ResourceChange) => void): () => void;
}

/** The shared workspace-holder projection (one per backend). */
export class WorkspaceWriters {
  private readonly entries: Record<GraphWorkspaceHolderKind, Map<string, Entry>> = {
    "build-pipeline": new Map(),
    "multi-review": new Map(),
  };
  /** Records deleted while the seed scan ran: the scan must not bring them back. */
  private readonly deleted = new Set<string>();
  /** Stage starts in flight, before their session is on the record. */
  private readonly claims = new Map<string, { environmentId: string; holder: WorkspaceHolder }>();
  private claimCounter = 0;
  private seeding: Promise<boolean> | null = null;
  private seeded = false;
  private unsubscribe: (() => void) | null = null;
  private graphHold: GraphWorkspaceHoldProbe | null = null;

  constructor(private readonly storage: WorkspaceWritersStorage) {
    // Subscribe before the seed scan, so a change during it is not lost.
    this.unsubscribe =
      storage.addResourceChangeListener?.((change) => this.onChange(change)) ?? null;
  }

  /** Where graph holds come from (the run service's lock table). */
  setGraphHoldProbe(probe: GraphWorkspaceHoldProbe | null): void {
    this.graphHold = probe;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Seeds the projection once (one scan of each store). True once seeded; a
   * failed scan answers false and is retried on the next call.
   */
  ready(): Promise<boolean> {
    if (this.seeded) return Promise.resolve(true);
    this.seeding ??= this.seed().finally(() => {
      this.seeding = null;
    });
    return this.seeding;
  }

  private async seed(): Promise<boolean> {
    try {
      const [pipelines, reviews] = await Promise.all([
        this.storage.listAllBuildPipelines(),
        this.storage.listAllMultiReviewWorkflows(),
      ]);
      for (const record of pipelines) {
        this.apply("build-pipeline", record.id, record.environmentId, record.revision, () =>
          buildPipelineWorkspaceUse(record.snapshot),
        );
      }
      for (const record of reviews) {
        this.apply("multi-review", record.id, record.environmentId, record.revision, () =>
          multiReviewWorkspaceUse(record.snapshot),
        );
      }
      this.seeded = true;
      this.deleted.clear();
      return true;
    } catch {
      return false;
    }
  }

  /** Keeps the newest revision of a record; a deleted record never returns. */
  private apply(
    kind: GraphWorkspaceHolderKind,
    id: string,
    environmentId: string,
    revision: number,
    use: () => WorkspaceUse | null,
  ): void {
    if (this.deleted.has(`${kind}:${id}`)) return;
    const map = this.entries[kind];
    const current = map.get(id);
    if (current && current.revision > revision) return;
    // Idle workflows stay as entries too: their revision keeps a stale read
    // from bringing back a use the record no longer has.
    map.set(id, { environmentId, revision, use: use() });
  }

  private forget(kind: GraphWorkspaceHolderKind, id: string): void {
    this.entries[kind].delete(id);
    if (!this.seeded) this.deleted.add(`${kind}:${id}`);
  }

  private onChange(change: ResourceChange): void {
    const kind: GraphWorkspaceHolderKind | null =
      change.resource === "build-pipeline"
        ? "build-pipeline"
        : change.resource === "multi-review"
          ? "multi-review"
          : null;
    if (!kind) return;
    if (change.deleted) {
      this.forget(kind, change.id);
      return;
    }
    const read =
      kind === "build-pipeline"
        ? this.storage.getBuildPipeline(change.id)
        : this.storage.getMultiReviewWorkflow(change.id);
    void read
      .then((record) => {
        if (!record) {
          this.forget(kind, change.id);
          return;
        }
        this.apply(kind, record.id, record.environmentId, record.revision, () =>
          kind === "build-pipeline"
            ? buildPipelineWorkspaceUse(record.snapshot)
            : multiReviewWorkspaceUse(record.snapshot),
        );
      })
      .catch(() => undefined);
  }

  /** The Build Pipeline's synchronous note of a record it just read or saved. */
  notePipeline(id: string, snapshot: unknown, revision: number): void {
    if (!isBuildPipeline(snapshot) || !snapshot.environmentId) return;
    this.apply("build-pipeline", id, snapshot.environmentId, revision, () =>
      buildPipelineWorkspaceUse(snapshot),
    );
  }

  /** Every non-graph holder of `environmentId`: recorded workflows, then stage starts in flight. */
  holders(environmentId: string): WorkspaceHolder[] {
    const holders: WorkspaceHolder[] = [];
    for (const kind of ["build-pipeline", "multi-review"] as const) {
      for (const [id, entry] of this.entries[kind]) {
        if (entry.environmentId !== environmentId || entry.use === null) continue;
        holders.push({ kind, id, access: entry.use });
      }
    }
    for (const claim of this.claims.values()) {
      if (claim.environmentId !== environmentId) continue;
      const recorded = holders.find(
        (holder) => holder.kind === claim.holder.kind && holder.id === claim.holder.id,
      );
      if (recorded) recorded.access = strongest(recorded.access, claim.holder.access)!;
      else holders.push({ ...claim.holder });
    }
    return holders;
  }

  /**
   * What other engines hold on `environmentId`, for a graph pass: writers
   * first in `holder`. Null until the projection is seeded (call
   * {@link ready} first).
   */
  externalHold(environmentId: string): ExternalWorkspaceHold | null {
    if (!this.seeded) return null;
    const holders = this.holders(environmentId);
    const writers = holders.filter((holder) => holder.access === "write");
    const readers = holders.filter((holder) => holder.access === "read");
    const first = writers[0] ?? readers[0];
    return {
      writers: writers.length,
      readers: readers.length,
      ...(first ? { holder: first.kind, holderAccess: first.access } : {}),
    };
  }

  /**
   * A Build Pipeline stage start: checks the graph runs' hold on the
   * environment and, when D3 allows `use` beside it, records the start until
   * `release` (which takes the saved record, so the projection already shows
   * the stage when the claim goes). Synchronous check and record, so a graph
   * pass deciding at the same time sees one or the other. Throws
   * {@link WorkspaceBusyError} when the stage must wait.
   */
  claim(
    holder: { kind: "build-pipeline"; id: string },
    environmentId: string,
    use: WorkspaceUse,
  ): { release(saved?: { snapshot: unknown; revision: number }): void } {
    const graph = this.graphHold ? this.graphHold(environmentId) : { writers: 0, readers: 0 };
    if (graph === null) throw new WorkspaceBusyError("graph-run", "recovering");
    if (graph.writers > 0) throw new WorkspaceBusyError("graph-run", "writing");
    if (use === "write" && graph.readers > 0) throw new WorkspaceBusyError("graph-run", "reading");
    const token = `${holder.kind}:${holder.id}:${++this.claimCounter}`;
    this.claims.set(token, { environmentId, holder: { ...holder, access: use } });
    return {
      release: (saved) => {
        if (saved) this.notePipeline(holder.id, saved.snapshot, saved.revision);
        this.claims.delete(token);
      },
    };
  }
}
