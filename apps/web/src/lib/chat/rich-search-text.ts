import { parseChartSpec, type ChartSpecV1 } from "@orkestrator/protocol/chart-spec";
import {
  validateWorkflowSnapshot,
  type WorkflowSnapshotV1,
} from "@orkestrator/protocol/workflow-snapshot";
import { readTranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts-validation";
import type { NativeArtifactPart } from "./native-message-types";

/**
 * Searchable plain text for rich blocks whose visible text is not the
 * Markdown source: chart labels and published artifact summaries. Only
 * authoritative, already-loaded text is indexed; nothing here fetches an
 * artifact body or executes content.
 */

/** Chart title, description, notes, axis labels, series/category/slice labels. */
export function chartSpecSearchText(spec: ChartSpecV1): string {
  const parts: string[] = [spec.title, spec.description, ...(spec.sourceNotes ?? [])];
  switch (spec.kind) {
    case "bar":
      parts.push(spec.xAxis.label, spec.yAxis.label, spec.yAxis.unit ?? "");
      parts.push(...spec.categories.map((category) => category.label));
      parts.push(...spec.series.map((series) => series.label));
      break;
    case "line":
    case "area":
    case "scatter":
      parts.push(spec.xAxis.label, spec.xAxis.unit ?? "", spec.yAxis.label, spec.yAxis.unit ?? "");
      parts.push(...spec.series.map((series) => series.label));
      break;
    case "donut":
      parts.push(spec.valueLabel, spec.unit ?? "");
      parts.push(...spec.slices.map((slice) => slice.label));
      break;
  }
  return parts.filter((part) => part.trim().length > 0).join("\n");
}

/**
 * The textual artifact summary (`part.content`) plus the reference's title
 * and summary, so a match is found whether or not the card body has loaded.
 */
export function artifactPartSearchText(
  part: Pick<NativeArtifactPart, "content" | "artifact">,
): string {
  const artifact = part.artifact as Partial<NativeArtifactPart["artifact"]> | undefined;
  const title = typeof artifact?.title === "string" ? artifact.title : "";
  const summary = typeof artifact?.summary === "string" ? artifact.summary : "";
  const lines = [part.content, title, summary].filter((line) => line.trim().length > 0);
  return Array.from(new Set(lines)).join("\n");
}

/**
 * The artifact text find indexes: exactly the summary `ArtifactPart` shows in
 * its search root (the reference's summary, or the textual fallback for an
 * unreadable or unsupported reference). Indexing anything else would report
 * matches find cannot highlight.
 */
export function artifactVisibleSummary(
  part: Pick<NativeArtifactPart, "content" | "artifact">,
): string {
  const read = readTranscriptArtifactRef(part.artifact);
  if (read.status === "supported") return read.ref.summary;
  if (read.status === "unsupported") return read.summary || part.content;
  return part.content;
}

/** Bound on label text indexed for one loaded artifact body. */
export const MAX_ARTIFACT_BODY_SEARCH_CHARACTERS = 64 * 1024;

/** Snapshot title, description, node labels and edge labels. */
export function workflowSnapshotSearchText(snapshot: WorkflowSnapshotV1): string {
  const parts: string[] = [snapshot.title, snapshot.description];
  for (const node of snapshot.nodes) parts.push(node.label);
  for (const edge of snapshot.edges) parts.push(edge.label ?? "");
  return parts.filter((part) => part.trim().length > 0).join("\n");
}

/**
 * Searchable text of a loaded published artifact body, exactly as its card
 * renders it in the body search root: chart labels (from the stored chart
 * JSON), workflow labels (from the stored snapshot JSON), or Mermaid source
 * (only while the card shows its source view). Null when the body does not
 * validate — the card then shows no body search root.
 */
export function artifactBodySearchText(
  body: "chart" | "workflow-snapshot" | "mermaid-source",
  data: string,
): string | null {
  let text: string;
  if (body === "mermaid-source") {
    // The source view renders the exact source text.
    return data.length > 0 ? data : null;
  }
  if (body === "chart") {
    const parsed = parseChartSpec(data);
    if (!parsed.ok) return null;
    text = chartSpecSearchText(parsed.value);
  } else {
    try {
      const parsed = validateWorkflowSnapshot(JSON.parse(data));
      if (!parsed.ok) return null;
      text = workflowSnapshotSearchText(parsed.value);
    } catch {
      return null;
    }
  }
  if (text.length > MAX_ARTIFACT_BODY_SEARCH_CHARACTERS) {
    text = text.slice(0, MAX_ARTIFACT_BODY_SEARCH_CHARACTERS);
  }
  return text.length > 0 ? text : null;
}

/**
 * The search segments of one artifact part, in the order its card renders
 * its search roots: the visible summary, then the loaded body text (if the
 * card has loaded and shown it). `body` comes from the synchronous cache the
 * card fills (`cachedArtifactSearchBody` in `artifact-requests.ts`); until a
 * body is loaded only the summary is indexed.
 */
export function artifactPartSearchSegments(
  part: Pick<NativeArtifactPart, "content" | "artifact">,
  body: string | null,
): string[] {
  const segments: string[] = [];
  const summary = artifactVisibleSummary(part);
  if (summary) segments.push(summary);
  if (body && readTranscriptArtifactRef(part.artifact).status === "supported") segments.push(body);
  return segments;
}
