import {
  webAnnotationPageKey,
  type WebAnnotationAnchorResolution,
  type WebAnnotationPageIdentity,
  type WebAnnotationServiceIdentity,
  type WebAnnotationSummary,
  type WebAnnotationTargetKind,
} from "@orkestrator/protocol/web-annotations";
import { sanitizeWebAnnotationUrl } from "@orkestrator/protocol/web-annotations-validation";
import type { BrowserPreviewCaptureMode } from "@orkestrator/protocol/browser-preview";
import { formatRelativeTime } from "@/lib/format-relative-time";

/** The logical page a browser tab currently shows (never a transport URL). */
export interface CurrentAnnotationPage {
  service: WebAnnotationServiceIdentity;
  route: string;
  pageKey: string;
  label: string;
}

export function currentPageForService(serviceId: string, path: string, label?: string) {
  const { route } = sanitizeWebAnnotationUrl(
    `http://preview.invalid${path.startsWith("/") ? path : `/${path}`}`,
  );
  const service: WebAnnotationServiceIdentity = { kind: "service", serviceId };
  return {
    service,
    route,
    pageKey: webAnnotationPageKey({ service, route }),
    label: label ? `${label}${route}` : route,
  } satisfies CurrentAnnotationPage;
}

export function currentPageForManualUrl(displayUrl: string): CurrentAnnotationPage | null {
  if (!displayUrl) return null;
  let url: URL;
  try {
    url = new URL(displayUrl);
  } catch {
    return null;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const service: WebAnnotationServiceIdentity =
    Number.isSafeInteger(port) && port > 0 ? { kind: "port", port } : { kind: "unknown" };
  const { route } = sanitizeWebAnnotationUrl(url.toString());
  return {
    service,
    route,
    pageKey: webAnnotationPageKey({ service, route }),
    label: `${url.host}${route}`,
  };
}

export function samePage(
  page: Pick<WebAnnotationPageIdentity, "service" | "route">,
  current: CurrentAnnotationPage | null,
): boolean {
  return Boolean(current) && webAnnotationPageKey(page) === current!.pageKey;
}

/** Same logical server (service id or port), whatever the route. */
export function sameService(
  page: Pick<WebAnnotationPageIdentity, "service">,
  current: CurrentAnnotationPage | null,
): boolean {
  if (!current) return false;
  const a = page.service;
  const b = current.service;
  if (a.kind === "service" && b.kind === "service") return a.serviceId === b.serviceId;
  if (a.kind === "port" && b.kind === "port") return a.port === b.port;
  return false;
}

export function viewportLabel(
  viewport: { width: number; height: number } | null | undefined,
): string | null {
  if (!viewport || !viewport.width || !viewport.height) return null;
  return `${Math.round(viewport.width)}×${Math.round(viewport.height)}`;
}

const ANCHOR_STATE_LABELS: Record<WebAnnotationAnchorResolution["state"], string> = {
  matched: "Found on the page",
  missing: "Not found on the page",
  ambiguous: "Several possible matches; not placed",
  stale: "The target changed since it was captured",
  unsupported: "Inside a frame or shadow root that cannot be searched",
  "too-complex": "The page was too large to search in time",
};

/** Explainable anchor state for a live pin (no confidence scores). */
export function anchorStateLabel(resolution: WebAnnotationAnchorResolution): string {
  if (resolution.offPage) return "On another page";
  if (resolution.historical) {
    return "Layout changed since capture: this region is historical evidence. Recapture to update it.";
  }
  return ANCHOR_STATE_LABELS[resolution.state];
}

export function pageLabel(page: WebAnnotationPageIdentity): string {
  const route = page.route || "/";
  return page.title ? `${page.title} · ${route}` : route;
}

export function annotationTitle(annotation: Pick<WebAnnotationSummary, "title" | "targetLabel">) {
  return annotation.title.trim() || annotation.targetLabel || "Untitled note";
}

export function lastActivity(value: string): string {
  return formatRelativeTime(value);
}

export const TARGET_KIND_LABELS: Record<WebAnnotationTargetKind, string> = {
  element: "Element",
  "text-range": "Text",
  region: "Region",
  page: "Page",
  "legacy-unresolved": "Imported note",
};

export const CAPTURE_MODE_LABELS: Record<BrowserPreviewCaptureMode, string> = {
  element: "Element",
  text: "Text",
  region: "Region",
  page: "Page",
};

/** Target precision explanation shown next to a capture (step 13). */
export function targetPrecision(kind: WebAnnotationTargetKind): string {
  switch (kind) {
    case "element":
      return "Element notes can be found again after reloads when the element is still identifiable.";
    case "text-range":
      return "Text notes are found again by the quoted text and its surroundings.";
    case "region":
      return "Region notes are tied to the captured pixels; they are visual evidence only.";
    case "page":
      return "Page notes refer to the whole page, not an individual element.";
    case "legacy-unresolved":
      return "Imported from an older browser note. Reselect the target to attach current evidence.";
  }
}

export function annotationStateLabel(annotation: Pick<WebAnnotationSummary, "state">): string {
  if (annotation.state === "resolved") return "Resolved";
  if (annotation.state === "deleted") return "Deleted";
  return "Open";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
