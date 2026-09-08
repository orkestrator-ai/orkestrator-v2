import type {
  ReviewValidationResult,
  ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";

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

/** Projection only: no lifecycle, polling, or cancellation is owned by this view. */
export function ReviewValidationStatus({
  run,
  now = Date.now(),
}: {
  run: ReviewValidationRun;
  /** Parent-owned live clock, so every running row advances on the same tick. */
  now?: number;
}) {
  const validationElapsedMs = reviewValidationElapsedMs(run, now);
  const notes = run.plan.limitations;

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
              <div className="flex items-start justify-between gap-3">
                <code className="min-w-0 break-all">{result.command}</code>
                <span className="shrink-0 text-muted-foreground">
                  {result.status}
                  {resultElapsedMs !== null ? ` · ${(resultElapsedMs / 1000).toFixed(1)}s` : ""}
                </span>
              </div>
              {result.limitation && (
                <p className="mt-1 text-muted-foreground">
                  <span className="sr-only">{result.command}: </span>
                  {result.limitation}
                </p>
              )}
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
    </section>
  );
}
