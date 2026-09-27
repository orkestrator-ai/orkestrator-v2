import { createHash, randomUUID } from "node:crypto";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import {
  parseViewSnapshotRequest,
  resolveViewSnapshotOutcome,
  type ViewRevisionStamp,
  type ViewSnapshotOutcome,
} from "@orkestrator/protocol/view-sync";

/** Projects whose last answered digest is remembered; older ones re-send a body. */
export const COORDINATOR_VIEW_TRACKED_PROJECTS = 256;

interface TrackedView {
  digest: string;
  revision: number;
}

/**
 * Conditional-read tokens for the coordinator panel (recurring-processes step
 * 09, the "compact compatible recovery API" of step 11).
 *
 * The coordinator snapshot joins persistent storage (workspace, workflow
 * associations) with live, unannounced facts (provider qualification, control
 * MCP state), so no single persistent counter describes it. Instead each
 * answer is stamped with the owner `generation` (one backend lifetime) and a
 * `revision` that changes whenever the *captured* snapshot's digest changes.
 * A client that still holds that exact body gets `unchanged` with no body.
 *
 * Revisions come from one process-wide counter, so they only ever increase and
 * are never reused for a different body — not even for a project whose entry
 * was evicted from the bounded map (it simply gets a fresh, higher revision
 * and the client receives a full body once). They are an equality/ordering
 * token, not an event sequence: coordinator changes reach clients as bodiless
 * `resource-changed` invalidations, so clients do not gap-detect this view.
 */
export class CoordinatorViewRevisions {
  readonly generation: string;
  private nextRevision = 0;
  private readonly views = new Map<string, TrackedView>();

  constructor(
    private readonly maxProjects = COORDINATOR_VIEW_TRACKED_PROJECTS,
    generation: string = randomUUID(),
  ) {
    this.generation = generation;
  }

  /** Stamps a captured snapshot (`null` = the workspace does not exist). */
  stamp(projectId: string, snapshot: CoordinatorSnapshot | null): ViewRevisionStamp {
    const digest =
      snapshot === null
        ? "deleted"
        : createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const previous = this.views.get(projectId);
    let revision: number;
    if (previous && previous.digest === digest) {
      revision = previous.revision;
      this.views.delete(projectId);
    } else {
      this.nextRevision += 1;
      revision = this.nextRevision;
    }
    this.views.set(projectId, { digest, revision });
    while (this.views.size > this.maxProjects) {
      const oldest = this.views.keys().next().value;
      if (oldest === undefined) break;
      this.views.delete(oldest);
    }
    return { generation: this.generation, revision };
  }

  /**
   * Answers one conditional read. `capture` must return the snapshot exactly
   * as it will be sent; the stamp is computed from that same object.
   */
  async read(
    projectId: string,
    args: unknown,
    capture: () => Promise<CoordinatorSnapshot | null>,
  ): Promise<ViewSnapshotOutcome<CoordinatorSnapshot>> {
    const request = parseViewSnapshotRequest(args);
    const snapshot = await capture();
    const current = this.stamp(projectId, snapshot);
    if (snapshot === null) return { status: "deleted", ...current };
    return resolveViewSnapshotOutcome(request, current, () => snapshot);
  }
}
