import { useState } from "react";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import type { BrowserPreviewCaptureDiagnostics } from "@orkestrator/protocol/browser-preview";
import {
  WEB_ANNOTATION_COMMANDS,
  type WebAnnotationMetricsSnapshot,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { writeText } from "@/lib/native/clipboard";
import { getBrowserPreviewCaptureApi } from "@/lib/native/browser-preview";
import { describeWebAnnotationError, webAnnotationCommand } from "@/lib/web-annotations/client";
import { formatBytes } from "@/components/browser/annotations/format";

/** Everything the panel shows and copies. Content-free by construction. */
export interface WebAnnotationDiagnosticsExport {
  backend: WebAnnotationMetricsSnapshot;
  /** This desktop app's spool and anchor counters; null in other clients. */
  desktop: BrowserPreviewCaptureDiagnostics | null;
}

function total(counters: Record<string, number>, prefix: string, filter?: string): number {
  let sum = 0;
  for (const [key, value] of Object.entries(counters)) {
    if (key.startsWith(prefix) && (!filter || key.includes(filter))) sum += value;
  }
  return sum;
}

function meanMs(snapshot: WebAnnotationMetricsSnapshot, prefix: string): string {
  let count = 0;
  let totalMs = 0;
  for (const [key, value] of Object.entries(snapshot.durations)) {
    if (!key.startsWith(prefix)) continue;
    count += value.count;
    totalMs += value.totalMs;
  }
  if (count === 0) return "none yet";
  const mean = totalMs / count;
  return `${count} · mean ${mean >= 60_000 ? `${(mean / 60_000).toFixed(1)} min` : `${Math.round(mean / 1000)} s`}`;
}

/** Headline lines for a snapshot; every number comes from a categorical series. */
export function diagnosticsSummary(data: WebAnnotationDiagnosticsExport): string[] {
  const counters = data.backend.counters;
  const lines = [
    `Requests sent: ${total(counters, "requests_created|")}`,
    `Turn outcomes: ${total(counters, "request_turn_outcomes|", "outcome=completed")} completed, ${total(counters, "request_turn_outcomes|", "outcome=failed")} failed, ${total(counters, "request_turn_outcomes|", "outcome=unknown")} unknown`,
    `Evidence sections omitted by the budget: ${total(counters, "evidence_omitted|")}`,
    `Notes reopened: ${total(counters, "annotations_reopened")}`,
    `Accepted results: ${meanMs(data.backend, "acceptance_ms|")}`,
  ];
  if (data.desktop?.spool) {
    const spool = data.desktop.spool;
    lines.push(
      `Pending captures on this desktop: ${spool.pending} of ${spool.maxPending}, ${formatBytes(spool.imageBytes)} of ${formatBytes(spool.maxImageBytes)}`,
    );
  }
  if (data.desktop) {
    const resolutions = Object.values(data.desktop.anchorResolutions).reduce((a, b) => a + b, 0);
    const matched = Object.entries(data.desktop.anchorResolutions)
      .filter(([key]) => key.startsWith("matched|"))
      .reduce((sum, [, value]) => sum + value, 0);
    lines.push(`Pins resolved on this desktop: ${resolutions} (${matched} matched)`);
  }
  if (data.backend.droppedSeries > 0) {
    lines.push(`Series dropped at the bound: ${data.backend.droppedSeries}`);
  }
  return lines;
}

/**
 * On-demand view of the backend's web annotation metrics and this desktop's
 * capture counters, with a JSON copy for bug reports. Series are categorical
 * (no ids, URLs, selectors, text or paths), so the copy is safe to share.
 */
export function WebAnnotationDiagnostics() {
  const [data, setData] = useState<WebAnnotationDiagnosticsExport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const backend = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.metrics, {});
      const desktop =
        (await getBrowserPreviewCaptureApi()
          ?.getCaptureDiagnostics?.()
          .catch(() => null)) ?? null;
      setData({ backend, desktop });
    } catch (loadError) {
      setError(describeWebAnnotationError(loadError));
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!data) return;
    try {
      await writeText(JSON.stringify(data, null, 2));
      setCopied(true);
    } catch {
      setError("Could not copy the diagnostics.");
    }
  };

  return (
    <div className="space-y-1.5" data-web-annotation-diagnostics>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium">Diagnostics</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-[11px]"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-3 w-3" aria-hidden />
          )}
          {data ? "Refresh" : "Load diagnostics"}
        </Button>
        {data && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => void copy()}
          >
            <Copy className="h-3 w-3" aria-hidden />
            {copied ? "Copied" : "Copy as JSON"}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Counts since this backend started. They hold no page content, ids or paths.
      </p>
      {data && (
        <ul className="space-y-0.5 text-[11px]" aria-label="Web annotation diagnostics">
          {diagnosticsSummary(data).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
