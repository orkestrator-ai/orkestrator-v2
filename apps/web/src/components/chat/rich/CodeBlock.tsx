import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileCode2,
  FileSymlink,
  Maximize2,
  RotateCcw,
  SquareTerminal,
  WrapText,
} from "lucide-react";
import { toMarkdownFence } from "@orkestrator/protocol/tabular-export";
import { CODE_BLOCK_POLICY, utf8ByteLength } from "@orkestrator/protocol/rich-content-policy";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { useAppAppearance } from "@/lib/chat/artifact-theme";
import { languageLabel, resolveHighlightLanguage } from "@/lib/chat/highlighter/languages";
import { FONT_STYLE, type HighlightLine } from "@/lib/chat/highlighter/protocol";
import { useHighlightedLines } from "@/lib/chat/highlighter/use-highlighted-lines";
import { useRichBlockVisibility } from "@/lib/chat/rich-render-priority";
import { copyRichText } from "@/lib/chat/rich-markdown/clipboard";
import { workspaceRelativeFileHint } from "@/lib/chat/rich-markdown/fence-info";
import { codeDisplayText } from "@/lib/chat/rich-markdown/markdown-search";
import {
  SHELL_INELIGIBLE_REASON,
  shellCommandEligibility,
} from "@/lib/chat/rich-markdown/shell-command";
import { useRichViewField } from "@/stores/richContentViewStore";
import { cn } from "@/lib/utils";
import { RichBlockFrame, RichToolbarButton } from "./RichBlockFrame";
import { RichPinRecoveryNotice, SourceViewerDialog, useRichViewPin } from "./CodeBlockViewer";
import { RichSearchMirror } from "./RichMarkdownBlocks.shared";

export interface CodeBlockProps {
  /** Exact fence body as authored (container prefixes removed by the parser). */
  source: string;
  /** Normalized fence language, or null for a plain block. */
  language: string | null;
  /** Safe display title from fence metadata. */
  title?: string | null;
  /** Safe file hint from fence metadata: display only, never written. */
  fileHint?: string | null;
  /** The fence's own closing delimiter is present. */
  closed: boolean;
  /** Stable block view identity (`useRichBlockViewKey`). */
  blockKey: string;
  /** The enclosing text is still streaming. */
  live?: boolean;
  /** The enclosing document was clipped by the parser cap. */
  clipped?: boolean;
}

/** Visual line height of transcript code, in rem (Tailwind `leading-5`). */
const LINE_HEIGHT_REM = 1.25;
const VERTICAL_PADDING_REM = 1.5;

/**
 * Logical lines kept in the DOM inline, collapsed or expanded. Lines past it
 * are never rendered as rows: their text sits in one hidden find mirror (so
 * find ordinals still match the source) and the block offers the read-only
 * viewer for them with an explicit omitted-line count.
 */
export const INLINE_CODE_LINE_LIMIT = 400;

export function logicalLineCount(source: string): number {
  if (!source) return 0;
  let lines = 1;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 10 || (code === 13 && source.charCodeAt(index + 1) !== 10)) lines++;
  }
  return /\r?\n$|\r$/.test(source) ? lines - 1 : lines;
}

/** Whether a fence body is within the inline highlighting limits. */
export function withinHighlightLimits(source: string): boolean {
  return (
    logicalLineCount(source) <= CODE_BLOCK_POLICY.maxHighlightLines &&
    utf8ByteLength(source) <= CODE_BLOCK_POLICY.maxHighlightBytes
  );
}

function tokenStyle(
  color: string | undefined,
  fontStyle: number | undefined,
): CSSProperties | undefined {
  if (!color && !fontStyle) return undefined;
  const style: CSSProperties = {};
  if (color) style.color = color;
  if (fontStyle) {
    if (fontStyle & FONT_STYLE.italic) style.fontStyle = "italic";
    if (fontStyle & FONT_STYLE.bold) style.fontWeight = 600;
    const decorations = [
      fontStyle & FONT_STYLE.underline ? "underline" : "",
      fontStyle & FONT_STYLE.strikethrough ? "line-through" : "",
    ].filter(Boolean);
    if (decorations.length > 0) style.textDecoration = decorations.join(" ");
  }
  return style;
}

/**
 * One line of code. Highlighted tokens are used only when they reproduce the
 * line's exact text; otherwise the plain line is shown, so a tokenizer can
 * never change what is displayed or copied.
 */
const CODE_LINE_STYLE: CSSProperties = {
  display: "inline-block",
  verticalAlign: "top",
  maxWidth: "100%",
  contain: "layout style",
};

const CodeLine = memo(function CodeLine({
  text,
  tokens,
}: {
  text: string;
  tokens?: HighlightLine;
}) {
  if (tokens && tokens.map((token) => token.c).join("") === text) {
    return (
      <span data-code-line="true" style={CODE_LINE_STYLE}>
        {tokens.map((token, index) => (
          <span key={index} style={tokenStyle(token.s, token.f)}>
            {token.c}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span data-code-line="true" style={CODE_LINE_STYLE}>
      {text}
    </span>
  );
});

/** The code body: one span per line with `\n` text between, so DOM text equals the source. */
export function CodeLines({
  lines,
  tokens,
}: {
  lines: readonly string[];
  tokens: readonly HighlightLine[] | null;
}) {
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          <CodeLine text={line} tokens={tokens?.[index]} />
          {index < lines.length - 1 ? "\n" : null}
        </Fragment>
      ))}
    </>
  );
}

/**
 * A fenced code block: highlighted lazily off the main thread, shown as exact
 * plain source until then (and whenever highlighting is unavailable), with
 * copy, wrap, bounded expansion and a read-only viewer.
 */
export const CodeBlock = memo(function CodeBlock({
  source,
  language,
  title = null,
  fileHint = null,
  closed,
  blockKey,
  live = false,
  clipped = false,
}: CodeBlockProps) {
  const theme = useAppAppearance();
  const terminal = useOptionalTerminalContext();
  const [wrap, setWrap] = useRichViewField(blockKey, "wrap", false);
  const [expanded, setExpanded] = useRichViewField(blockKey, "expanded", false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const pin = useRichViewPin(blockKey, expanded, () => setExpanded(false));

  const displayText = useMemo(() => codeDisplayText(source), [source]);
  const lineCount = useMemo(() => logicalLineCount(source), [source]);
  const highlightable = useMemo(() => withinHighlightLimits(source), [source]);
  const inline = useMemo(() => {
    const all = displayText.split("\n");
    if (all.length <= INLINE_CODE_LINE_LIMIT) return { lines: all, rest: "" };
    return {
      lines: all.slice(0, INLINE_CODE_LINE_LIMIT),
      rest: `\n${all.slice(INLINE_CODE_LINE_LIMIT).join("\n")}`,
    };
  }, [displayText]);
  // Oversized fences use one text node. Other fences retain stable line
  // nodes for selection; each line contains its layout so appends don't
  // re-layout the tokens in earlier lines.
  const inlineText = useMemo(
    () => (highlightable ? null : inline.lines.join("\n")),
    [highlightable, inline],
  );
  const omittedLines = Math.max(0, lineCount - INLINE_CODE_LINE_LIMIT);
  const highlightLanguage = resolveHighlightLanguage(language);
  // Observed per block: an offscreen block of a long row requests prefetch.
  const { observe: observeBlock, visibility: blockVisibility } = useRichBlockVisibility();
  const highlighted = useHighlightedLines({
    displayText,
    closed,
    language: highlightLanguage,
    theme,
    enabled: highlightable && closed,
    visibility: blockVisibility,
  });

  const preRef = useRef<HTMLPreElement>(null);
  const attachPre = useCallback(
    (element: HTMLPreElement | null) => {
      preRef.current = element;
      const unobserve = observeBlock(element);
      return () => {
        preRef.current = null;
        if (typeof unobserve === "function") unobserve();
      };
    },
    [observeBlock],
  );
  // More logical lines than the initial region always overflow, so no layout
  // read or observer is needed: a streaming block changes on every token and
  // must not force a synchronous layout or rebuild an observer each time.
  const overflowsByLines = lineCount > CODE_BLOCK_POLICY.initialVisualLines;
  const [overflowsVisually, setOverflowsVisually] = useState(false);
  const overflowing = overflowsByLines || overflowsVisually;
  useLayoutEffect(() => {
    const element = preRef.current;
    if (!element || expanded || overflowsByLines) return;
    // Wrapping can only add visual lines, which the measurement catches.
    const measure = () => setOverflowsVisually(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, wrap, displayText, overflowsByLines]);

  const eligibility = shellCommandEligibility({ source, language, closed, live, clipped });
  const createTab = terminal?.createTab ?? null;
  const runInTerminal = useCallback(() => {
    if (!eligibility.ok || !createTab) return;
    createTab("plain", {
      initialCommands: [eligibility.command],
      displayTitle: "Transcript command",
    });
  }, [createTab, eligibility]);

  const workspaceFile = workspaceRelativeFileHint(fileHint);
  const createFileTab = terminal?.createFileTab ?? null;

  const label = title ?? languageLabel(language);
  const status = !closed ? (clipped ? "Clipped" : live ? "Generating…" : "Incomplete") : null;
  const collapsedStyle: CSSProperties | undefined = expanded
    ? undefined
    : {
        maxHeight: `${CODE_BLOCK_POLICY.initialVisualLines * LINE_HEIGHT_REM + VERTICAL_PADDING_REM}rem`,
      };

  const plain = (
    <pre className="m-0 overflow-x-auto whitespace-pre p-3 font-mono text-xs leading-5">
      <code>{source}</code>
    </pre>
  );

  const actions: ReactNode = (
    <>
      {highlighted.status === "error" && highlighted.error === "unavailable" ? (
        <RichToolbarButton label="Retry syntax highlighting" onClick={highlighted.retry}>
          <RotateCcw aria-hidden="true" />
        </RichToolbarButton>
      ) : null}
      {eligibility.ok || eligibility.reason !== "not-shell" ? (
        <RichToolbarButton
          label="Run in new terminal"
          title={
            eligibility.ok
              ? createTab
                ? `Run in a new terminal: ${eligibility.command}`
                : "Start the environment to run commands"
              : SHELL_INELIGIBLE_REASON[eligibility.reason]
          }
          disabled={!eligibility.ok || !createTab}
          onClick={runInTerminal}
        >
          <SquareTerminal aria-hidden="true" />
        </RichToolbarButton>
      ) : null}
      {workspaceFile && createFileTab ? (
        <RichToolbarButton
          label={`Open workspace file ${workspaceFile}`}
          title={`Open the current workspace file ${workspaceFile} (not this snippet)`}
          onClick={() => createFileTab(workspaceFile)}
        >
          <FileSymlink aria-hidden="true" />
        </RichToolbarButton>
      ) : null}
      <RichToolbarButton label="Wrap lines" pressed={wrap} onClick={() => setWrap(!wrap)}>
        <WrapText aria-hidden="true" />
      </RichToolbarButton>
      {overflowing || expanded ? (
        <RichToolbarButton
          label={expanded ? "Collapse code" : "Expand code"}
          pressed={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
        </RichToolbarButton>
      ) : null}
      <RichToolbarButton label="Open in viewer" onClick={() => setViewerOpen(true)}>
        <Maximize2 aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Copy as Markdown"
        onClick={() =>
          void copyRichText(
            toMarkdownFence(source, language ?? undefined, title ?? undefined),
            "Markdown",
          )
        }
      >
        <FileCode2 aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton label="Copy code" onClick={() => void copyRichText(source, "code")}>
        <Copy aria-hidden="true" />
      </RichToolbarButton>
    </>
  );

  return (
    <RichBlockFrame
      kind="code"
      blockKey={blockKey}
      title={label}
      ariaLabel={`${label} code block`}
      subtitle={fileHint ?? undefined}
      status={
        status ??
        (!highlightable ? (
          <span title="Over the inline highlighting limit; open the viewer for the full source">
            Plain text · {lineCount} lines
          </span>
        ) : null)
      }
      actions={actions}
      fallback={plain}
    >
      {pin.displaced ? (
        <RichPinRecoveryNotice what="expanded code" onReopen={pin.reopen} onDismiss={pin.dismiss} />
      ) : null}
      <pre
        ref={attachPre}
        data-rich-code-body="true"
        data-highlight-status={highlighted.status}
        className={cn(
          "m-0 p-3 font-mono text-xs leading-5 text-foreground",
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          expanded ? "max-h-[70vh] overflow-auto" : "overflow-x-auto overflow-y-hidden",
        )}
        style={collapsedStyle}
      >
        <code>{inlineText ?? <CodeLines lines={inline.lines} tokens={highlighted.lines} />}</code>
      </pre>
      {inline.rest ? <RichSearchMirror text={inline.rest} /> : null}
      {expanded && omittedLines > 0 ? (
        <div
          role="note"
          data-rich-chrome="true"
          data-code-omitted-lines={omittedLines}
          className="flex select-none items-center gap-2 border-t border-border/60 bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground"
        >
          <span className="min-w-0 flex-1">
            Showing the first {INLINE_CODE_LINE_LIMIT} of {lineCount} lines inline; {omittedLines}{" "}
            more {omittedLines === 1 ? "line is" : "lines are"} in the viewer. Copy code copies all
            of it.
          </span>
          <button
            type="button"
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-foreground outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60"
            onClick={() => setViewerOpen(true)}
          >
            Open all {lineCount} lines in viewer
          </button>
        </div>
      ) : null}
      {overflowing && !expanded ? (
        <button
          type="button"
          data-rich-chrome="true"
          className="block w-full select-none border-t border-border/60 bg-muted/60 py-1 text-center text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          {omittedLines > 0
            ? `Show ${INLINE_CODE_LINE_LIMIT} of ${lineCount} lines`
            : `Show all ${lineCount} lines`}
        </button>
      ) : null}
      {viewerOpen ? (
        <SourceViewerDialog
          open={viewerOpen}
          onOpenChange={setViewerOpen}
          title={label}
          description={
            fileHint
              ? `Read-only snippet labelled ${fileHint}. It is not the workspace file and nothing here writes one.`
              : undefined
          }
          source={source}
          copyLabel="code"
        />
      ) : null}
    </RichBlockFrame>
  );
});
