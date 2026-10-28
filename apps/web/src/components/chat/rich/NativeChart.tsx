import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  BarChart3,
  Braces,
  ClipboardCopy,
  Download,
  FileJson,
  Filter,
  Image as ImageIcon,
  Maximize2,
  RotateCcw,
  Table2,
} from "lucide-react";
import type { ChartSpecV1 } from "@orkestrator/protocol/chart-spec";
import { buildChartScene } from "@orkestrator/protocol/chart-scene";
import { writeText } from "@/lib/native/clipboard";
import { useAppAppearance } from "@/lib/chat/artifact-theme";
import {
  chartCsvExport,
  chartInspectItems,
  chartJsonExport,
  chartSvgExport,
  chartVisibleCsvExport,
} from "@/lib/chat/artifact-chart-export";
import { artifactFilename, downloadText } from "@/lib/chat/artifact-download";
import { useRichViewField, type RichViewChoice } from "@/stores/richContentViewStore";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { RichBlockFrame, RichToolbarButton } from "./RichBlockFrame";
import { ChartSwatch, NativeChartSvg } from "./NativeChartSvg";
import { NativeChartDataTable, NativeChartSource } from "./NativeChartData";
import { RichPinRecoveryNotice, useRichViewPin } from "./CodeBlockViewer";

/**
 * A validated ChartSpecV1 rendered natively: a figure with title, description
 * and summary; a legend whose toggles change only the view; hover/keyboard
 * value inspection with a focused marker; a semantic data view; the exact
 * source; and exports that always contain the whole dataset (the filtered CSV
 * is a separate, explicitly named action). View choices live in the scoped
 * rich view store, so they survive virtualization and remounts.
 */

export type NativeChartProvenance =
  { kind: "inline" } | { kind: "published"; revision: number; detail?: string };

export interface NativeChartProps {
  spec: ChartSpecV1;
  /** Scoped view identity (block or artifact occurrence key). */
  viewKey: string;
  /** Exact validated source text; Download JSON and Source use it verbatim. */
  source?: string;
  provenance: NativeChartProvenance;
  /** Extra toolbar actions owned by the caller (artifact card actions). */
  extraActions?: ReactNode;
}

const NO_HIDDEN: readonly string[] = [];

function provenanceLabel(provenance: NativeChartProvenance): string {
  return provenance.kind === "inline"
    ? "Inline chart from message text"
    : `Published chart · revision ${provenance.revision}${provenance.detail ? ` · ${provenance.detail}` : ""}`;
}

async function copyText(text: string, label: string, recovery: string): Promise<void> {
  try {
    await writeText(text);
    toast.success(`Copied ${label}`);
  } catch {
    toast.error("Clipboard is unavailable", { description: recovery });
  }
}

function runDownload(action: () => void): void {
  try {
    action();
  } catch (error) {
    toast.error("Download failed", {
      description: error instanceof Error ? error.message : undefined,
    });
  }
}

export function NativeChart({ spec, viewKey, source, provenance, extraActions }: NativeChartProps) {
  const appearance = useAppAppearance();
  const [hiddenList, setHiddenList] = useRichViewField(viewKey, "hiddenSeries", NO_HIDDEN);
  const [view, setView] = useRichViewField(viewKey, "view", "preview" as RichViewChoice);
  const [expanded, setExpanded] = useRichViewField(viewKey, "expanded", false);
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const sourceText = useMemo(() => chartJsonExport(spec, source), [source, spec]);
  const label = provenanceLabel(provenance);

  const pin = useRichViewPin(viewKey, expanded, () => setExpanded(false));

  const resetView = useCallback(() => {
    setHiddenList([]);
    setView("preview");
  }, [setHiddenList, setView]);

  const toggleSeries = useCallback(
    (id: string) => {
      const next = new Set(hiddenList);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setHiddenList(Array.from(next));
    },
    [hiddenList, setHiddenList],
  );

  const filenameBase = spec.title;
  const actions = (
    <>
      {extraActions}
      <RichToolbarButton
        label="Reset view"
        onClick={resetView}
        disabled={hiddenList.length === 0 && view === "preview"}
      >
        <RotateCcw aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Chart view"
        pressed={view === "preview"}
        onClick={() => setView("preview")}
      >
        <BarChart3 aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Data view"
        pressed={view === "data"}
        onClick={() => setView(view === "data" ? "preview" : "data")}
      >
        <Table2 aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Source JSON"
        pressed={view === "source"}
        onClick={() => setView(view === "source" ? "preview" : "source")}
      >
        <Braces aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton label="Expand chart" pressed={expanded} onClick={() => setExpanded(true)}>
        <Maximize2 aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Copy CSV"
        onClick={() => void copyText(chartCsvExport(spec), "CSV", "Use Download CSV instead.")}
      >
        <ClipboardCopy aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Download CSV"
        onClick={() =>
          runDownload(() =>
            downloadText(
              `${String.fromCharCode(0xfeff)}${chartCsvExport(spec)}`,
              artifactFilename(filenameBase, "csv"),
              "text/csv;charset=utf-8",
            ),
          )
        }
      >
        <Download aria-hidden="true" />
      </RichToolbarButton>
      {hiddenList.length > 0 ? (
        <RichToolbarButton
          label="Download CSV of visible series only (filtered)"
          onClick={() =>
            runDownload(() =>
              downloadText(
                `${String.fromCharCode(0xfeff)}${chartVisibleCsvExport(spec, hidden)}`,
                artifactFilename(`${filenameBase} (filtered)`, "csv"),
                "text/csv;charset=utf-8",
              ),
            )
          }
        >
          <Filter aria-hidden="true" />
        </RichToolbarButton>
      ) : null}
      <RichToolbarButton
        label="Download JSON specification"
        onClick={() =>
          runDownload(() =>
            downloadText(sourceText, artifactFilename(filenameBase, "json"), "application/json"),
          )
        }
      >
        <FileJson aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Download SVG"
        onClick={() =>
          runDownload(() =>
            downloadText(
              chartSvgExport(spec, appearance),
              artifactFilename(filenameBase, "svg"),
              "image/svg+xml",
            ),
          )
        }
      >
        <ImageIcon aria-hidden="true" />
      </RichToolbarButton>
    </>
  );

  return (
    <>
      <RichBlockFrame
        kind="chart"
        blockKey={viewKey}
        title={spec.title}
        status={<span data-chart-provenance={provenance.kind}>{label}</span>}
        actions={actions}
        fallback={<NativeChartSource source={sourceText} />}
      >
        {pin.displaced ? (
          <RichPinRecoveryNotice
            what="expanded chart"
            onReopen={pin.reopen}
            onDismiss={pin.dismiss}
          />
        ) : null}
        <NativeChartBody
          spec={spec}
          hidden={hidden}
          view={view}
          sourceText={sourceText}
          appearance={appearance}
          onToggleSeries={toggleSeries}
          onReset={resetView}
        />
      </RichBlockFrame>
      {expanded ? (
        <Dialog open onOpenChange={(open) => setExpanded(open)}>
          <DialogContent size="5xl">
            <DialogTitle>{spec.title}</DialogTitle>
            <DialogDescription>{label}</DialogDescription>
            <NativeChartBody
              spec={spec}
              hidden={hidden}
              view={view}
              sourceText={sourceText}
              appearance={appearance}
              onToggleSeries={toggleSeries}
              onReset={resetView}
              width={960}
              height={540}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export function NativeChartBody({
  spec,
  hidden,
  view,
  sourceText,
  appearance,
  onToggleSeries,
  onReset,
  width,
  height,
}: {
  spec: ChartSpecV1;
  hidden: ReadonlySet<string>;
  view: RichViewChoice;
  sourceText: string;
  appearance: "light" | "dark";
  onToggleSeries: (id: string) => void;
  onReset: () => void;
  width?: number;
  height?: number;
}) {
  const rawId = useId();
  const uid = `chart-${rawId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const titleId = `${uid}-title`;
  const descriptionId = `${uid}-desc`;
  const scene = useMemo(
    () => buildChartScene(spec, { width, height, hiddenSeriesIds: hidden }),
    [height, hidden, spec, width],
  );
  const items = useMemo(() => chartInspectItems(spec, scene), [scene, spec]);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focused =
    focusedKey === null ? null : (items.find((item) => item.key === focusedKey) ?? null);
  const allHidden = scene.legend.length > 0 && scene.legend.every((entry) => entry.hidden);
  const seriesNoun = spec.kind === "donut" ? "slices" : "series";

  return (
    <div className="min-w-0 px-3 pb-3 pt-2">
      <p id={titleId} className="sr-only">
        {spec.title}
      </p>
      {spec.description ? (
        <p className="mb-1 text-xs text-foreground/90">{spec.description}</p>
      ) : null}
      <div
        role="group"
        aria-label={`Legend: toggle ${seriesNoun} in this view`}
        data-rich-chrome="true"
        className="mb-2 flex select-none flex-wrap gap-1"
      >
        {scene.legend.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={!entry.hidden}
            onClick={() => onToggleSeries(entry.id)}
            data-legend-series={entry.id}
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              entry.hidden ? "text-muted-foreground line-through opacity-60" : "text-foreground",
            )}
            title={entry.hidden ? `Show ${entry.label}` : `Hide ${entry.label}`}
          >
            <ChartSwatch slot={entry.slot} kind={scene.kind} theme={appearance} uid={uid} />
            <span className="truncate">{entry.label}</span>
          </button>
        ))}
      </div>
      {view === "source" ? (
        <NativeChartSource source={sourceText} />
      ) : view === "data" ? (
        <NativeChartDataTable
          spec={spec}
          caption={`Data for ${spec.title}. Full dataset in source order.`}
        />
      ) : allHidden ? (
        <div
          className="flex flex-col items-center gap-2 py-8 text-xs text-muted-foreground"
          data-chart-empty-selection="true"
        >
          <span>All {seriesNoun} are hidden in this view. The stored data is unchanged.</span>
          <button
            type="button"
            onClick={onReset}
            className="rounded border border-border px-2 py-1 text-foreground outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Reset view
          </button>
        </div>
      ) : (
        <div className="relative">
          <NativeChartSvg
            scene={scene}
            theme={appearance}
            uid={uid}
            items={items}
            focusedKey={focusedKey}
            onFocusItem={setFocusedKey}
            titleId={titleId}
            descriptionId={descriptionId}
          />
          {focused ? (
            <div
              role="tooltip"
              data-chart-tooltip="true"
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] whitespace-nowrap rounded border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow"
              style={{
                left: `${(focused.px / scene.width) * 100}%`,
                top: `${(focused.py / scene.height) * 100}%`,
              }}
            >
              <div className="font-medium">{focused.seriesLabel}</div>
              <div>
                {focused.label}: {focused.valueText}
              </div>
            </div>
          ) : null}
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {focused ? `${focused.seriesLabel}, ${focused.label}: ${focused.valueText}` : ""}
      </p>
      <p id={descriptionId} className="mt-1 text-[11px] text-muted-foreground">
        {scene.summary}
        {view === "preview" && items.length > 0
          ? " Focus the chart and use arrow keys for exact values, or open the data view."
          : ""}
      </p>
      {spec.sourceNotes && spec.sourceNotes.length > 0 ? (
        <ul
          className="mt-1 list-disc pl-4 text-[11px] text-muted-foreground"
          aria-label="Source notes"
        >
          {spec.sourceNotes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
