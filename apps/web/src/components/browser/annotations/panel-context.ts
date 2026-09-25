import { createContext, useContext } from "react";
import type { BrowserPreviewCaptureMode } from "@orkestrator/protocol/browser-preview";
import type {
  WebAnnotation,
  WebAnnotationAnchorResolution,
  WebAnnotationPageIdentity,
} from "@orkestrator/protocol/web-annotations";
import type { WebAnnotationFeatureFlags } from "@/lib/web-annotations/client";
import type { CurrentAnnotationPage } from "./format";
import type { AnnotationCaptureController } from "./useAnnotationCapture";

export type ShowOnPageResult =
  | { status: "shown"; navigated?: boolean }
  /** A different service/port: the user can open it explicitly. */
  | { status: "off-page"; route: string }
  | { status: "not-found"; reason: string; resolution?: WebAnnotationAnchorResolution }
  /** The saved address cannot be reconstructed; the user navigates and reselects. */
  | { status: "navigation-required"; reason: string }
  | { status: "timeout" }
  | { status: "navigation-failed"; reason: string }
  | { status: "unavailable"; reason: string };

export interface PreviewNavigationResult {
  ok: boolean;
  message?: string;
}

export interface AnnotationPanelContextValue {
  environmentId: string;
  tabId: string;
  features: WebAnnotationFeatureFlags;
  capture: AnnotationCaptureController;
  captureMode: BrowserPreviewCaptureMode;
  setCaptureMode: (mode: BrowserPreviewCaptureMode) => void;
  supportedModes: BrowserPreviewCaptureMode[];
  currentPage: CurrentAnnotationPage | null;
  /** Polite live-region announcement (state changes, save errors). */
  announce: (message: string) => void;
  selectAnnotation: (annotationId: string | null) => void;
  /** Navigate the preview to a logical page. Only ever called on user action. */
  navigateToPage: (page: WebAnnotationPageIdentity) => PreviewNavigationResult;
  /**
   * Show a note's target: on the current page, or (desktop contract 2) by
   * navigating the preview to its route, waiting, resolving, and scrolling.
   */
  showOnPage: (
    annotation: WebAnnotation,
    options?: { navigate?: boolean },
  ) => Promise<ShowOnPageResult>;
  /** Latest live anchor results for pins on the current page. */
  pinResults: ReadonlyMap<string, WebAnnotationAnchorResolution>;
}

export const AnnotationPanelContext = createContext<AnnotationPanelContextValue | null>(null);

export function useAnnotationPanel(): AnnotationPanelContextValue {
  const value = useContext(AnnotationPanelContext);
  if (!value) throw new Error("Annotation components must render inside AnnotationPanel");
  return value;
}
