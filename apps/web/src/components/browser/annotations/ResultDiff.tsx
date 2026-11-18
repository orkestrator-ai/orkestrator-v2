import { useEffect, useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { WEB_ANNOTATION_COMMANDS } from "@orkestrator/protocol/web-annotations";
import type {
  WebAnnotationResultDiff,
  WebAnnotationResultDiffCompared,
} from "@orkestrator/protocol/web-annotations-diff";
import { Button } from "@/components/ui/button";
import { useWebAnnotationCache, useWebAnnotationScope } from "@/hooks/useWebAnnotations";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { loadWebAnnotationAsset } from "@/lib/web-annotations/assets";
import { describeWebAnnotationError, webAnnotationCommand } from "@/lib/web-annotations/client";

type DiffState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; diff: WebAnnotationResultDiff }
  | { kind: "error"; message: string };

/** Plain-language summary of a compared diff; never phrased as a pass or a fail. */
export function resultDiffSummary(diff: WebAnnotationResultDiffCompared): string {
  if (diff.changedPixels === 0) {
    return "No pixel changes were found in the compared area. That does not show the request was met.";
  }
  const percent = diff.changedRatio * 100;
  const share = percent >= 0.1 ? `${percent.toFixed(percent >= 10 ? 0 : 1)}%` : "less than 0.1%";
  const regions = diff.regions.length;
  const regionText = `${regions}${diff.truncatedRegions ? "+" : ""} changed region${regions === 1 && !diff.truncatedRegions ? "" : "s"}`;
  return `${regionText}, ${share} of the compared area.`;
}

function excludedSummary(diff: WebAnnotationResultDiffCompared): string | null {
  const parts: string[] = [];
  if (diff.excluded.masks > 0) {
    parts.push(`${diff.excluded.masks} redaction${diff.excluded.masks === 1 ? "" : "s"}`);
  }
  if (diff.excluded.unstableRegions > 0) {
    const count = diff.excluded.unstableRegions;
    parts.push(`${count} moving region${count === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? `Left out: ${parts.join(" and ")}.` : null;
}

/** The after-image with each changed region outlined, scaled exactly with the image. */
function DiffOverlay({
  environmentId,
  assetId,
  diff,
}: {
  environmentId: string;
  assetId: string;
  diff: WebAnnotationResultDiffCompared;
}) {
  const cache = useWebAnnotationCache(environmentId);
  const scope = useWebAnnotationScope();
  const asset = cache.assets.get(assetId);
  useEffect(() => {
    void loadWebAnnotationAsset(environmentId, assetId, scope);
  }, [assetId, environmentId, scope]);
  if (!asset?.url || diff.regions.length === 0) return null;
  const { width, height } = diff.image;
  const stroke = Math.max(2, Math.round(Math.max(width, height) / 300));
  return (
    <svg
      role="img"
      aria-label={`Current result with ${diff.regions.length} changed region${diff.regions.length === 1 ? "" : "s"} outlined`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      className="max-h-72 w-full rounded border border-border/60"
      data-diff-overlay
    >
      <image href={asset.url} width={width} height={height} />
      {diff.regions.map((region, index) => (
        <rect
          key={`${region.rect.x}-${region.rect.y}-${index}`}
          x={region.rect.x}
          y={region.rect.y}
          width={region.rect.width}
          height={region.rect.height}
          fill="rgba(244, 63, 94, 0.18)"
          stroke="rgb(244, 63, 94)"
          strokeWidth={stroke}
          data-diff-region
        />
      ))}
    </svg>
  );
}

/**
 * The advisory region diff of one after-capture against its original
 * (`operations.resultDiffs`). Fetched only when the user asks; captures are
 * immutable, so one answer per capture holds. Always labelled advisory: it
 * never accepts, resolves or reports anything.
 */
export function ResultDiff({
  environmentId,
  afterCaptureId,
  afterAssetId,
}: {
  environmentId: string;
  afterCaptureId: string;
  afterAssetId: string | null;
}) {
  const scope = useScopesWithCommandFallback().scope;
  const [state, setState] = useState<DiffState>({ kind: "idle" });

  const run = () => {
    setState({ kind: "loading" });
    void webAnnotationCommand(
      WEB_ANNOTATION_COMMANDS.resultDiff,
      { environmentId, captureId: afterCaptureId },
      undefined,
      scope,
    )
      .then((value) => setState({ kind: "ready", diff: value.diff }))
      .catch((error: unknown) =>
        setState({ kind: "error", message: describeWebAnnotationError(error) }),
      );
  };

  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 gap-1 px-2 text-[11px]"
        disabled={state.kind === "loading"}
        onClick={run}
        data-diff-action
      >
        {state.kind === "loading" ? (
          <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
        ) : (
          <ScanSearch className="h-3 w-3" aria-hidden />
        )}
        Show what changed (advisory)
      </Button>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-1" data-diff-state="error">
        <p className="text-[10px] text-amber-200">
          The advisory diff could not be computed: {state.message}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          onClick={run}
        >
          Try again
        </Button>
      </div>
    );
  }

  const diff = state.diff;
  if (diff.status === "incomparable") {
    return (
      <section
        aria-label="Advisory diff"
        className="space-y-0.5 rounded border border-border/60 p-1.5 text-[10px]"
        data-diff-state="incomparable"
      >
        <p className="font-medium uppercase tracking-wide text-muted-foreground">
          Advisory diff — not available
        </p>
        <p className="text-muted-foreground">These captures cannot be compared pixel by pixel:</p>
        <ul className="list-inside list-disc text-amber-200">
          {diff.reasons.map((reason) => (
            <li key={reason.code} data-diff-reason={reason.code}>
              {reason.message}
            </li>
          ))}
        </ul>
        {diff.reasons.some(({ code }) => code === "busy" || code === "timeout") && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={run}
          >
            Try again
          </Button>
        )}
      </section>
    );
  }

  const excluded = excludedSummary(diff);
  return (
    <section
      aria-label="Advisory diff"
      className="space-y-1 rounded border border-border/60 p-1.5 text-[10px]"
      data-diff-state="compared"
    >
      <p className="font-medium uppercase tracking-wide text-muted-foreground">
        Advisory diff — evidence, not a pass or fail
      </p>
      <p data-diff-summary>{resultDiffSummary(diff)}</p>
      {afterAssetId && (
        <DiffOverlay environmentId={environmentId} assetId={afterAssetId} diff={diff} />
      )}
      {excluded && <p className="text-muted-foreground">{excluded}</p>}
      <p className="text-muted-foreground">
        Outlined areas differ from the original capture. Check them yourself; only you resolve the
        note.
      </p>
    </section>
  );
}
