import type {
  BrowserPreviewElementAncestor,
  BrowserPreviewElementDetails,
} from "@orkestrator/protocol/browser-preview";
import type { WorkspaceAttachment } from "@/components/chat/NativeAttachmentMenu";
import {
  MAX_TRANSCRIPT_ANNOTATIONS,
  normalizeTranscriptAnnotationText,
  type TranscriptAnnotation,
} from "@/lib/chat/transcript-annotations";
import { MAX_PROMPT_ATTACHMENTS } from "@/lib/chat/workspace-attachments";
import { createSessionKey } from "@/lib/utils";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

function hierarchyLine(ancestor: BrowserPreviewElementAncestor): string {
  const metadata = [
    ancestor.id ? `id=${JSON.stringify(ancestor.id)}` : null,
    ancestor.role ? `role=${JSON.stringify(ancestor.role)}` : null,
    ancestor.ariaLabel ? `aria-label=${JSON.stringify(ancestor.ariaLabel)}` : null,
    ancestor.testId ? `data-testid=${JSON.stringify(ancestor.testId)}` : null,
  ].filter(Boolean);
  return `${ancestor.selector}${metadata.length > 0 ? ` (${metadata.join(", ")})` : ""}`;
}

export function formatBrowserElementAnnotation(
  element: BrowserPreviewElementDetails,
  screenshotPath: string,
): string {
  const rect = element.rect;
  return normalizeTranscriptAnnotationText(
    [
      "Browser element annotation",
      `Page: ${element.pageTitle || "Untitled"} (${element.pageUrl})`,
      `Screenshot: ${screenshotPath}`,
      `Element: <${element.tagName}> (${Math.round(rect.width)}×${Math.round(rect.height)} at ${Math.round(rect.left)}, ${Math.round(rect.top)})`,
      `Best selector: ${element.selector}`,
      `CSS path: ${element.cssPath}`,
      `XPath: ${element.xpath}`,
      `DOM hierarchy:\n${element.hierarchy.map((ancestor) => `  - ${hierarchyLine(ancestor)}`).join("\n")}`,
      `Attributes: ${JSON.stringify(element.attributes, null, 2)}`,
      `Computed styles: ${JSON.stringify(element.styles, null, 2)}`,
      `Visible text: ${JSON.stringify(element.text)}`,
      `Outer HTML:\n${element.outerHtml}`,
      `Viewport: ${element.viewport.width}×${element.viewport.height} at ${element.viewport.devicePixelRatio}x device pixel ratio`,
    ].join("\n\n"),
  );
}

export interface AddBrowserAnnotationResult {
  sessionCount: number;
  annotationSkippedCount: number;
  screenshotSkippedCount: number;
}

export function addBrowserAnnotationToOpenNativeSessions(input: {
  environmentId: string;
  annotation: TranscriptAnnotation;
  screenshot: WorkspaceAttachment;
}): AddBrowserAnnotationResult {
  const tabs = usePaneLayoutStore
    .getState()
    .getAllTabs(input.environmentId)
    .filter((tab) => tab.type === "agent-native");
  const compose = useNativeComposeStore.getState();
  let sessionCount = 0;
  let annotationSkippedCount = 0;
  let screenshotSkippedCount = 0;

  for (const tab of tabs) {
    const sessionKey = createSessionKey(input.environmentId, tab.id);
    const current = compose.drafts.get(sessionKey);
    const annotations = current?.annotations ?? [];
    const attachments = current?.attachments ?? [];
    if (annotations.length >= MAX_TRANSCRIPT_ANNOTATIONS) {
      annotationSkippedCount += 1;
      continue;
    }
    const canAddScreenshot = attachments.length < MAX_PROMPT_ATTACHMENTS;
    compose.updateDraft(sessionKey, {
      annotations: [...annotations, input.annotation],
      attachments: canAddScreenshot ? [...attachments, input.screenshot] : attachments,
    });
    sessionCount += 1;
    if (!canAddScreenshot) screenshotSkippedCount += 1;
  }

  return { sessionCount, annotationSkippedCount, screenshotSkippedCount };
}
