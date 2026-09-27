import { useEffect, useState } from "react";
import { Camera } from "lucide-react";
import type {
  WebAnnotationCapture,
  WebAnnotationCheck,
  WebAnnotationComparisonMetadata,
  WebAnnotationOutcome,
  WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { loadWebAnnotationCapture } from "@/lib/web-annotations/assets";
import { AnnotationImage } from "./AnnotationImage";
import { useAnnotationPanel } from "./panel-context";
import {
  captureConditionsLabel,
  citedEvidenceLabel,
  comparisonLabels,
  fileCheckLabel,
  hasAgentReport,
  targetMatchLabel,
} from "./result-labels";

const OUTCOME_LABELS: Record<WebAnnotationOutcome, string> = {
  addressed: "Agent reports: addressed",
  "partly-addressed": "Agent reports: partly addressed",
  "not-addressed": "Agent reports: not addressed",
  "needs-clarification": "Agent needs clarification",
  unreported: "No outcome reported",
};

const CHECK_OUTCOME: Record<WebAnnotationCheck["outcome"], string> = {
  passed: "passed",
  failed: "failed",
  "not-run": "not run",
  unavailable: "unavailable",
};

function useCapture(environmentId: string, captureId: string | null) {
  const [capture, setCapture] = useState<WebAnnotationCapture | null>(null);
  useEffect(() => {
    if (!captureId) return;
    let cancelled = false;
    void loadWebAnnotationCapture(environmentId, captureId).then((loaded) => {
      if (!cancelled) setCapture(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [captureId, environmentId]);
  return capture;
}

function Comparison({
  environmentId,
  beforeCaptureId,
  afterCaptureId,
  comparison,
}: {
  environmentId: string;
  beforeCaptureId: string | null;
  afterCaptureId: string;
  comparison?: WebAnnotationComparisonMetadata | null;
}) {
  const recorded = comparison ?? null;
  const before = useCapture(environmentId, recorded?.comparedCaptureId ?? beforeCaptureId);
  const after = useCapture(environmentId, afterCaptureId);
  const labels = comparisonLabels(before, after, recorded);
  const metadata = recorded ?? after?.comparison ?? null;
  const conditions = metadata ? captureConditionsLabel(metadata) : null;
  return (
    <div className="space-y-1" data-comparison={afterCaptureId}>
      <div className="grid grid-cols-2 gap-1.5">
        <figure className="space-y-0.5">
          <figcaption className="text-[10px] text-muted-foreground">Original capture</figcaption>
          <AnnotationImage
            environmentId={environmentId}
            assetId={before?.assetIds[0] ?? null}
            alt="Original capture"
          />
        </figure>
        <figure className="space-y-0.5">
          <figcaption className="text-[10px] text-muted-foreground">
            Current result (your capture)
          </figcaption>
          <AnnotationImage
            environmentId={environmentId}
            assetId={after?.assetIds[0] ?? null}
            alt="Current result capture"
          />
        </figure>
      </div>
      {conditions && (
        <p className="text-[10px] text-muted-foreground" data-capture-conditions>
          {conditions}
        </p>
      )}
      {metadata && (
        <p className="text-[10px] text-muted-foreground">
          {targetMatchLabel(metadata.targetMatch)}
        </p>
      )}
      {labels.map((label) => (
        <p key={label} className="text-[10px] text-amber-200">
          {label}. Compare with care: these images are not directly comparable.
        </p>
      ))}
    </div>
  );
}

function AgentReport({
  result,
  annotationId,
  originalCaptureId,
}: {
  result: WebAnnotationResult;
  annotationId: string;
  originalCaptureId: string | null;
}) {
  const outcome = result.outcomes.find((item) => item.annotationId === annotationId);
  const cited = citedEvidenceLabel(result, originalCaptureId);
  const carried =
    typeof result.reportedRevision === "number" && result.reportedRevision !== result.revision;
  return (
    <section
      aria-label="Agent report"
      className="space-y-1 rounded border border-border/60 p-1.5"
      data-agent-report={result.reportedRevision ?? result.revision}
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Reported by the agent{carried ? ` (report revision ${result.reportedRevision})` : ""}
      </p>
      {result.provisional && (
        <p className="text-muted-foreground">Provisional report — the turn has not finished.</p>
      )}
      <p>{outcome ? OUTCOME_LABELS[outcome.outcome] : OUTCOME_LABELS.unreported}</p>
      {outcome?.note && <p className="whitespace-pre-wrap text-muted-foreground">{outcome.note}</p>}
      {result.summary && <p className="whitespace-pre-wrap">{result.summary}</p>}
      {result.files.length > 0 && (
        <div>
          <p className="text-muted-foreground">Files the agent reports changing:</p>
          <ul className="list-inside list-disc font-mono text-[10px]">
            {result.files.slice(0, 20).map((file) => (
              <li key={file} className="truncate">
                {file}
              </li>
            ))}
          </ul>
          {result.files.length > 20 && (
            <p className="text-muted-foreground">+{result.files.length - 20} more</p>
          )}
        </div>
      )}
      {result.checks.length > 0 && (
        <ul aria-label="Checks" className="space-y-0.5">
          {result.checks.map((check, index) => (
            <li key={`${check.description}-${index}`}>
              <span className={check.outcome === "failed" ? "text-destructive" : undefined}>
                {check.description}: {CHECK_OUTCOME[check.outcome]}
              </span>{" "}
              <span className="text-muted-foreground">
                (
                {check.provenance === "app-observed" ? "observed by Orkestrator" : "agent-reported"}
                )
              </span>
            </li>
          ))}
        </ul>
      )}
      {cited && <p className="text-muted-foreground">{cited}</p>}
      {result.limitations.length > 0 && (
        <p className="text-muted-foreground">Limitations: {result.limitations.join("; ")}</p>
      )}
      {result.questions.length > 0 && (
        <p className="text-amber-200">Open questions: {result.questions.join("; ")}</p>
      )}
    </section>
  );
}

function ObservedByOrkestrator({
  result,
  annotationId,
  originalCaptureId,
  environmentId,
}: {
  result: WebAnnotationResult;
  annotationId: string;
  originalCaptureId: string | null;
  environmentId: string;
}) {
  const observations = (result.observations ?? []).filter(
    (observation) => observation.annotationId === annotationId,
  );
  const observed = new Set((result.observations ?? []).map((item) => item.captureId));
  // Captures recorded before observations existed (older backends).
  const legacy = result.captureIds.filter((captureId) => !observed.has(captureId));
  const fileChecks = result.fileChecks ?? [];
  if (observations.length === 0 && legacy.length === 0 && fileChecks.length === 0) return null;
  return (
    <section
      aria-label="Observed by Orkestrator"
      className="space-y-1 rounded border border-border/60 p-1.5"
      data-app-observed
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Observed by Orkestrator
      </p>
      {fileChecks.length > 0 && (
        <div>
          <p className="text-muted-foreground">Reported files, checked by Orkestrator:</p>
          <ul className="space-y-0.5 font-mono text-[10px]" aria-label="File checks">
            {fileChecks.slice(0, 20).map((check) => (
              <li
                key={check.path}
                className={check.status === "exists" ? undefined : "text-amber-200"}
                data-file-check={check.status}
              >
                <span className="truncate">{check.path}</span>
                <span className="font-sans text-muted-foreground">
                  {" "}
                  — {fileCheckLabel(check.status)}
                </span>
              </li>
            ))}
          </ul>
          {fileChecks.length > 20 && (
            <p className="text-muted-foreground">+{fileChecks.length - 20} more</p>
          )}
        </div>
      )}
      {observations.map((observation) => (
        <Comparison
          key={observation.captureId}
          environmentId={environmentId}
          beforeCaptureId={originalCaptureId}
          afterCaptureId={observation.captureId}
          comparison={observation.comparison}
        />
      ))}
      {legacy.map((captureId) => (
        <Comparison
          key={captureId}
          environmentId={environmentId}
          beforeCaptureId={originalCaptureId}
          afterCaptureId={captureId}
        />
      ))}
    </section>
  );
}

/**
 * Agent-reported results and app-observed evidence (after-captures, file
 * checks), always in separate sections: an agent claim is never presented as
 * something Orkestrator saw. Nothing here resolves the note.
 */
export function ResultReview({
  result,
  annotationId,
  originalCaptureId,
  requestId,
  historical,
}: {
  result: WebAnnotationResult | null;
  annotationId: string;
  originalCaptureId: string | null;
  requestId: string;
  historical?: boolean;
}) {
  const { environmentId, features, capture } = useAnnotationPanel();
  const reported = result ? hasAgentReport(result) : false;
  return (
    <div className="space-y-1.5 text-[11px]" data-result={result?.id ?? "none"}>
      {historical && (
        <p className="text-amber-200">
          Historical result: it answered an older version of this note.
        </p>
      )}
      {result && reported && (
        <AgentReport
          result={result}
          annotationId={annotationId}
          originalCaptureId={originalCaptureId}
        />
      )}
      {!reported && (
        <p className="text-muted-foreground">
          No structured result was reported. Review the response and the workspace changes.
        </p>
      )}
      {result && (
        <ObservedByOrkestrator
          result={result}
          annotationId={annotationId}
          originalCaptureId={originalCaptureId}
          environmentId={environmentId}
        />
      )}
      {features.comparison && capture.available && !historical && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-[11px]"
          disabled={capture.selecting}
          onClick={() =>
            // No annotationId option: this must never replace the note's own
            // capture. The intent names the note so batch results attribute it.
            void capture.start("page", {
              intent: { kind: "result", requestId, annotationId, createdAt: Date.now() },
              // The desktop waits for a stable layout and reapplies the
              // original capture's masks to the after-image.
              result: {
                requestId,
                ...(originalCaptureId ? { originalCaptureId } : {}),
              },
            })
          }
        >
          <Camera className="h-3 w-3" aria-hidden />
          Capture current result
        </Button>
      )}
    </div>
  );
}
