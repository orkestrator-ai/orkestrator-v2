import {
  REVIEW_VALIDATION_OUTPUT_MAX_BYTES,
  type ReviewValidationOutput,
  type ReviewValidationOutputStream,
  type ReviewValidationResult,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Loader2, RefreshCw, SquareTerminal } from "lucide-react";
import { toast } from "sonner";
import { getReviewValidationOutput } from "@/lib/backend";
import { stripAnsi } from "@/lib/terminal-utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function elapsedMs(startedAt: string, completedAt: string | undefined, now: number): number | null {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function reviewValidationElapsedMs(
  run: ReviewValidationRun,
  now = Date.now(),
): number | null {
  if (!run.completedAt && run.status !== "planned" && run.status !== "running") return null;
  return elapsedMs(run.startedAt, run.completedAt, now);
}

export function reviewValidationResultElapsedMs(
  result: ReviewValidationResult,
  now = Date.now(),
): number | null {
  if (result.status !== "running") return result.durationMs > 0 ? result.durationMs : null;
  if (!result.startedAt) return result.durationMs;
  const live = elapsedMs(result.startedAt, undefined, now);
  return live === null ? result.durationMs : Math.max(result.durationMs, live);
}

function decodeOutput(stream: ReviewValidationOutputStream | null): string {
  if (!stream?.contentBase64) return "";
  const binary = atob(stream.contentBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return stripAnsi(new TextDecoder().decode(bytes));
}

function byteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function streamOutput(
  label: "stdout" | "stderr",
  stream: ReviewValidationOutputStream | null,
): string {
  const content = decodeOutput(stream);
  if (!stream || (!content && stream.totalBytes === 0)) return "";
  const omitted = stream.startOffset > 0 ? `… earlier ${label} omitted …\n` : "";
  return `${omitted}${content}`;
}

function ValidationOutputModal({
  environmentId,
  run,
  result,
  open,
  onOpenChange,
  loadOutput,
}: {
  environmentId: string;
  run: ReviewValidationRun;
  result: ReviewValidationResult | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadOutput: typeof getReviewValidationOutput;
}) {
  const [output, setOutput] = useState<ReviewValidationOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const hasArtifacts = Boolean(result?.stdoutPath || result?.stderrPath);

  const refresh = useCallback(async () => {
    if (!open || !result || !hasArtifacts) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadOutput(environmentId, run.id, result.id);
      if (requestId !== requestIdRef.current) return;
      setOutput(next);
    } catch (reason) {
      if (requestId !== requestIdRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [environmentId, hasArtifacts, loadOutput, open, result, run.id]);

  useEffect(() => {
    if (!open) {
      requestIdRef.current += 1;
      setOutput(null);
      setError(null);
      setLoading(false);
      return;
    }
    void refresh();
    if (result?.status !== "running") return;
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [open, refresh, result?.status]);

  const stdout = useMemo(() => streamOutput("stdout", output?.stdout ?? null), [output]);
  const stderr = useMemo(() => streamOutput("stderr", output?.stderr ?? null), [output]);
  const combinedOutput = useMemo(
    () =>
      [stdout ? `stdout\n${stdout}` : "", stderr ? `stderr\n${stderr}` : ""]
        .filter(Boolean)
        .join("\n\n"),
    [stderr, stdout],
  );

  const copyOutput = useCallback(async () => {
    if (!combinedOutput) return;
    try {
      await navigator.clipboard.writeText(combinedOutput);
      toast.success("Validation output copied");
    } catch {
      toast.error("Failed to copy validation output");
    }
  }, [combinedOutput]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(44rem,calc(100dvh-2rem))] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl sm:p-0">
        <DialogHeader className="shrink-0 border-b border-divider px-5 py-4 pr-14 sm:px-6 sm:pr-14">
          <div className="flex min-w-0 items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-base">
                <SquareTerminal className="size-4 shrink-0" />
                Terminal output
              </DialogTitle>
              <DialogDescription className="mt-2 break-all font-mono text-xs text-foreground/80">
                {result?.command ?? "Validation command"}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Refresh terminal output"
                disabled={!hasArtifacts || loading}
                onClick={() => void refresh()}
              >
                <RefreshCw className={loading ? "animate-spin" : undefined} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Copy terminal output"
                disabled={!combinedOutput}
                onClick={() => void copyOutput()}
              >
                <Copy />
              </Button>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-200 sm:p-5">
          {loading && !output ? (
            <div className="flex h-full items-center justify-center gap-2 text-zinc-400">
              <Loader2 className="size-4 animate-spin" />
              Loading output…
            </div>
          ) : error ? (
            <div role="alert" className="whitespace-pre-wrap text-red-300">
              {error}
            </div>
          ) : combinedOutput ? (
            <pre className="whitespace-pre-wrap break-words font-mono">{combinedOutput}</pre>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-zinc-500">
              {result?.status === "pending"
                ? "This step has not started yet."
                : result?.status === "skipped"
                  ? "This step was skipped, so it has no terminal output."
                  : "This step has not produced any terminal output."}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-divider px-5 py-2 text-[11px] text-muted-foreground sm:px-6">
          <span>{output?.status ?? result?.status ?? "pending"}</span>
          <span>
            {output
              ? [
                  output.stdout ? `stdout ${byteCount(output.stdout.totalBytes)}` : "",
                  output.stderr ? `stderr ${byteCount(output.stderr.totalBytes)}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "No output"
              : hasArtifacts
                ? `Up to the latest ${byteCount(REVIEW_VALIDATION_OUTPUT_MAX_BYTES)} per stream`
                : "No output file"}
            {result?.status === "running" ? " · updating live" : ""}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Snapshot projection plus an on-demand bounded log reader; lifecycle remains backend-owned. */
export function ReviewValidationStatus({
  environmentId,
  run,
  now = Date.now(),
  loadOutput = getReviewValidationOutput,
}: {
  environmentId: string;
  run: ReviewValidationRun;
  /** Parent-owned live clock, so every running row advances on the same tick. */
  now?: number;
  loadOutput?: typeof getReviewValidationOutput;
}) {
  const validationElapsedMs = reviewValidationElapsedMs(run, now);
  const notes = run.plan.limitations;
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const selectedResult = run.results.find((result) => result.id === selectedResultId);

  return (
    <section
      aria-label="Review validation"
      className="rounded-lg border border-border/60 bg-card/35 p-3 text-xs"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-semibold">Validation</h3>
        <span className="text-muted-foreground">
          {run.status === "planned" ? "Queued" : run.status}
        </span>
      </div>
      <p className="mb-2 text-muted-foreground">
        {run.discoveryDurationMs !== undefined &&
          `Discovery and snapshot: ${(run.discoveryDurationMs / 1000).toFixed(1)}s. `}
        {validationElapsedMs !== null &&
          `Validation: ${(validationElapsedMs / 1000).toFixed(1)}s. `}
        {run.sealingDurationMs !== undefined &&
          `Packaging: ${(run.sealingDurationMs / 1000).toFixed(1)}s.`}
      </p>
      <ul className="space-y-2">
        {run.results.map((result) => {
          const resultElapsedMs = reviewValidationResultElapsedMs(result, now);
          return (
            <li key={result.id} className="min-w-0">
              <button
                type="button"
                className="w-full cursor-pointer rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                aria-label={`View terminal output for ${result.command}`}
                onClick={() => setSelectedResultId(result.id)}
              >
                <span className="flex items-start justify-between gap-3">
                  <code className="min-w-0 break-all">{result.command}</code>
                  <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    {result.status}
                    {resultElapsedMs !== null ? ` · ${(resultElapsedMs / 1000).toFixed(1)}s` : ""}
                    <SquareTerminal className="size-3.5 opacity-60" aria-hidden="true" />
                  </span>
                </span>
                {result.limitation && (
                  <span className="mt-1 block text-muted-foreground">
                    <span className="sr-only">{result.command}: </span>
                    {result.limitation}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {notes.length > 0 && (
        <details className="mt-3 rounded-md border border-border/45 bg-background/30 px-3 py-2 text-foreground">
          <summary className="cursor-pointer select-none text-xs font-medium">Notes</summary>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed">
            {notes.map((note, index) => (
              <li key={index} className="flex gap-2">
                <span className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                <span className="min-w-0">{note}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {run.error && <p className="mt-2 text-destructive">{run.error}</p>}
      <p className="mt-2 text-muted-foreground">
        Command output is saved as review evidence. Independent checks run concurrently when their
        resource requirements allow it.
      </p>
      <ValidationOutputModal
        key={selectedResultId ?? "closed"}
        environmentId={environmentId}
        run={run}
        result={selectedResult}
        open={selectedResult !== undefined}
        onOpenChange={(open) => !open && setSelectedResultId(null)}
        loadOutput={loadOutput}
      />
    </section>
  );
}
