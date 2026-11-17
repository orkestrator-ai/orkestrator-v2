/**
 * The Address → Verify handoff: what Verify reads about this round's Address
 * stage (`docs/architecture/review-preparation.md`).
 *
 * An Address session opened with a `fix-result` slot carries the marker
 * `addressFindingsReportKind` and, once the backend accepts its result, a bounded copy
 * in `addressFindingsResult`; Verify reads that copy as an evidence frame. An Address
 * session without the marker (one started before the typed handoff) has no
 * report: Verify is told none is available.
 */
import {
  isSupersededPipelineSession,
  type BuildPipeline,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import type { VerificationAddressFindingsReport } from "./build-pipeline-prompts.js";

/**
 * This round's live Address session after its latest review, or undefined.
 * Only an Address session after the latest review counts, so an earlier
 * round's report is never mistaken for evidence about this one, and a round
 * whose clean review went straight to Verify has none.
 */
export function roundAddressFindingsSession(pipeline: BuildPipeline): PipelineSession | undefined {
  let address: PipelineSession | undefined;
  for (let index = pipeline.sessions.length - 1; index >= 0; index -= 1) {
    const session = pipeline.sessions[index]!;
    if (session.iteration !== pipeline.iteration) return undefined;
    if (session.phase === "review") return address;
    if (!address && session.phase === "address-findings" && !isSupersededPipelineSession(session)) {
      address = session;
    }
  }
  return undefined;
}

/**
 * The Address report Verify reads for this round: the accepted typed result,
 * or undefined when there is none. The session's transcript is never read as
 * a report: a session that was skipped, never had its result accepted, or
 * carries no typed marker has no report.
 */
export function verificationAddressFindingsReport(
  pipeline: BuildPipeline,
): VerificationAddressFindingsReport | undefined {
  const address = roundAddressFindingsSession(pipeline);
  if (address?.addressFindingsReportKind === undefined || !address.addressFindingsResult)
    return undefined;
  return { kind: "fix-result", result: address.addressFindingsResult };
}
