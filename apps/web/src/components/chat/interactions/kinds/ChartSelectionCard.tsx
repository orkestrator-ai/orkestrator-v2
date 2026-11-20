import { useMemo, useState } from "react";
import {
  chartPointIds,
  chartSelectionMembers,
  chartSeriesIds,
  describeAnchorLocation,
  type ChartSelectionResult,
  type ChartSelectionSpec,
} from "@orkestrator/protocol/rich-interactions";
import { cn } from "@/lib/utils";
import { NativeChart } from "../../rich/NativeChart";
import { ActionBar, RefChip, inputClass, textareaClass, type KindProps } from "../shared";

interface ChartDraft {
  mode: "points" | "range" | "categories";
  pointIds: string[];
  seriesIds: string[];
  from?: number;
  to?: number;
  inclusive: boolean;
  categoryIds: string[];
  question?: string;
}

/**
 * Feature 10: charts with investigate-selection actions. The chart itself is
 * the existing validated viewer (hover, legend and exports stay local); the
 * selection is made in an equivalent semantic table or with numeric range
 * bounds, by stable point ids, so a drag gesture is never the only way and a
 * re-sorted view can never change which observation was meant.
 */
export function ChartSelectionCard({
  view,
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<ChartSelectionSpec>) {
  const chart = spec.chart;
  const continuous = chart.kind === "line" || chart.kind === "area" || chart.kind === "scatter";
  const allSeries = chartSeriesIds(chart);
  const value: ChartDraft = (draft as ChartDraft | undefined) ?? {
    mode: continuous ? "range" : "categories",
    pointIds: [],
    seriesIds: allSeries,
    inclusive: true,
    categoryIds: [],
  };
  const points = useMemo(() => [...chartPointIds(chart).entries()], [chart]);
  const [showTable, setShowTable] = useState(false);
  const update = (patch: Partial<ChartDraft>) => setDraft({ ...value, ...patch });
  const selection: ChartSelectionResult["selection"] | null =
    value.mode === "points"
      ? value.pointIds.length
        ? {
            kind: "chart-points",
            seriesIds: [
              ...new Set(value.pointIds.map((id) => chartPointIds(chart).get(id)!.seriesId)),
            ],
            pointIds: value.pointIds,
          }
        : null
      : value.mode === "range"
        ? value.from !== undefined &&
          value.to !== undefined &&
          value.to >= value.from &&
          value.seriesIds.length
          ? {
              kind: "chart-range",
              seriesIds: value.seriesIds,
              from: value.from,
              to: value.to,
              inclusive: value.inclusive,
              population: "all-underlying-observations",
            }
          : null
        : value.categoryIds.length
          ? {
              kind: "chart-categories",
              categoryIds: value.categoryIds,
              seriesIds: chart.kind === "donut" ? [] : value.seriesIds,
            }
          : null;
  const members = selection ? chartSelectionMembers(chart, selection) : [];
  const categories =
    chart.kind === "bar"
      ? chart.categories
      : chart.kind === "donut"
        ? chart.slices.map((s) => ({ id: s.id, label: s.label }))
        : [];
  const seriesLabel = (id: string) =>
    chart.kind === "donut" ? "Slices" : (chart.series.find((s) => s.id === id)?.label ?? id);
  const selectedSet = new Set(value.mode === "points" ? value.pointIds : members);

  return (
    <div className="flex flex-col gap-2">
      <NativeChart
        spec={chart}
        viewKey={`interaction:${view.request.interactionId}`}
        provenance={{ kind: "inline" }}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Source</span>
        <RefChip reference={spec.source} />
        {spec.notes ? <span className="text-muted-foreground">{spec.notes}</span> : null}
      </div>
      <fieldset
        className="flex flex-col gap-2 rounded border border-border/60 p-2"
        disabled={disabled}
      >
        <legend className="px-1 text-xs font-medium">Select observations</legend>
        <div className="flex gap-1 text-xs" role="radiogroup" aria-label="Selection type">
          {(continuous ? (["range", "points"] as const) : (["categories", "points"] as const)).map(
            (mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={value.mode === mode}
                className={cn(
                  "rounded px-2 py-0.5 focus-hairline",
                  value.mode === mode ? "bg-muted font-medium" : "text-muted-foreground",
                )}
                onClick={() => update({ mode })}
              >
                {mode === "range" ? "Range" : mode === "points" ? "Points" : "Categories"}
              </button>
            ),
          )}
        </div>
        {chart.kind !== "donut" && value.mode !== "points" ? (
          <div className="flex flex-wrap gap-3 text-xs" role="group" aria-label="Series">
            {allSeries.map((id) => (
              <label key={id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={value.seriesIds.includes(id)}
                  onChange={(e) =>
                    update({
                      seriesIds: e.target.checked
                        ? [...value.seriesIds, id]
                        : value.seriesIds.filter((s) => s !== id),
                    })
                  }
                />
                {seriesLabel(id)}
              </label>
            ))}
          </div>
        ) : null}
        {value.mode === "range" ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              From
              <input
                type="number"
                className={cn(inputClass, "w-28 py-0.5")}
                value={value.from ?? ""}
                onChange={(e) =>
                  update({ from: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            </label>
            <label className="flex items-center gap-1">
              to
              <input
                type="number"
                className={cn(inputClass, "w-28 py-0.5")}
                value={value.to ?? ""}
                onChange={(e) =>
                  update({ to: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            </label>
            {"xAxis" in chart && "unit" in chart.xAxis && chart.xAxis.unit ? (
              <span className="text-muted-foreground">{chart.xAxis.unit}</span>
            ) : null}
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={value.inclusive}
                onChange={(e) => update({ inclusive: e.target.checked })}
              />
              Include bounds
            </label>
            {value.from !== undefined && value.to !== undefined && value.to < value.from ? (
              <span className="text-failure">The range is inverted.</span>
            ) : null}
          </div>
        ) : null}
        {value.mode === "categories" ? (
          <div className="flex flex-wrap gap-3 text-xs" role="group" aria-label="Categories">
            {categories.map((c) => (
              <label key={c.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={value.categoryIds.includes(c.id)}
                  onChange={(e) =>
                    update({
                      categoryIds: e.target.checked
                        ? [...value.categoryIds, c.id]
                        : value.categoryIds.filter((x) => x !== c.id),
                    })
                  }
                />
                {c.label}
              </label>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="self-start text-xs text-primary focus-hairline"
          aria-expanded={showTable || value.mode === "points"}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable || value.mode === "points" ? "Hide data table" : "Show data table"}
        </button>
        {showTable || value.mode === "points" ? (
          <div className="max-h-60 overflow-auto rounded border border-border/40">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-zinc-900">
                <tr>
                  <th scope="col" className="w-8 px-2 py-1">
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col" className="px-2 py-1 text-left">
                    Observation
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {points.slice(0, 2_000).map(([id, point]) => (
                  <tr
                    key={id}
                    className={cn(
                      "border-t border-border/30",
                      selectedSet.has(id) && "bg-primary/10",
                    )}
                  >
                    <td className="px-2">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-primary"
                        aria-label={`Select ${point.label}`}
                        checked={
                          value.mode === "points"
                            ? value.pointIds.includes(id)
                            : selectedSet.has(id)
                        }
                        disabled={value.mode !== "points"}
                        onChange={(e) =>
                          update({
                            pointIds: e.target.checked
                              ? [...value.pointIds, id]
                              : value.pointIds.filter((p) => p !== id),
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-0.5">{point.label}</td>
                    <td className="px-2 py-0.5 text-right tabular-nums">
                      {point.y === null ? (
                        <span className="text-muted-foreground">missing</span>
                      ) : (
                        point.y
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground" role="status">
          {selection
            ? `${describeAnchorLocation(selection)} — ${members.length} observation(s)`
            : "Nothing selected yet."}
        </p>
      </fieldset>
      {!disabled ? (
        <>
          <textarea
            className={textareaClass}
            rows={2}
            aria-label="Question"
            placeholder="What should the agent investigate? (optional)"
            value={value.question ?? ""}
            onChange={(e) => update({ question: e.target.value })}
          />
          <ActionBar
            actions={actions}
            disabled={disabled}
            primaryDisabledReason={
              selection && members.length ? null : "Select at least one observation."
            }
            onAction={(a) =>
              selection &&
              act(a.id, {
                selection,
                ...(value.question?.trim() ? { question: value.question.trim() } : {}),
              })
            }
          />
        </>
      ) : null}
    </div>
  );
}
