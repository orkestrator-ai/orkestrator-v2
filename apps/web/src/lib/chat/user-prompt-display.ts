/**
 * Removes backend-only evidence frames from the text shown in a user bubble.
 *
 * The provider must still receive and retain the complete prompt. This helper
 * is presentation-only: copy actions continue to use the original source.
 */
import {
  REVIEW_EVIDENCE_FRAME_DISPLAY_CONTRACTS,
  type ReviewEvidenceFrameDisplayContract,
} from "@orkestrator/protocol/review-evidence-frames";

function displayTextForContract(
  source: string,
  contract: ReviewEvidenceFrameDisplayContract,
): string | null {
  if (!source.trimStart().startsWith(contract.promptPrefix)) return null;

  const open = source.indexOf(contract.openMarker);
  if (open < 0) return null;

  // Search backwards for the last close that owns the expected continuation.
  // Reviewer JSON may contain marker-shaped strings, while later dynamic text
  // (including a valid Git branch name) may contain another close marker.
  let close = source.lastIndexOf(contract.closeMarker);
  while (close > open) {
    const afterFrame = source.slice(close + contract.closeMarker.length).trimStart();
    if (afterFrame.startsWith(contract.continuationPrefix)) {
      return `${source.slice(0, open).trimEnd()}\n\n${contract.omissionText}\n\n${afterFrame}`;
    }
    close = source.lastIndexOf(contract.closeMarker, close - 1);
  }

  return null;
}

/** Hide the reviewer-report JSON that already has a structured presentation. */
export function userPromptDisplayText(source: string): string {
  for (const contract of REVIEW_EVIDENCE_FRAME_DISPLAY_CONTRACTS) {
    const displayed = displayTextForContract(source, contract);
    if (displayed !== null) return displayed;
  }
  return source;
}
