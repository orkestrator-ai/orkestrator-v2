/**
 * The turn-end after-capture prompt (to-do 0047 task 3). When a request's turn
 * has finished and this note has no after-capture yet, the request card offers
 * a one-click capture of what the preview shows now. Nothing here captures,
 * navigates or reloads by itself: the user presses the button, and the capture
 * is the same `result` capture the manual button takes (stable-geometry
 * window, original masks reapplied).
 */
import type {
  WebAnnotationPageIdentity,
  WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";
import { samePage, type CurrentAnnotationPage } from "./format";

export type ResultCapturePromptState =
  /** The turn is still reporting or this review is no longer current: manual button only. */
  | { kind: "not-ready" }
  /** This note already has an after-capture in the current result. */
  | { kind: "captured" }
  /** Offer the capture; `samePage` says whether the preview shows the note's page. */
  | { kind: "ready"; samePage: boolean };

/** Whether the result already holds an after-capture for this note. */
export function hasAfterCapture(result: WebAnnotationResult | null, annotationId: string): boolean {
  if (!result) return false;
  const observations = result.observations ?? [];
  if (observations.some((observation) => observation.annotationId === annotationId)) return true;
  // Captures recorded before observations existed name no note; treat them
  // as this note's, as the review section does.
  const observed = new Set(observations.map((observation) => observation.captureId));
  return result.captureIds.some((captureId) => !observed.has(captureId));
}

export function resultCapturePromptState(input: {
  result: WebAnnotationResult | null;
  promptEligible?: boolean;
  annotationId: string;
  page: Pick<WebAnnotationPageIdentity, "service" | "route">;
  currentPage: CurrentAnnotationPage | null;
}): ResultCapturePromptState {
  if (input.promptEligible === false || input.result?.provisional) return { kind: "not-ready" };
  if (hasAfterCapture(input.result, input.annotationId)) return { kind: "captured" };
  return { kind: "ready", samePage: samePage(input.page, input.currentPage) };
}

/**
 * Prompts the user set aside with "Not now", for this renderer session. Kept
 * outside React so closing and reopening the thread does not offer it again;
 * the manual button stays available either way.
 */
const dismissed = new Set<string>();
const MAX_DISMISSED = 500;

function dismissalKey(environmentId: string, requestId: string, annotationId: string) {
  return JSON.stringify([environmentId, requestId, annotationId]);
}

export function isResultCapturePromptDismissed(
  environmentId: string,
  requestId: string,
  annotationId: string,
): boolean {
  return dismissed.has(dismissalKey(environmentId, requestId, annotationId));
}

export function dismissResultCapturePrompt(
  environmentId: string,
  requestId: string,
  annotationId: string,
): void {
  if (dismissed.size >= MAX_DISMISSED) {
    const oldest = dismissed.values().next().value;
    if (oldest !== undefined) dismissed.delete(oldest);
  }
  dismissed.add(dismissalKey(environmentId, requestId, annotationId));
}

export function resetResultCapturePromptsForTests(): void {
  dismissed.clear();
}
