/**
 * Captures graph agent activations' display transcripts for the run view
 * (item 211), the way build-pipeline sessions keep theirs: provider messages
 * in the content-addressed transcript store (`build-pipeline-transcript-store.ts`,
 * owner `graph-run:<run id>`, one session per activation key), referenced
 * from the activation's session as a `PipelineTranscriptReference`.
 *
 * The agent executor calls the capture on every observation of a running
 * turn. It reads and stores the transcript when the turn is settling (the
 * last look) or when `intervalMs` passed since this activation's last
 * capture, and only stores content that changed (a fingerprint over every
 * message). It returns the new reference for the executor to record, or
 * undefined when nothing changed or the store refused it; it never throws,
 * so display data can never fail an activation. Logs carry ids only.
 *
 * Memory is bounded: the last capture of at most {@link MAX_TRACKED}
 * activations, oldest forgotten first (a forgotten one re-reads the
 * committed manifest's fingerprint on its next capture).
 */
import type { PipelineTranscriptReference } from "@orkestrator/protocol/build-pipeline";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";

/** Default spacing of captures while a turn runs. */
export const GRAPH_RUN_TRANSCRIPT_CAPTURE_INTERVAL_MS = 15_000;
const MAX_TRACKED = 256;

export interface GraphRunTranscriptStorage {
  commitGraphRunTranscript(input: {
    runId: string;
    activationKey: string;
    sdkSessionId: string;
    messages: readonly unknown[];
    revision: number;
    fingerprint: string;
  }): Promise<PipelineTranscriptReference | null>;
  describeGraphRunTranscript(
    runId: string,
    activationKey: string,
  ): Promise<{ reference: PipelineTranscriptReference; fingerprint: string } | null>;
}

export interface GraphRunTranscriptCaptureInput {
  runId: string;
  activationKey: string;
  providerSessionId: string;
  readTranscript: () => Promise<readonly unknown[]>;
  /** The turn is settling: always capture (this may be the last look). */
  settling: boolean;
}

export type GraphRunTranscriptCapture = (
  input: GraphRunTranscriptCaptureInput,
) => Promise<PipelineTranscriptReference | undefined>;

interface LastCapture {
  at: number;
  fingerprint?: string;
  revision: number;
}

export function createGraphRunTranscriptCapture(options: {
  storage: GraphRunTranscriptStorage;
  intervalMs?: number;
  clock?: () => number;
  maxTracked?: number;
}): GraphRunTranscriptCapture {
  const intervalMs = options.intervalMs ?? GRAPH_RUN_TRANSCRIPT_CAPTURE_INTERVAL_MS;
  const clock = options.clock ?? (() => Date.now());
  const maxTracked = options.maxTracked ?? MAX_TRACKED;
  const last = new Map<string, LastCapture>();
  const remember = (key: string, entry: LastCapture) => {
    last.delete(key);
    last.set(key, entry);
    while (last.size > maxTracked) last.delete(last.keys().next().value!);
  };

  return async (input) => {
    const key = `${input.runId}\0${input.activationKey}`;
    const now = clock();
    const previous = last.get(key);
    if (!input.settling && previous && now - previous.at < intervalMs) return undefined;
    try {
      const messages = await input.readTranscript();
      const fingerprint = transcriptFingerprint(messages);
      if (previous?.fingerprint === fingerprint) {
        remember(key, { ...previous, at: now });
        return undefined;
      }
      let revision = previous?.revision ?? 0;
      if (!previous) {
        const committed = await options.storage.describeGraphRunTranscript(
          input.runId,
          input.activationKey,
        );
        if (committed) {
          revision = committed.reference.revision;
          if (committed.fingerprint === fingerprint) {
            remember(key, { at: now, fingerprint, revision });
            return committed.reference;
          }
        }
      }
      if (messages.length === 0) {
        remember(key, { at: now, revision });
        return undefined;
      }
      const reference = await options.storage.commitGraphRunTranscript({
        runId: input.runId,
        activationKey: input.activationKey,
        sdkSessionId: input.providerSessionId,
        messages,
        revision: revision + 1,
        fingerprint,
      });
      if (!reference) {
        // Refused (quota, a concurrent checkpoint): try again next interval.
        remember(key, { at: now, revision });
        return undefined;
      }
      remember(key, { at: now, fingerprint, revision: reference.revision });
      return reference;
    } catch {
      console.warn(`[graph-runs] Transcript capture failed for run ${input.runId}`);
      remember(key, { at: now, revision: previous?.revision ?? 0 });
      return undefined;
    }
  };
}
