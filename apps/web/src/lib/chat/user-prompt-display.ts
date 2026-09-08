/**
 * Removes backend-only evidence frames from the text shown in a user bubble.
 *
 * The provider must still receive and retain the complete prompt. This helper
 * is presentation-only: copy actions continue to use the original source.
 */
import {
  COORDINATOR_DELEGATION_OMISSION_TEXT,
  COORDINATOR_DELEGATION_PRESENTATION,
  MULTI_REVIEW_CUSTOM_FIX_INSTRUCTIONS_PREFIX,
  REVIEW_EVIDENCE_FRAME_DISPLAY_CONTRACTS,
  STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT,
  parseCoordinatorDelegatedPrompt,
  type ReviewEvidenceFrameDisplayContract,
  type UserPromptPresentationKind,
} from "@orkestrator/protocol/review-evidence-frames";
import { parseJsonPayload, type JsonPayload } from "./json-payload";

export interface UserPromptPresentation {
  displayText: string;
  /** A fix prompt's framed report, rendered after its visible instructions. */
  evidencePayload: JsonPayload | null;
}

/** Keep legacy inline evidence from monopolising the renderer's Markdown pass. */
export const USER_PROMPT_RENDER_CHARACTER_LIMIT = 24_000;

function withCoordinatorDelegationNotice(
  presentation: UserPromptPresentation,
): UserPromptPresentation {
  return {
    ...presentation,
    displayText: presentation.displayText
      ? `${COORDINATOR_DELEGATION_OMISSION_TEXT}\n\n${presentation.displayText}`
      : COORDINATOR_DELEGATION_OMISSION_TEXT,
  };
}

function boundedPromptDisplay(source: string): UserPromptPresentation {
  if (source.length <= USER_PROMPT_RENDER_CHARACTER_LIMIT) {
    return { displayText: source, evidencePayload: null };
  }
  const omitted = source.length - USER_PROMPT_RENDER_CHARACTER_LIMIT;
  return {
    displayText: `${source.slice(0, USER_PROMPT_RENDER_CHARACTER_LIMIT)}\n\n[${omitted} additional characters omitted from the transcript view to keep it responsive. Copy the message to access the complete prompt.]`,
    evidencePayload: null,
  };
}

/** Decode the prompt-only escaping before exposing the evidence as readable JSON. */
function readableEvidencePayload(payload: JsonPayload): JsonPayload {
  return {
    ...payload,
    source: JSON.stringify(JSON.parse(payload.source), null, 2),
  };
}

function presentationForContract(
  source: string,
  contract: ReviewEvidenceFrameDisplayContract,
): UserPromptPresentation | null {
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
      const evidenceSource = source.slice(open + contract.openMarker.length, close).trim();
      const rendersEvidence =
        contract === STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT &&
        afterFrame.startsWith(
          `${contract.continuationPrefix}\n\n${MULTI_REVIEW_CUSTOM_FIX_INSTRUCTIONS_PREFIX}\n`,
        );
      const parsedEvidence = rendersEvidence ? parseJsonPayload(evidenceSource) : null;
      const evidencePayload = parsedEvidence ? readableEvidencePayload(parsedEvidence) : null;
      const beforeFrame = source.slice(0, open).trimEnd();
      return {
        displayText: evidencePayload
          ? `${beforeFrame}\n\n${afterFrame}`
          : `${beforeFrame}\n\n${contract.omissionText}\n\n${afterFrame}`,
        evidencePayload,
      };
    }
    close = source.lastIndexOf(contract.closeMarker, close - 1);
  }

  return null;
}

/** Build the visible prompt and any structured evidence rendered beneath it. */
export function userPromptPresentation(
  source: string,
  promptPresentation?: UserPromptPresentationKind,
): UserPromptPresentation {
  const delegation =
    promptPresentation === COORDINATOR_DELEGATION_PRESENTATION
      ? parseCoordinatorDelegatedPrompt(source)
      : null;
  const displaySource = delegation?.source ?? source;
  for (const contract of REVIEW_EVIDENCE_FRAME_DISPLAY_CONTRACTS) {
    const presentation = presentationForContract(displaySource, contract);
    if (presentation !== null) {
      return delegation ? withCoordinatorDelegationNotice(presentation) : presentation;
    }
  }
  const presentation = boundedPromptDisplay(displaySource);
  return delegation ? withCoordinatorDelegationNotice(presentation) : presentation;
}

/** Hide the reviewer-report JSON that already has a structured presentation. */
export function userPromptDisplayText(
  source: string,
  promptPresentation?: UserPromptPresentationKind,
): string {
  return userPromptPresentation(source, promptPresentation).displayText;
}
