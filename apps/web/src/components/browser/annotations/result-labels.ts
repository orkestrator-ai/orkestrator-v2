/**
 * Labels for result review: comparison metadata of after-captures and the
 * backend's own checks of reported files. Pure, so the wording is testable
 * without rendering.
 */
import type {
  WebAnnotationCapture,
  WebAnnotationComparisonDifference,
  WebAnnotationComparisonMetadata,
  WebAnnotationFileCheckStatus,
  WebAnnotationResult,
  WebAnnotationResultCaptureMetadata,
} from "@orkestrator/protocol/web-annotations";

const DIFFERENCE_LABELS: Record<WebAnnotationComparisonDifference, string> = {
  route: "Different route",
  service: "Different service or port",
  viewport: "Different viewport",
  zoom: "Different preview zoom",
  "device-scale": "Different device scale",
  target: "The original target was not matched on this page",
  unstable: "Unstable capture: fonts or layout were still changing when it was taken",
};

export function comparisonDifferenceLabel(difference: WebAnnotationComparisonDifference): string {
  return DIFFERENCE_LABELS[difference];
}

export function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

/** "Zoom 110% · 2× device scale · scrolled 0,480 · stable" (only known parts). */
export function captureConditionsLabel(meta: WebAnnotationResultCaptureMetadata): string | null {
  const parts: string[] = [];
  if (typeof meta.zoomFactor === "number") parts.push(`Zoom ${percent(meta.zoomFactor)}`);
  if (typeof meta.deviceScaleFactor === "number") {
    parts.push(`${meta.deviceScaleFactor}× device scale`);
  }
  if (meta.scroll) {
    parts.push(`scrolled ${Math.round(meta.scroll.x)},${Math.round(meta.scroll.y)}`);
  }
  if (meta.stability) parts.push(meta.stability === "stable" ? "stable" : "unstable");
  if (meta.masks && meta.masks.length > 0) {
    parts.push(`${meta.masks.length} redaction${meta.masks.length === 1 ? "" : "s"} reapplied`);
  }
  return parts.length ? parts.join(" · ") : null;
}

const TARGET_MATCH: Record<WebAnnotationComparisonMetadata["targetMatch"], string> = {
  "same-target": "Same target as the original capture",
  "different-target": "A different target than the original capture",
  "no-target": "No target identity to compare",
};

export function targetMatchLabel(match: WebAnnotationComparisonMetadata["targetMatch"]): string {
  return TARGET_MATCH[match];
}

/** The desktop marks a result capture taken before layout settled as unstable. */
function isUnstable(capture: WebAnnotationCapture): boolean {
  return (
    capture.comparison?.stability === "unstable" ||
    (capture.state === "stale" &&
      /unstable|did not settle|not stable/i.test(capture.stateReason ?? ""))
  );
}

/**
 * Mismatch labels between the original and an after-capture. Backend
 * comparison metadata is authoritative when present; older records fall back
 * to comparing the two capture records.
 */
export function comparisonLabels(
  before: WebAnnotationCapture | null,
  after: WebAnnotationCapture | null,
  comparison?: WebAnnotationComparisonMetadata | null,
): string[] {
  const recorded = comparison ?? after?.comparison ?? null;
  if (recorded) {
    const labels = recorded.differences.map(comparisonDifferenceLabel);
    if (after && after.state !== "complete" && !recorded.differences.includes("unstable")) {
      labels.push(`After capture is ${after.state}`);
    }
    return labels;
  }
  if (!before || !after) return [];
  const labels: string[] = [];
  if (before.page.route !== after.page.route) {
    labels.push(`Different route (${before.page.route} → ${after.page.route})`);
  }
  const a = before.geometry?.viewport;
  const b = after.geometry?.viewport;
  if (a && b && (a.width !== b.width || a.height !== b.height)) {
    labels.push(`Different viewport (${a.width}×${a.height} → ${b.width}×${b.height})`);
  }
  const g1 = before.geometry;
  const g2 = after.geometry;
  if (g1 && g2) {
    if (Math.abs(g1.zoomFactor - g2.zoomFactor) > 0.001) {
      labels.push(`Different preview zoom (${percent(g1.zoomFactor)} → ${percent(g2.zoomFactor)})`);
    }
    if (Math.abs(g1.devicePixelRatio - g2.devicePixelRatio) > 0.001) {
      labels.push(`Different device scale (${g1.devicePixelRatio}× → ${g2.devicePixelRatio}×)`);
    }
    if (
      Math.round(g1.scroll.x) !== Math.round(g2.scroll.x) ||
      Math.round(g1.scroll.y) !== Math.round(g2.scroll.y)
    ) {
      labels.push(
        `Different scroll position (${Math.round(g1.scroll.x)},${Math.round(g1.scroll.y)} → ${Math.round(g2.scroll.x)},${Math.round(g2.scroll.y)})`,
      );
    }
  }
  if (isUnstable(after)) {
    labels.push("Unstable capture: fonts or layout were still changing when it was taken");
  } else if (after.state !== "complete") {
    labels.push(`After capture is ${after.state}`);
  }
  return labels;
}

const FILE_CHECK_LABELS: Record<WebAnnotationFileCheckStatus, string> = {
  exists: "found in the workspace",
  missing: "not found in the workspace",
  "outside-workspace": "outside the workspace",
  unavailable: "could not be checked",
};

export function fileCheckLabel(status: WebAnnotationFileCheckStatus): string {
  return FILE_CHECK_LABELS[status];
}

/** Whether this result revision carries an agent report (vs. only user captures). */
export function hasAgentReport(result: WebAnnotationResult): boolean {
  if (result.reportedRevision === undefined) return result.provenance === "agent-reported";
  return result.reportedRevision !== null;
}

/** Human labels for evidence ids the agent cites, relative to this note's capture. */
export function citedEvidenceLabel(
  result: WebAnnotationResult,
  originalCaptureId: string | null,
): string | null {
  const ids = result.evidenceIds ?? [];
  if (ids.length === 0) return null;
  const citesCapture = originalCaptureId !== null && ids.includes(originalCaptureId);
  const others = ids.length - (citesCapture ? 1 : 0);
  const parts: string[] = [];
  if (citesCapture) parts.push("this note's capture");
  if (others > 0) parts.push(`${others} other evidence item${others === 1 ? "" : "s"}`);
  return `The agent cites ${parts.join(" and ")}.`;
}
