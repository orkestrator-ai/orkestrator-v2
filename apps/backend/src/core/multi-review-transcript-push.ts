/**
 * What the push layer's `review-transcript` topic compares for one Multi
 * Review reviewer or step (docs/architecture/push-events.md, "The
 * `review-transcript` topic"): the provider session the view shows and a
 * digest of the record fields it shows besides the transcript. Built from the
 * workflow record alone, so a record save costs a storage read, never a
 * bridge read. The digest is compared in memory, never logged or sent.
 */
import { createHash } from "node:crypto";
import {
  multiReviewStepSessionAccess,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { ReviewTranscriptPushKey } from "@orkestrator/protocol/push-events";
import type { ReviewerTranscriptRead } from "./multi-review-reviewer-transcript.js";
import type { ReviewTranscriptTarget } from "./push/review-transcript-push-topic.js";

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

/** The key's target in `workflow`, or `null` when the reviewer is gone. */
export function multiReviewTranscriptPushTarget(
  workflow: MultiReviewWorkflow,
  key: ReviewTranscriptPushKey,
): ReviewTranscriptTarget | null {
  if (key.step === undefined) {
    const reviewer = workflow.reviewers.find((entry) => entry.id === key.reviewerId);
    if (!reviewer) return null;
    return {
      environmentId: workflow.environmentId,
      agent: reviewer.agent,
      ...(reviewer.providerSessionId ? { providerSessionId: reviewer.providerSessionId } : {}),
      live: reviewer.status === "running" || reviewer.status === "pending",
      // Everything the reviewer tab shows that is not the transcript itself.
      digest: digestOf([
        workflow.phase,
        reviewer.status,
        reviewer.dispatchState ?? null,
        reviewer.model,
        reviewer.reasoningEffort ?? null,
        reviewer.report ?? null,
        reviewer.error ?? null,
        reviewer.progressAt ?? null,
        reviewer.stalledSince ?? null,
        reviewer.startedAt ?? null,
        reviewer.completedAt ?? null,
      ]),
    };
  }
  const access = multiReviewStepSessionAccess(workflow, key.step);
  const session = access.kind === "none" ? undefined : access.session;
  return {
    environmentId: workflow.environmentId,
    agent: session?.agent ?? "",
    // Only a session this step owns shows a transcript.
    ...(access.kind === "own" ? { providerSessionId: access.session.providerSessionId } : {}),
    live: access.kind === "own" && access.session.status === "running",
    digest: digestOf([
      workflow.phase,
      access.kind,
      access.kind === "other-step" ? access.step : null,
      session?.agent ?? null,
      session?.model ?? null,
      session?.status ?? null,
      session?.startedAt ?? null,
    ]),
  };
}

type TranscriptIdentity = {
  environmentId: string;
  agent: string;
  providerSessionId: string;
  view: string;
};

type Snapshot = Extract<ReviewerTranscriptRead, { kind: "snapshot" }>;

const MAX_SHARED_TRANSCRIPTS = 64;
const MAX_SHARED_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const SHARED_TRANSCRIPT_TTL_MS = 2_000;

interface SharedTranscript {
  identity: TranscriptIdentity;
  snapshot?: Snapshot;
  freshUntil: number;
  pending?: { answer: Promise<ReviewerTranscriptRead>; invalidated: boolean };
}

/** Shares provider work per session and view shape. Hints fence in-flight reads. */
export class SharedReviewTranscripts {
  private readonly entries = new Map<string, SharedTranscript>();
  private bytes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  invalidate(environmentId: string, agent: string, sessionId: string | undefined): void {
    for (const entry of this.entries.values()) {
      const identity = entry.identity;
      if (
        identity.environmentId === environmentId &&
        identity.agent === agent &&
        (sessionId === undefined || identity.providerSessionId === sessionId)
      ) {
        entry.freshUntil = 0;
        if (entry.pending) entry.pending.invalidated = true;
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  async read(
    identity: TranscriptIdentity,
    viewerToken: string | undefined,
    probe: boolean,
    load: (knownToken: string | undefined) => Promise<ReviewerTranscriptRead>,
  ): Promise<ReviewerTranscriptRead> {
    const key = JSON.stringify([
      identity.environmentId,
      identity.agent,
      identity.providerSessionId,
      identity.view,
    ]);
    let entry = this.entries.get(key);
    if (!entry && this.entries.size >= MAX_SHARED_TRANSCRIPTS) {
      for (const [oldKey, oldEntry] of Array.from(this.entries)) {
        if (oldEntry.pending) continue;
        this.drop(oldKey, oldEntry);
        break;
      }
    }
    if (!entry && this.entries.size >= MAX_SHARED_TRANSCRIPTS) return load(viewerToken);
    if (!entry) {
      entry = { identity, freshUntil: 0 };
      this.entries.set(key, entry);
    }
    const kept = entry;
    if (kept.pending?.invalidated) {
      // Finish the older read before starting a refresh, even under a burst
      // of hints. Its owner can use the answer but cannot repopulate the cache.
      await kept.pending.answer.catch(() => undefined);
      return this.read(identity, viewerToken, probe, load);
    }
    const cached = kept.snapshot;
    let snapshot: ReviewerTranscriptRead;
    if (!probe && cached && this.now() < kept.freshUntil) {
      snapshot = cached;
    } else {
      const pending = kept.pending ?? {
        answer: load(cached?.sourceToken),
        invalidated: false,
      };
      kept.pending = pending;
      try {
        const result = await pending.answer;
        snapshot = result.kind === "unchanged" && cached ? cached : result;
        if (
          !pending.invalidated &&
          this.entries.get(key) === kept &&
          kept.pending === pending &&
          snapshot.kind === "snapshot"
        ) {
          this.bytes -= kept.snapshot ? snapshotBytes(kept.snapshot) : 0;
          kept.snapshot = snapshot;
          this.bytes += snapshotBytes(snapshot);
          kept.freshUntil = this.now() + SHARED_TRANSCRIPT_TTL_MS;
          for (const [oldKey, oldEntry] of Array.from(this.entries)) {
            if (this.bytes <= MAX_SHARED_TRANSCRIPT_BYTES) break;
            this.drop(oldKey, oldEntry);
          }
        }
      } finally {
        if (kept.pending === pending) kept.pending = undefined;
      }
    }
    if (snapshot.sourceToken && viewerToken === snapshot.sourceToken) {
      return { kind: "unchanged", sourceToken: snapshot.sourceToken };
    }
    return snapshot;
  }

  private drop(key: string, entry: SharedTranscript): void {
    this.entries.delete(key);
    this.bytes -= entry.snapshot ? snapshotBytes(entry.snapshot) : 0;
  }
}

function snapshotBytes(snapshot: Snapshot): number {
  return snapshot.bytes + Buffer.byteLength(JSON.stringify(snapshot.revisedMessages ?? [])) + 1024;
}
