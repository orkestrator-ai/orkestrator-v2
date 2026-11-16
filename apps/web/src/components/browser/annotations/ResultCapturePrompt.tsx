import { useState } from "react";
import { Camera } from "lucide-react";
import type {
  WebAnnotationPageIdentity,
  WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { pageLabel } from "./format";
import { useAnnotationPanel } from "./panel-context";
import {
  dismissResultCapturePrompt,
  isResultCapturePromptDismissed,
  resultCapturePromptState,
} from "./result-capture-prompt";

/**
 * Capture current result, offered as a prompt once the turn has finished and
 * this note has no after-capture yet (to-do 0047 task 3), otherwise as the
 * plain manual button. Either way the user starts the capture: it never
 * navigates or reloads the preview, so whatever sign-in or form state the
 * user set up is what gets captured.
 */
export function ResultCapture({
  result,
  promptEligible = true,
  annotationId,
  page,
  originalCaptureId,
  requestId,
}: {
  result: WebAnnotationResult | null;
  promptEligible?: boolean;
  annotationId: string;
  page: WebAnnotationPageIdentity;
  originalCaptureId: string | null;
  requestId: string;
}) {
  const { environmentId, capture, currentPage } = useAnnotationPanel();
  const [dismissed, setDismissed] = useState(() =>
    isResultCapturePromptDismissed(environmentId, requestId, annotationId),
  );
  const state = resultCapturePromptState({
    result,
    annotationId,
    page,
    currentPage,
    promptEligible,
  });
  const masks = capture.desktopCapabilities?.features.resultCapture.masks ?? false;

  const start = () =>
    // No annotationId option: this must never replace the note's own
    // capture. The intent names the note so batch results attribute it.
    void capture.start("page", {
      intent: { kind: "result", requestId, annotationId, createdAt: Date.now() },
      // The desktop waits for a stable layout and reapplies the original
      // capture's masks to the after-image.
      result: {
        requestId,
        ...(originalCaptureId ? { originalCaptureId } : {}),
      },
    });

  const captureButton = (primary: boolean) => (
    <Button
      type="button"
      size="sm"
      variant={primary ? "default" : "outline"}
      className="h-6 gap-1 px-2 text-[11px]"
      disabled={capture.selecting}
      onClick={start}
    >
      <Camera className="h-3 w-3" aria-hidden />
      Capture current result
    </Button>
  );

  if (state.kind !== "ready" || dismissed) return captureButton(false);

  return (
    <section
      aria-label="Capture the result"
      className="space-y-1 rounded border border-primary/40 bg-primary/5 p-1.5"
      data-result-capture-prompt={state.samePage ? "same-page" : "other-page"}
    >
      <p>
        The turn has finished. Capture what the preview shows now to compare it with the original.
      </p>
      {state.samePage ? (
        <p className="text-muted-foreground">The preview is on this note’s page.</p>
      ) : (
        <p className="text-amber-200">
          {currentPage
            ? `The preview shows ${currentPage.label}, not this note’s page (${pageLabel(page)}).`
            : `The preview is not showing this note’s page (${pageLabel(page)}).`}{" "}
          Use Open updated page first, or capture what the preview shows.
        </p>
      )}
      <p className="text-muted-foreground">
        Capturing never navigates or reloads the page
        {masks
          ? "; it waits for the layout to settle and reapplies the original capture’s redactions"
          : ""}
        . If the change only shows after signing in or filling a form, set that up in the preview
        first.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {captureButton(true)}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => {
            dismissResultCapturePrompt(environmentId, requestId, annotationId);
            setDismissed(true);
          }}
        >
          Not now
        </Button>
      </div>
    </section>
  );
}
