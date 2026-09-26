/**
 * Content-free change hints and the bounded replay ring behind
 * `web_annotations_changes`.
 *
 * The generation is random per backend process; the environment revision is
 * persisted with each commit. The ring never answers across a gap: expired,
 * future, evicted, or foreign-generation cursors get `resetRequired`.
 */
import { randomUUID } from "node:crypto";
import {
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationChangeHint,
  type WebAnnotationChanges,
} from "@orkestrator/protocol/web-annotations";

interface RingEntry {
  revision: number;
  annotationIds: string[];
  requestIds: string[];
  reset: boolean;
  bytes: number;
}

interface EnvironmentRing {
  /** Entries cover the revision range (base, latest]. */
  base: number;
  entries: RingEntry[];
  bytes: number;
}

export interface WebAnnotationChangeRingLimits {
  entries?: number;
  bytes?: number;
  environments?: number;
  idsPerChange?: number;
}

export class WebAnnotationChangeRing {
  readonly generation: string;
  private readonly rings = new Map<string, EnvironmentRing>();
  private readonly limits: Required<WebAnnotationChangeRingLimits>;

  constructor(limits: WebAnnotationChangeRingLimits = {}, generation: string = randomUUID()) {
    this.generation = generation;
    this.limits = {
      entries: limits.entries ?? WEB_ANNOTATION_LIMITS.hintRingEntries,
      bytes: limits.bytes ?? WEB_ANNOTATION_LIMITS.hintRingBytes,
      environments: limits.environments ?? WEB_ANNOTATION_LIMITS.hintEnvironments,
      idsPerChange: limits.idsPerChange ?? WEB_ANNOTATION_LIMITS.hintIdsPerChange,
    };
  }

  /** Record one committed revision and return the hint to broadcast. */
  record(
    environmentId: string,
    revision: number,
    annotationIds: readonly string[],
    requestIds: readonly string[],
  ): WebAnnotationChangeHint {
    const annotations = Array.from(new Set(annotationIds));
    const requests = Array.from(new Set(requestIds));
    const reset = annotations.length + requests.length > this.limits.idsPerChange;
    const hint: WebAnnotationChangeHint = {
      environmentId,
      generation: this.generation,
      revision,
      annotationIds: reset ? [] : annotations,
      requestIds: reset ? [] : requests,
      reset,
    };
    let ring = this.rings.get(environmentId);
    if (ring) {
      this.rings.delete(environmentId);
      const latest = ring.entries.at(-1)?.revision ?? ring.base;
      // A skipped revision (should not happen) makes older history unusable.
      if (revision !== latest + 1) ring = { base: revision - 1, entries: [], bytes: 0 };
    } else {
      ring = { base: revision - 1, entries: [], bytes: 0 };
    }
    const bytes =
      32 + JSON.stringify(hint.annotationIds).length + JSON.stringify(hint.requestIds).length;
    ring.entries.push({
      revision,
      annotationIds: hint.annotationIds,
      requestIds: hint.requestIds,
      reset,
      bytes,
    });
    ring.bytes += bytes;
    while (
      ring.entries.length > 0 &&
      (ring.entries.length > this.limits.entries || ring.bytes > this.limits.bytes)
    ) {
      const removed = ring.entries.shift()!;
      ring.bytes -= removed.bytes;
      ring.base = removed.revision;
    }
    this.rings.set(environmentId, ring);
    while (this.rings.size > this.limits.environments) {
      const oldest = this.rings.keys().next().value;
      if (oldest === undefined) break;
      this.rings.delete(oldest);
    }
    return hint;
  }

  /**
   * Contiguous changes after `after`, or `resetRequired` when the range cannot
   * be proven complete. `currentRevision` is the committed environment revision.
   */
  changes(
    environmentId: string,
    generation: string | undefined,
    after: number,
    currentRevision: number,
  ): WebAnnotationChanges {
    const reset = (): WebAnnotationChanges => ({
      generation: this.generation,
      revision: currentRevision,
      resetRequired: true,
      changes: [],
    });
    if (generation !== this.generation) return reset();
    if (!Number.isSafeInteger(after) || after < 0 || after > currentRevision) return reset();
    if (after === currentRevision) {
      return {
        generation: this.generation,
        revision: currentRevision,
        resetRequired: false,
        changes: [],
      };
    }
    const ring = this.rings.get(environmentId);
    if (!ring || after < ring.base) return reset();
    const entries = ring.entries.filter((entry) => entry.revision > after);
    if (
      entries.length === 0 ||
      entries[0]!.revision !== after + 1 ||
      entries.at(-1)!.revision !== currentRevision ||
      entries.some((entry) => entry.reset)
    ) {
      return reset();
    }
    for (let index = 1; index < entries.length; index++) {
      if (entries[index]!.revision !== entries[index - 1]!.revision + 1) return reset();
    }
    return {
      generation: this.generation,
      revision: currentRevision,
      resetRequired: false,
      changes: entries.map((entry) => ({
        revision: entry.revision,
        annotationIds: [...entry.annotationIds],
        requestIds: [...entry.requestIds],
      })),
    };
  }

  forget(environmentId: string): void {
    this.rings.delete(environmentId);
  }

  get environmentCount(): number {
    return this.rings.size;
  }
}
