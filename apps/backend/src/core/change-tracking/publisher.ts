/**
 * ChangeResourcePublisher: delivers committed projection changes to clients.
 *
 * Measurements are committed together with an outbox row; this drains the
 * outbox after commit (and again at startup, so a crash between commit and
 * delivery only delays an event). Pending announcements coalesce per resource
 * within one tick: a subscriber that falls behind receives the latest
 * projection, never an unbounded private queue. Events carry the projection
 * summary only; file pages are fetched with `changes_get_files`.
 */

import {
  CHANGE_PROJECTION_CHANGED_EVENT,
  type ChangeProjectionEvent,
} from "@orkestrator/protocol/change-resources";
import type { ChangeLedger } from "./change-ledger.js";
import type { ProjectionAnnouncer } from "./environment-projector.js";
import type { ChangeProjectionService } from "./projection-service.js";

const OUTBOX_BATCH = 500;

export class ChangeResourcePublisher implements ProjectionAnnouncer {
  private readonly pending = new Set<string>();
  private scheduled = false;
  private delivered = 0;
  private coalesced = 0;

  constructor(
    private readonly ledger: ChangeLedger,
    private readonly projections: ChangeProjectionService,
    private readonly emit: (event: string, payload: unknown) => void,
  ) {}

  announce(resourceKey: string): void {
    if (this.pending.has(resourceKey)) this.coalesced++;
    this.pending.add(resourceKey);
    this.schedule();
  }

  contentInvalidated(resourceKey: string, pathIds: string[] | null, generation: number): void {
    this.send({
      kind: "content-invalidated",
      resourceKey,
      ownerGeneration: this.projections.ownerGeneration,
      contentGeneration: generation,
      pathIds,
    });
  }

  /** Move committed outbox rows into pending announcements. */
  drainOutbox(): number {
    let drained = 0;
    for (;;) {
      const rows = this.ledger.pendingOutbox(OUTBOX_BATCH);
      if (rows.length === 0) break;
      this.ledger.transaction(() => {
        for (const row of rows) this.ledger.markOutboxDelivered(row.sequence);
      });
      for (const row of rows) {
        this.projections.bump(row.resource_key);
        this.announce(row.resource_key);
      }
      drained += rows.length;
      if (rows.length < OUTBOX_BATCH) break;
    }
    return drained;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** Deliver every pending resource once. */
  flush(): void {
    this.scheduled = false;
    const keys = [...this.pending];
    this.pending.clear();
    for (const key of keys) {
      const projection = this.projections.project(key, 0);
      if (!projection) continue;
      this.send(
        projection.state === "deleted"
          ? {
              kind: "deleted",
              resourceKey: key,
              ownerGeneration: projection.ownerGeneration,
              revision: projection.revision,
            }
          : { kind: "projection", projection },
      );
    }
  }

  private send(event: ChangeProjectionEvent): void {
    this.delivered++;
    try {
      this.emit(CHANGE_PROJECTION_CHANGED_EVENT, event);
    } catch {
      // A failed transport delivery is recovered by snapshot reads; the ledger
      // remains authoritative.
    }
  }

  stats() {
    return { delivered: this.delivered, coalesced: this.coalesced, pending: this.pending.size };
  }
}
