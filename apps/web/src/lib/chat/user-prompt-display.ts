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
  MULTI_REVIEW_CUSTOM_FIX_PROMPT_CONTINUATION,
  REVIEW_EVIDENCE_FRAME_DISPLAY_CONTRACTS,
  STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT,
  STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION,
  SYSTEM_INSTRUCTIONS_FRAME_CLOSE,
  parseCoordinatorDelegatedPrompt,
  stripSystemInstructions,
  type ReviewEvidenceFrameDisplayContract,
  type UserPromptPresentationKind,
} from "@orkestrator/protocol/review-evidence-frames";
import {
  MULTI_REVIEW_ADDRESS_USER_INSTRUCTION,
  MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION,
  MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION,
} from "@orkestrator/protocol/multi-review";
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

function generatedReviewInstructionPresentation(source: string): UserPromptPresentation | null {
  const generatedPrompts = [
    `${MULTI_REVIEW_ADDRESS_USER_INSTRUCTION}\n\n${MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION}`,
    `${MULTI_REVIEW_ADDRESS_USER_INSTRUCTION}\n\n${MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION}`,
  ];
  // Provider echo can trim trailing whitespace but sometimes preserves it; fold
  // either form back to the short user-facing sentence.
  return generatedPrompts.includes(source.trim())
    ? { displayText: MULTI_REVIEW_ADDRESS_USER_INSTRUCTION, evidencePayload: null }
    : null;
}

function customFixPresentation(source: string): UserPromptPresentation | null {
  const instructionPrefix = `${MULTI_REVIEW_CUSTOM_FIX_INSTRUCTIONS_PREFIX}\n`;
  if (!source.startsWith(instructionPrefix)) return null;

  const contract = STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT;
  const close = source.lastIndexOf(contract.closeMarker);
  if (close < instructionPrefix.length) return null;
  // Current producers wrap the trailing continuation in a system-instructions
  // frame, so it is already gone once the frame is removed. The unwrapped
  // continuations are retained so transcripts produced before that still read.
  const afterFrame = stripSystemInstructions(
    source.slice(close + contract.closeMarker.length),
  ).trim();
  if (
    afterFrame !== "" &&
    afterFrame !== MULTI_REVIEW_CUSTOM_FIX_PROMPT_CONTINUATION &&
    afterFrame !== contract.continuationPrefix
  ) {
    return null;
  }

  const open = source.lastIndexOf(contract.openMarker, close);
  if (open < instructionPrefix.length) return null;
  const beforeFrame = source.slice(0, open);
  const hiddenContextSuffix = `\n\n${MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION}\n\n${STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION}\n\n`;
  // The context between the user's instruction and the framed report is
  // entirely backend-owned: either a closed system-instructions frame (current)
  // or the shared prose (legacy). Requiring one of them keeps a user who typed
  // a marker-shaped instruction from being mistaken for a produced frame.
  const wrappedContext = beforeFrame.trimEnd().endsWith(SYSTEM_INSTRUCTIONS_FRAME_CLOSE);
  if (!wrappedContext && !beforeFrame.endsWith(hiddenContextSuffix)) return null;

  const instruction = (
    wrappedContext
      ? stripSystemInstructions(beforeFrame.slice(instructionPrefix.length))
      : beforeFrame.slice(instructionPrefix.length).slice(0, -hiddenContextSuffix.length)
  ).trim();
  if (!instruction) return null;

  const evidenceSource = source.slice(open + contract.openMarker.length, close).trim();
  const parsedEvidence = parseJsonPayload(evidenceSource);
  const instructionDisplay = boundedPromptDisplay(instruction).displayText;
  return {
    displayText: parsedEvidence
      ? instructionDisplay
      : `${instructionDisplay}\n\n${contract.omissionText}`,
    evidencePayload: parsedEvidence ? readableEvidencePayload(parsedEvidence) : null,
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
      if (contract === STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT && rendersEvidence) {
        const legacyInstructionPrefix = `${contract.continuationPrefix}\n\n${MULTI_REVIEW_CUSTOM_FIX_INSTRUCTIONS_PREFIX}\n`;
        const legacyInstructionSuffix = `\n\n${MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION}`;
        if (
          afterFrame.startsWith(legacyInstructionPrefix) &&
          afterFrame.endsWith(legacyInstructionSuffix)
        ) {
          const instruction = afterFrame.slice(
            legacyInstructionPrefix.length,
            afterFrame.length - legacyInstructionSuffix.length,
          );
          if (instruction.trim()) {
            return {
              displayText: evidencePayload
                ? instruction
                : `${instruction}\n\n${contract.omissionText}`,
              evidencePayload,
            };
          }
        }
      }
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
  const customFix = customFixPresentation(displaySource);
  if (customFix !== null) {
    return delegation ? withCoordinatorDelegationNotice(customFix) : customFix;
  }
  const generatedReviewInstruction = generatedReviewInstructionPresentation(displaySource);
  if (generatedReviewInstruction !== null) {
    return delegation
      ? withCoordinatorDelegationNotice(generatedReviewInstruction)
      : generatedReviewInstruction;
  }
  // Backend producers wrap their provider-only guidance in a
  // system-instructions frame. Once it is removed, whatever remains is exactly
  // what the user wrote, so it is shown without any structural reconstruction.
  const strippedSystemInstructions = stripSystemInstructions(displaySource);
  if (strippedSystemInstructions !== displaySource) {
    const presentation = boundedPromptDisplay(strippedSystemInstructions);
    return delegation ? withCoordinatorDelegationNotice(presentation) : presentation;
  }
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
