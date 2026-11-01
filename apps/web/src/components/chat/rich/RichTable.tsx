import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Copy, Download, FileSpreadsheet, Maximize2, Sheet, WrapText } from "lucide-react";
import { toCsv, toMarkdownTable } from "@orkestrator/protocol/tabular-export";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { downloadText } from "@/lib/chat/artifact-download";
import { copyRichText } from "@/lib/chat/rich-markdown/clipboard";
import { useDialogFocusReturn } from "@/lib/dialog-focus";
import type { HastNode } from "@/lib/chat/rich-markdown/markdown-search";
import {
  nodeSourceSlice,
  reachesOmissionBoundary,
  tableModelFromHast,
  type TableModel,
} from "@/lib/chat/rich-markdown/table-model";
import { useRichViewField } from "@/stores/richContentViewStore";
import { cn } from "@/lib/utils";
import { RichBlockFrame, RichToolbarButton } from "./RichBlockFrame";

export interface RichTableProps {
  /** The rendered thead/tbody, produced by react-markdown from the parsed table. */
  children: ReactNode;
  /** Semantic header/rows/alignment from the same parse. */
  model: TableModel;
  /** Exact Markdown source of the table, when the parser offsets are known. */
  markdownSource: string | null;
  /** The table reaches the parser-cap omission boundary; rows may be missing. */
  partial: boolean;
  omittedCharacters?: number;
  blockKey: string;
}

const UTF8_BOM = String.fromCharCode(0xfeff);

/** CSV for download: UTF-8 with a byte-order mark so spreadsheets detect the encoding. */
export function csvDownloadText(model: TableModel, mode: "exact" | "spreadsheet-safe"): string {
  return `${UTF8_BOM}${toCsv(model.header, model.rows, mode)}`;
}

/**
 * A Markdown table in a local horizontal scroll container (a wide table never
 * widens the transcript), with wrap, expand, Markdown/CSV copy and CSV
 * downloads. Rows keep their source order; nothing is sorted or retyped.
 */
export function RichTable({
  children,
  model,
  markdownSource,
  partial,
  omittedCharacters = 0,
  blockKey,
}: RichTableProps) {
  const [wrap, setWrap] = useRichViewField(blockKey, "wrap", true);
  const [expanded, setExpanded] = useState(false);
  // The expanded dialog returns focus to "Expand table" when it closes.
  const focusReturn = useDialogFocusReturn();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollLeft = useRef(0);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Toggling wrap keeps the reader's horizontal position.
    element.scrollLeft = scrollLeft.current;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [wrap]);

  const columns = model.header.length;
  const markdown = useMemo(
    () => markdownSource?.trim() || toMarkdownTable(model.header, model.rows, model.align),
    [markdownSource, model],
  );
  const scope = partial ? "partial table" : "table";
  const filename = partial ? "table-partial" : "table";

  const actions = (
    <>
      {overflowing || !wrap ? (
        <RichToolbarButton
          label="Wrap cells"
          pressed={wrap}
          onClick={() => {
            scrollLeft.current = scrollRef.current?.scrollLeft ?? 0;
            setWrap(!wrap);
          }}
        >
          <WrapText aria-hidden="true" />
        </RichToolbarButton>
      ) : null}
      <RichToolbarButton label="Expand table" onClick={() => setExpanded(true)}>
        <Maximize2 aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Copy as Markdown"
        onClick={() => void copyRichText(markdown, `${scope} as Markdown`)}
      >
        <Copy aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Copy as CSV"
        onClick={() =>
          void copyRichText(toCsv(model.header, model.rows, "exact"), `${scope} as CSV`)
        }
      >
        <Sheet aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Download CSV (exact text)"
        onClick={() =>
          downloadText(csvDownloadText(model, "exact"), `${filename}.csv`, "text/csv;charset=utf-8")
        }
      >
        <Download aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Download CSV for spreadsheets (formulas neutralized)"
        title="Download CSV for spreadsheets: cells starting with =, +, -, @ get a leading apostrophe so they are not evaluated as formulas"
        onClick={() =>
          downloadText(
            csvDownloadText(model, "spreadsheet-safe"),
            `${filename}-spreadsheet-safe.csv`,
            "text/csv;charset=utf-8",
          )
        }
      >
        <FileSpreadsheet aria-hidden="true" />
      </RichToolbarButton>
    </>
  );

  const tableClassName = cn(
    "my-0 w-max min-w-full border-collapse text-xs [&_td]:border-t [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
    wrap
      ? "[&_td]:max-w-[28rem] [&_td]:whitespace-normal [&_td]:break-words [&_th]:max-w-[28rem]"
      : "[&_td]:whitespace-nowrap [&_th]:whitespace-nowrap",
  );

  return (
    <RichBlockFrame
      kind="table"
      blockKey={blockKey}
      title="Table"
      ariaLabel={`Table with ${columns} columns and ${model.rows.length} rows`}
      subtitle={`${model.rows.length} ${model.rows.length === 1 ? "row" : "rows"} × ${columns} ${columns === 1 ? "column" : "columns"}`}
      status={
        partial ? (
          <span className="text-amber-600 dark:text-amber-400">
            Partial · {omittedCharacters.toLocaleString()} characters omitted
          </span>
        ) : null
      }
      actions={actions}
    >
      <div
        ref={scrollRef}
        role="region"
        aria-label="Table contents, scroll horizontally"
        tabIndex={0}
        className="max-w-full overflow-x-auto overscroll-x-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <table className={tableClassName}>{children}</table>
      </div>
      {expanded ? (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent
            {...focusReturn}
            size="full"
            className="flex max-h-[85vh] w-[min(90rem,calc(100vw-2rem))] flex-col gap-2"
          >
            <DialogHeader>
              <DialogTitle>Table</DialogTitle>
              <DialogDescription>
                {partial
                  ? "Partial table: the message was clipped, so later rows may be missing."
                  : `${model.rows.length} rows × ${columns} columns, in source order.`}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:bg-background">
              <table className={tableClassName}>{children}</table>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </RichBlockFrame>
  );
}

/** Build table props from the hast node react-markdown passes to `table`. */
export function richTablePropsFromHast(
  node: HastNode,
  renderedSource: string,
  clipped: boolean,
): Pick<RichTableProps, "model" | "markdownSource" | "partial"> {
  return {
    model: tableModelFromHast(node),
    markdownSource: nodeSourceSlice(node, renderedSource),
    partial: reachesOmissionBoundary(node, renderedSource, clipped),
  };
}
