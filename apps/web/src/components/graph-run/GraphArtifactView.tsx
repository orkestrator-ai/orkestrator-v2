import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Loader2 } from "lucide-react";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import {
  graphPromptValueText,
  lookupGraphPromptPath,
  renderGraphPromptSource,
} from "@orkestrator/protocol/graphs/prompts";
import type { GraphRunArtifactView } from "@orkestrator/protocol/graphs/run-view";
import { GraphTypeLibrary, type GraphTypeDefinition } from "@orkestrator/protocol/graphs/types";
import { isStructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { StructuredReviewReportView } from "@/components/review/StructuredReviewReportView";
import { cn } from "@/lib/utils";
import { graphRunCacheKey, useGraphRunStore } from "@/stores/graphRunStore";

/**
 * One artifact on a port, rendered by its type (plan P2.11): a built-in
 * formatter (a review report as the review view shows it), else the type's
 * markdown template, else its summary fields, else the value as JSON. A
 * reference artifact shows its sealed file's path, hash and size, never the
 * file. The value is read when the card is opened, and only a value within
 * the read bound comes back (`graph_run_artifact`).
 */

const MAX_JSON_PREVIEW_CHARS = 64 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The named type a reference resolves to in the run's frozen plan. */
export function graphArtifactTypeDefinition(
  plan: CompiledGraphPlan,
  type: string,
): GraphTypeDefinition | null {
  const resolved = new GraphTypeLibrary(plan.types).resolve(type);
  return resolved.ok && resolved.type.kind === "named" ? resolved.type.definition : null;
}

function jsonText(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? "null";
  } catch {
    text = String(value);
  }
  return text.length > MAX_JSON_PREVIEW_CHARS
    ? `${text.slice(0, MAX_JSON_PREVIEW_CHARS)}\n… (${text.length - MAX_JSON_PREVIEW_CHARS} more characters)`
    : text;
}

/** How a value of `definition` renders. Exported for tests. */
export function graphArtifactRendering(
  definition: GraphTypeDefinition | null,
  value: unknown,
):
  | { kind: "review-report" }
  | { kind: "markdown"; text: string }
  | { kind: "summary"; rows: { field: string; text: string }[] }
  | { kind: "json"; text: string } {
  if (definition?.formatter === "structured-review-report" && isStructuredReviewReport(value)) {
    return { kind: "review-report" };
  }
  const markdown = definition?.render?.markdown;
  if (markdown) {
    const rendered = renderGraphPromptSource(markdown, value);
    if (rendered.text.trim()) return { kind: "markdown", text: rendered.text };
  }
  const summary = definition?.render?.summary;
  if (summary?.length) {
    return {
      kind: "summary",
      rows: summary.map((field) => {
        const found = lookupGraphPromptPath([value], field.split("."));
        return { field, text: (found.found ? graphPromptValueText(found.value) : null) ?? "—" };
      }),
    };
  }
  return { kind: "json", text: jsonText(value) };
}

function ArtifactBody({
  view,
  definition,
  sectionKey,
}: {
  view: GraphRunArtifactView;
  definition: GraphTypeDefinition | null;
  sectionKey: string;
}) {
  const rendering = useMemo(
    () => (view.value === undefined ? null : graphArtifactRendering(definition, view.value)),
    [definition, view.value],
  );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {view.file ? (
        <dl
          data-graph-artifact-file=""
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
        >
          <dt>File</dt>
          <dd className="truncate font-mono" title={view.file.path}>
            {view.file.path}
          </dd>
          <dt>SHA-256</dt>
          <dd className="truncate font-mono" title={view.file.sha256}>
            {view.file.sha256.slice(0, 16)}…
          </dd>
          <dt>Size</dt>
          <dd>{formatBytes(view.file.bytes)}</dd>
        </dl>
      ) : null}
      {view.valueOmitted === "too-large" ? (
        <p className="text-xs text-muted-foreground">
          The value is {formatBytes(view.artifact.bytes)}, too large to show here.
        </p>
      ) : null}
      {rendering?.kind === "review-report" && isStructuredReviewReport(view.value) ? (
        <StructuredReviewReportView
          report={view.value}
          collapsibleSections
          sectionExpansionKey={sectionKey}
          showRawJson={false}
        />
      ) : rendering?.kind === "markdown" ? (
        <div data-graph-artifact-render="markdown" className="min-w-0 text-sm">
          <MessageMarkdown content={rendering.text} />
        </div>
      ) : rendering?.kind === "summary" ? (
        <dl
          data-graph-artifact-render="summary"
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs"
        >
          {rendering.rows.map((row) => (
            <div key={row.field} className="contents">
              <dt className="font-mono text-muted-foreground">{row.field}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap">{row.text}</dd>
            </div>
          ))}
        </dl>
      ) : rendering?.kind === "json" ? (
        <pre
          data-graph-artifact-render="json"
          className="max-h-80 overflow-auto rounded-md bg-elevated p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap"
        >
          {rendering.text}
        </pre>
      ) : null}
    </div>
  );
}

export function GraphArtifactCard({
  runId,
  artifactId,
  plan,
  label,
  defaultOpen = false,
}: {
  runId: string;
  artifactId: string;
  plan: CompiledGraphPlan;
  /** The port the artifact is on. */
  label: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const entry = useGraphRunStore((state) =>
    state.artifacts.get(graphRunCacheKey(runId, artifactId)),
  );
  const loadArtifact = useGraphRunStore((state) => state.loadArtifact);
  useEffect(() => {
    if (open) void loadArtifact(runId, artifactId);
  }, [open, runId, artifactId, loadArtifact]);
  const view = entry?.view ?? null;
  const definition = useMemo(
    () => (view ? graphArtifactTypeDefinition(plan, view.artifact.type) : null),
    [plan, view],
  );
  const bodyId = useId();
  return (
    <section
      data-graph-artifact={artifactId}
      className="min-w-0 rounded-lg border border-border bg-sidebar/40"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{label}</span>
        {view ? (
          <span className="min-w-0 truncate font-mono text-muted-foreground">
            {definition?.label ?? view.artifact.type} · {formatBytes(view.artifact.bytes)}
            {view.artifact.itemIds?.length ? ` · ${view.artifact.itemIds.length} items` : ""}
          </span>
        ) : null}
        {view?.artifact.state === "superseded" ? (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">superseded</span>
        ) : null}
      </button>
      {open ? (
        <div id={bodyId} className={cn("border-t border-border px-2.5 py-2")}>
          {entry?.status === "error" || entry?.status === "missing" ? (
            <p role="alert" className="text-xs text-failure">
              Could not read the artifact: {entry.error}
            </p>
          ) : view ? (
            <ArtifactBody
              view={view}
              definition={definition}
              sectionKey={`graph-run/${runId}/${artifactId}`}
            />
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Reading the artifact…
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
