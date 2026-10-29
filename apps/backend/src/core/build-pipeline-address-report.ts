/**
 * The Address → Verify handoff: what Verify reads about this round's Address
 * stage (`docs/architecture/review-preparation.md`).
 *
 * An Address session opened with a `fix-result` slot carries the marker
 * `addressReportKind` and, once the backend accepts its result, a bounded copy
 * in `fixResult`; Verify reads that copy as an evidence frame. An Address
 * session without the marker started before the typed handoff existed, and
 * Verify reads its last assistant text instead, as it always did. That
 * fallback is a counted compatibility path
 * (`build-pipeline.address-text-report`).
 */
import {
  isSupersededPipelineSession,
  type BuildPipeline,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import type { VerificationAddressReport } from "./build-pipeline-prompts.js";
import type { BuildPipelineTranscriptCheckpoints } from "./build-pipeline-transcript-checkpoints.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { LAST_ASSISTANT_TEXT_READ_LIMIT, lastAssistantText } from "./workflow-result-missing.js";

/**
 * This round's live Address session after its latest review, or undefined.
 * Only an Address session after the latest review counts, so an earlier
 * round's report is never mistaken for evidence about this one, and a round
 * whose clean review went straight to Verify has none.
 */
export function roundAddressSession(pipeline: BuildPipeline): PipelineSession | undefined {
  let address: PipelineSession | undefined;
  for (let index = pipeline.sessions.length - 1; index >= 0; index -= 1) {
    const session = pipeline.sessions[index]!;
    if (session.iteration !== pipeline.iteration) return undefined;
    if (session.phase === "review") return address;
    if (!address && session.phase === "address" && !isSupersededPipelineSession(session)) {
      address = session;
    }
  }
  return undefined;
}

/**
 * The Address report Verify reads for this round: the accepted typed result,
 * the legacy last assistant text, or undefined when there is none. A typed
 * session never falls back to its text: a session that was skipped or never
 * had its result accepted has no report.
 */
export async function verificationAddressReport(
  transcripts: BuildPipelineTranscriptCheckpoints,
  pipeline: BuildPipeline,
): Promise<VerificationAddressReport | undefined> {
  const address = roundAddressSession(pipeline);
  if (!address) return undefined;
  if (address.addressReportKind !== undefined) {
    return address.fixResult ? { kind: "fix-result", result: address.fixResult } : undefined;
  }
  compatibilityPathUsage.record("build-pipeline.address-text-report");
  const text = await latestAssistantReport(transcripts, pipeline.id, address);
  return text === undefined ? undefined : { kind: "text", text };
}

/**
 * The latest assistant text of a legacy Address session: what it fixed after
 * the recorded validation, what it re-checked, and which failures it excused.
 * Follow-up replies remain unverified claims, just like the original report.
 */
async function latestAssistantReport(
  transcripts: BuildPipelineTranscriptCheckpoints,
  pipelineId: string,
  address: PipelineSession,
): Promise<string | undefined> {
  // Display transcripts are best-effort. Never substitute an older report
  // when the latest attempt could not be checkpointed or its tail is missing.
  if (address.transcriptCheckpointError) return undefined;
  try {
    const transcript = await transcripts.window(
      pipelineId,
      address,
      LAST_ASSISTANT_TEXT_READ_LIMIT,
    );
    if (transcript.entries.at(-1)?.index !== transcript.total - 1) return undefined;
    // window() also includes the first row for handoffs. A disjoint first
    // row must not become a fallback report when the bounded tail has none.
    const tailStart = Math.max(0, transcript.total - LAST_ASSISTANT_TEXT_READ_LIMIT);
    return lastAssistantText(
      transcript.entries.filter(({ index }) => index >= tailStart).map(({ message }) => message),
    );
  } catch {
    return undefined;
  }
}
