import { memo, useMemo } from "react";
import { parseChartSpec } from "@orkestrator/protocol/chart-spec";
import type { FieldError } from "@orkestrator/protocol/field-validation";
import { RichBlockFrame } from "./RichBlockFrame";
import { NativeChart } from "./NativeChart";
import { NativeChartSource } from "./NativeChartData";

/**
 * A ```chart fence in message text. While the fence is still streaming (or
 * was clipped by the parser cap) only the source is shown: half-written JSON
 * is never parsed. A closed fence is parsed and validated with the shared
 * ChartSpecV1 validator; failures show field paths plus the raw source.
 *
 * An inline fence chart carries no publication authority: it is labelled as
 * an inline chart from message text and offers no artifact actions.
 */
export interface ChartFenceBlockProps {
  /** Exact fence body (the chart JSON). */
  source: string;
  /** False while the fence is still streaming or was clipped by the parser cap. */
  closed: boolean;
  /** Stable block view identity from `useRichBlockViewKey`. */
  blockKey: string;
}

const MAX_SHOWN_ERRORS = 8;

function describeErrors(errors: readonly FieldError[], omitted: number): string {
  const shown = errors.slice(0, MAX_SHOWN_ERRORS).map((error) => `${error.path}: ${error.message}`);
  const more = errors.length - shown.length + omitted;
  return more > 0 ? `${shown.join("; ")}; and ${more} more` : shown.join("; ");
}

export const ChartFenceBlock = memo(function ChartFenceBlock({
  source,
  closed,
  blockKey,
}: ChartFenceBlockProps) {
  const result = useMemo(() => (closed ? parseChartSpec(source) : null), [closed, source]);

  if (!closed || result === null) {
    return (
      <RichBlockFrame
        kind="chart"
        blockKey={blockKey}
        title="Chart"
        status="Inline chart from message text"
        loading
        loadingLabel="Waiting for the complete chart specification…"
      >
        <NativeChartSource source={source} />
      </RichBlockFrame>
    );
  }

  if (!result.ok) {
    return (
      <RichBlockFrame
        kind="chart"
        blockKey={blockKey}
        title="Chart"
        status="Inline chart from message text"
        error={{
          title: "The chart specification is invalid",
          detail: describeErrors(result.errors, result.omittedErrors),
        }}
        fallback={<NativeChartSource source={source} />}
      >
        {null}
      </RichBlockFrame>
    );
  }

  return (
    <NativeChart
      spec={result.value}
      viewKey={blockKey}
      source={source}
      provenance={{ kind: "inline" }}
    />
  );
});
