import { memo, useMemo } from "react";
import type { ChartSpecV1 } from "@orkestrator/protocol/chart-spec";
import { chartDataTable } from "@orkestrator/protocol/chart-scene";

/**
 * The equivalent semantic data view of a chart: a real table in exact source
 * order with headers, exact values and an explicit missing-value convention.
 * It always shows the whole dataset, independent of legend toggles, so the
 * stored data stays inspectable.
 */
export const NativeChartDataTable = memo(function NativeChartDataTable({
  spec,
  caption,
}: {
  spec: ChartSpecV1;
  caption: string;
}) {
  const table = useMemo(() => chartDataTable(spec), [spec]);
  return (
    <div className="max-h-[60vh] overflow-auto" data-chart-data-view="true">
      <table className="w-full border-collapse text-left text-xs tabular-nums">
        <caption className="px-2 py-1 text-left text-[11px] text-muted-foreground">
          {caption}
          {table.note ? ` ${table.note}` : ""}
        </caption>
        <thead className="sticky top-0 bg-muted">
          <tr>
            {table.header.map((column) => (
              <th key={column} scope="col" className="border-b border-border px-2 py-1 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-background/40">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border-b border-border/50 px-2 py-0.5"
                  data-missing={cell === null ? "true" : undefined}
                >
                  {cell === null ? (
                    <span className="text-muted-foreground">(missing)</span>
                  ) : (
                    String(cell)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

export function NativeChartSource({ source }: { source: string }) {
  return (
    <pre
      data-chart-source-view="true"
      className="max-h-[60vh] overflow-auto whitespace-pre p-3 font-mono text-xs text-foreground"
    >
      <code>{source}</code>
    </pre>
  );
}
