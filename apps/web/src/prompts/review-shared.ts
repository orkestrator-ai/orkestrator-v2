/**
 * Compatibility facade for the shared review workflow contract.
 *
 * The implementation lives in the protocol package so interactive reviews and
 * automated backend reviews cannot silently drift apart.
 */
export {
  buildReviewBody,
  buildReviewInstructionBlock,
  DEFAULT_REVIEW_INSTRUCTION,
  resolveReviewInstruction,
  REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN,
  type ReviewBodyOptions,
} from "@orkestrator/protocol/review-workflow";
