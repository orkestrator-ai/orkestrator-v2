import { wrapSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";
import {
  buildPromptWithTranscriptAnnotations,
  sendableTranscriptAnnotations,
  type TranscriptAnnotation,
} from "./transcript-annotations";

export function designAgentInstructions(canvasId: string): string {
  return wrapSystemInstructions(
    [
      `Use the orkestrator-design MCP server for this design workspace. Canvas ID: ${canvasId}.`,
      "Start with get_canvas_summary, then get_frame for the frames you need; avoid get_canvas on large designs because it returns every frame's HTML.",
      "Review the current repository, then build HTML/CSS mockups in this canvas. Designs must be self-contained, with embedded CSS and data-URL images/fonts; authored scripts and remote resources are blocked.",
      'Pass response:"compact" on mutations so they do not echo HTML. Edit with the frame revision you last read; on a revision conflict, re-read the frame and reapply your change rather than retrying blindly.',
      "Use capture_frame to review your work visually.",
      "To save the design into the repository, use save_canvas (not export_canvas plus file tools). Never overwrite an existing file unless you pass the replaceFingerprint reported for it; otherwise choose a new file path.",
    ].join("\n"),
  );
}

function isOpeningContext(tabId: string, annotation: TranscriptAnnotation): boolean {
  return annotation.source === "design" && annotation.id === `${tabId}-design-context`;
}

export function hasStandaloneAnnotations(
  tabId: string,
  annotations: readonly TranscriptAnnotation[],
): boolean {
  return sendableTranscriptAnnotations(annotations).some(
    (annotation) => !isOpeningContext(tabId, annotation),
  );
}

export function hasDesignOpeningContext(
  tabId: string,
  annotations: readonly TranscriptAnnotation[],
): boolean {
  return annotations.some(
    (annotation) => isOpeningContext(tabId, annotation) && !annotation.migratedTo,
  );
}

export const DESIGN_OPENING_COMMAND_REFUSAL =
  "Remove the design context before sending a slash command.";

export function buildNativeComposerPrompt(
  prompt: string,
  tabId: string,
  annotations: readonly TranscriptAnnotation[],
): string {
  const starter = annotations.find(
    (annotation) => isOpeningContext(tabId, annotation) && !annotation.migratedTo,
  );
  if (!starter) return buildPromptWithTranscriptAnnotations(prompt, annotations);

  // Match the app-generated starter, including drafts saved before guidance
  // moved out of the chip. Only the canvas identifier enters the instructions.
  const [heading, name, identity] = starter.text.split("\n", 3);
  const canvasId =
    /^Canvas ID: ([a-zA-Z0-9_-]+)$/.exec(identity ?? "")?.[1] ??
    /^Use the orkestrator-design MCP server for this design workspace\. Canvas ID: ([a-zA-Z0-9_-]+)\.$/.exec(
      identity ?? "",
    )?.[1];
  if (heading !== "Design workspace" || !name?.startsWith("Canvas: ") || !canvasId) {
    return buildPromptWithTranscriptAnnotations(prompt, annotations);
  }
  const references = annotations.map((annotation) =>
    annotation === starter
      ? { ...starter, text: `${heading}\n${name}\nCanvas ID: ${canvasId}` }
      : annotation,
  );
  return `${designAgentInstructions(canvasId)}\n\n${buildPromptWithTranscriptAnnotations(prompt, references)}`;
}
