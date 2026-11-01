/**
 * Compatibility facade: every workflow prompt is built by the protocol package
 * so the renderer, the backend's public actions and the CLI cannot drift apart.
 */
export {
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  REVIEW_PROMPT_TARGET_BRANCH_TOKEN,
  createReviewPrompt,
  createPushChangesPrompt,
} from "@orkestrator/protocol/git-workflow-prompts";
export { createPRPrompt, createResolveConflictsPrompt } from "@orkestrator/protocol/pr-prompt";
export { createOrkestratorScriptPrompt } from "@orkestrator/protocol/orkestrator-script-prompt";

export {
  buildReviewInstructionBlock,
  DEFAULT_REVIEW_INSTRUCTION,
  resolveReviewInstruction,
  REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN,
} from "./review-shared";
