/**
 * Web page annotations UI. The panel is environment-scoped: it can be hosted
 * by any browser tab (including a fresh one opened with "all pages") when the
 * tab that captured a note is gone; see `openWebAnnotationThread`.
 */
export { AnnotationPanel, type AnnotationPanelProps } from "./AnnotationPanel";
export { AnnotatedPreviewArea, AnnotationsButton } from "./BrowserAnnotationsLayout";
export { useBrowserAnnotations, type BrowserAnnotationsController } from "./useBrowserAnnotations";
export { useAnnotationCapture, type AnnotationCaptureController } from "./useAnnotationCapture";
export {
  openWebAnnotationRequest,
  openWebAnnotationThread,
} from "@/lib/web-annotations/navigation";
