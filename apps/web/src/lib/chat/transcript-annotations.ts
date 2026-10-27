import type { TranscriptAnnotationSource } from "@orkestrator/protocol/transcript-annotations";

// The envelope lives in the protocol package so the backend can strip it from
// session titles with the same rules the renderer uses to display it.
export {
  MAX_TRANSCRIPT_ANNOTATIONS,
  MAX_TRANSCRIPT_ANNOTATION_COMMENT_LENGTH,
  MAX_TRANSCRIPT_ANNOTATION_TEXT_LENGTH,
  buildPromptWithTranscriptAnnotations,
  isTranscriptAnnotation,
  normalizeTranscriptAnnotationComment,
  normalizeTranscriptAnnotationText,
  parsePromptTranscriptReferences,
  sendableTranscriptAnnotations,
  stripTranscriptAnnotations,
} from "@orkestrator/protocol/transcript-annotations";
export type {
  PromptTranscriptReference,
  TranscriptAnnotation,
  TranscriptAnnotationSource,
} from "@orkestrator/protocol/transcript-annotations";

/** Short user-facing label for where an annotation came from. */
export function transcriptAnnotationSourceLabel(
  source: TranscriptAnnotationSource | undefined,
): string {
  if (source === "browser") return "Browser element";
  if (source === "design") return "Design context";
  return "Selected text";
}
