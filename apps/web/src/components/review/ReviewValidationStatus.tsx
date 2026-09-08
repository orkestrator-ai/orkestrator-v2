import type { ReviewValidationRun } from "@orkestrator/protocol/review-workflow";

/** Projection only: no lifecycle, polling, or cancellation is owned by this view. */
export function ReviewValidationStatus({ run }: { run: ReviewValidationRun }) {
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
        {run.completedAt &&
          `Validation: ${Math.max(0, (Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)}s. `}
        {run.sealingDurationMs !== undefined &&
          `Packaging: ${(run.sealingDurationMs / 1000).toFixed(1)}s.`}
      </p>
      <ul className="space-y-2">
        {run.results.map((result) => (
          <li key={result.id} className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <code className="min-w-0 break-all">{result.command}</code>
              <span className="shrink-0 text-muted-foreground">
                {result.status}
                {result.durationMs > 0 ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ""}
              </span>
            </div>
            {result.limitation && <p className="mt-1 text-amber-500">{result.limitation}</p>}
          </li>
        ))}
      </ul>
      {run.plan.limitations.map((limitation, index) => (
        <p key={index} className="mt-2 text-amber-500">
          {limitation}
        </p>
      ))}
      {run.error && <p className="mt-2 text-destructive">{run.error}</p>}
      <p className="mt-2 text-muted-foreground">
        Command output is saved as review evidence. Independent checks run concurrently when their
        resource requirements allow it.
      </p>
    </section>
  );
}
