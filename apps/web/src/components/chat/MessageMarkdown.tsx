import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { CheckSquare, Square } from "lucide-react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import { toast } from "sonner";
import { useOptionalTerminalContext } from "@/contexts";
import { openInBrowser } from "@/lib/backend";
import { parseLocalFileLinkTarget } from "@/lib/chat/file-url";
import { usePullRequestOpener } from "@/lib/pull-request-opener";
import { parseGitHubPullRequestLink } from "@orkestrator/protocol/github-pull-requests";
import {
  blockMarkdownPlugins,
  INLINE_MARKDOWN_ELEMENTS,
  INLINE_PLUGINS,
  MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS,
  MAX_INLINE_MARKDOWN_RENDER_CHARACTERS,
  markdownRenderSource,
  markdownUrlTransform,
} from "@/lib/chat/rich-markdown/markdown-plugins";
import {
  RichMarkdownRenderContext,
  type RichMarkdownRenderState,
} from "@/lib/chat/rich-markdown/render-context";
import { copyRichText } from "@/lib/chat/rich-markdown/clipboard";
import { SourceViewerDialog } from "@/components/chat/rich/CodeBlockViewer";
import { cn } from "@/lib/utils";

export {
  MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS,
  MAX_INLINE_MARKDOWN_RENDER_CHARACTERS,
  markdownRenderSource,
};
export type { MarkdownRenderSource } from "@/lib/chat/rich-markdown/markdown-plugins";

/*
 * Inline code is tinted rather than grey. Almost every inline span in a
 * transcript is a path, a filename or a flag, and a grey chip on a grey surface
 * made those disappear into the prose around them.
 *
 * The trailing `pre code` reset is load-bearing: the `prose-code:` variant
 * matches *every* `code`, including the one inside a fenced block, so without
 * it a code block would be painted blue chip-by-chip on top of its own surface.
 */
const DEFAULT_MARKDOWN_CLASSNAME =
  "text-sm text-foreground leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-code:text-xs prose-code:font-normal prose-code:text-blue-300 prose-code:bg-primary/12 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:before:content-none prose-code:after:content-none prose-pre:bg-muted prose-pre:p-3 prose-pre:rounded-md prose-table:text-xs prose-table:my-2 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0 [&_pre_code]:text-foreground";

const INLINE_MARKDOWN_COMPONENTS: Components = {
  // The preview sits inside a button, whose content must remain phrasing
  // content. Keep Markdown's paragraph parsing without emitting a block-level
  // <p>; links are replaced with noninteractive phrasing below.
  p: ({ children }) => <>{children}</>,
  // Links cannot remain interactive inside the preview's button. Unlike
  // unwrapDisallowed, this also keeps an empty-label link visible by falling
  // back to its destination (or its literal empty-label marker).
  a: ({ children, href }) => <>{Children.count(children) > 0 ? children : href || "[]"}</>,
};

interface TaskListCheckboxProps {
  checked?: boolean;
}

function TaskListCheckbox({ checked }: TaskListCheckboxProps) {
  return (
    <span
      aria-hidden="true"
      data-task-list-checkbox="true"
      data-state={checked ? "checked" : "unchecked"}
      className="hidden"
    />
  );
}

function isTaskListCheckbox(child: ReactNode): child is ReactElement<TaskListCheckboxProps> {
  return isValidElement(child) && child.type === TaskListCheckbox;
}

function MarkdownList({ className, children, ...props }: HTMLAttributes<HTMLUListElement>) {
  const isTaskList = className?.includes("contains-task-list");

  return (
    <ul className={cn(className, isTaskList && "list-none space-y-1 pl-0")} {...props}>
      {children}
    </ul>
  );
}

function MarkdownListItem({ className, children, ...props }: HTMLAttributes<HTMLLIElement>) {
  const childNodes = Children.toArray(children);
  const checkbox = childNodes.find(isTaskListCheckbox);

  if (!checkbox) {
    return (
      <li className={className} {...props}>
        {children}
      </li>
    );
  }

  const checked = Boolean(checkbox.props.checked);
  const content = childNodes.filter((child) => {
    if (isTaskListCheckbox(child)) {
      return false;
    }

    return typeof child !== "string" || child.trim().length > 0;
  });

  return (
    <li className={cn("my-1 flex list-none items-start gap-2", className)} {...props}>
      {checked ? (
        <CheckSquare
          aria-hidden="true"
          data-task-list-icon="true"
          data-state="checked"
          className="mt-0.5 h-4 w-4 shrink-0 text-green-500"
        />
      ) : (
        <Square
          aria-hidden="true"
          data-task-list-icon="true"
          data-state="unchecked"
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60"
        />
      )}
      <div
        className={cn(
          "min-w-0 flex-1 [&>p]:my-0 [&_ol]:mt-1 [&_ul]:mt-1",
          checked ? "text-muted-foreground/60 line-through" : "text-foreground",
        )}
      >
        {content}
      </div>
    </li>
  );
}

export function MarkdownLink({
  href,
  children,
  className,
  onClick,
  // react-markdown passes its hast node; it is not a DOM attribute.
  node: _node,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  const createFileTab = useOptionalTerminalContext()?.createFileTab;
  const openPullRequest = usePullRequestOpener();
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;

      event.preventDefault();
      if (!href) return;

      const fileTarget = parseLocalFileLinkTarget(href);
      if (fileTarget) {
        if (createFileTab) {
          if (fileTarget.lineNumber) {
            createFileTab(fileTarget.filePath, {
              lineNumber: fileTarget.lineNumber,
              ...(fileTarget.columnNumber !== undefined
                ? { columnNumber: fileTarget.columnNumber }
                : {}),
            });
          } else {
            createFileTab(fileTarget.filePath);
          }
        } else {
          toast.info("Start or open the environment to view this file", {
            description:
              "Workspace file links are available while the environment is active and running.",
          });
        }
        return;
      }

      // Pull request links open in the app; Cmd/Ctrl-click opens GitHub.
      const pullRequest = event.metaKey || event.ctrlKey ? null : parseGitHubPullRequestLink(href);
      if (pullRequest && openPullRequest(pullRequest, pullRequest.view)) return;

      void openInBrowser(href).catch((error) => {
        console.error("[MessageMarkdown] Failed to open link:", error);
      });
    },
    [createFileTab, href, onClick, openPullRequest],
  );

  return (
    <a
      {...props}
      href={href}
      className={cn("cursor-pointer text-blue-300 hover:underline", className)}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}

const DEFAULT_COMPONENTS: Components = {
  a: MarkdownLink,
  input: TaskListCheckbox,
  li: MarkdownListItem,
  ul: MarkdownList,
};

interface MessageMarkdownProps {
  content: string;
  components?: Components;
  className?: string;
  /** When false, single newlines are NOT converted to <br>. Defaults to true. */
  enableBreaks?: boolean;
  /**
   * Enables the rich transcript pipeline (code blocks, diagrams, callouts,
   * disclosures, tables) and names the stable source part its blocks belong
   * to. Callers pass the matching rich `components` map.
   */
  richPartId?: string;
  /** The part's text is still streaming (display hint for rich blocks). */
  live?: boolean;
}

/** Render Markdown phrasing without introducing block or interactive nodes. */
export const InlineMessageMarkdown = memo(function InlineMessageMarkdown({
  content,
  className,
}: Pick<MessageMarkdownProps, "content" | "className">) {
  const renderSource = useMemo(
    () => markdownRenderSource(content, MAX_INLINE_MARKDOWN_RENDER_CHARACTERS),
    [content],
  );
  return (
    <span
      className={cn(
        "[&_strong]:font-semibold [&_em]:italic [&_del]:line-through",
        "[&_code]:font-mono [&_code]:rounded-md [&_code]:bg-primary/12 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-blue-300",
        className,
      )}
    >
      <Markdown
        remarkPlugins={INLINE_PLUGINS}
        allowedElements={INLINE_MARKDOWN_ELEMENTS}
        unwrapDisallowed
        components={INLINE_MARKDOWN_COMPONENTS}
        urlTransform={markdownUrlTransform}
      >
        {renderSource.source}
      </Markdown>
      {renderSource.omittedCharacters > 0 ? (
        <span data-markdown-truncated="true" className="text-muted-foreground">
          {" "}
          … [{renderSource.omittedCharacters} additional characters omitted]
        </span>
      ) : null}
    </span>
  );
});

/**
 * Memoized: a streaming turn re-renders its whole message roughly ten times a
 * second, and every render would otherwise re-run remark over *every* block —
 * including the ones that finished streaming minutes ago. remark costs ~10ms
 * for a 9KB block, so a handful of completed blocks alone can burn a large
 * fraction of a core on output that cannot have changed.
 *
 * Memoizing on `content` is only sound because callers pass a stable
 * `components` map (`markdownComponents` in NativeMessage is module-level).
 * An inline object literal there would defeat this silently, so keep those
 * maps hoisted out of render.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  components,
  className,
  enableBreaks = true,
  richPartId,
  live = false,
}: MessageMarkdownProps) {
  const renderSource = useMemo(
    () => markdownRenderSource(content, MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS),
    [content],
  );
  const rich = richPartId !== undefined;
  const clipped = renderSource.omittedCharacters > 0;
  const plugins = useMemo(
    () => blockMarkdownPlugins({ rich, enableBreaks, clipped }),
    [rich, enableBreaks, clipped],
  );
  const mergedComponents = useMemo(
    () => (components ? { ...DEFAULT_COMPONENTS, ...components } : DEFAULT_COMPONENTS),
    [components],
  );
  // The original is kept separately from the bounded slice it renders.
  const richState = useMemo<RichMarkdownRenderState | null>(
    () =>
      rich
        ? {
            partId: richPartId,
            clipped,
            omittedCharacters: renderSource.omittedCharacters,
            live,
            renderedSource: renderSource.source,
            fullSource: content,
          }
        : null,
    [rich, richPartId, clipped, renderSource, live, content],
  );

  const markdown = (
    <Markdown
      remarkPlugins={plugins}
      components={mergedComponents}
      urlTransform={markdownUrlTransform}
    >
      {renderSource.source}
    </Markdown>
  );

  return (
    <div className={cn(DEFAULT_MARKDOWN_CLASSNAME, className)}>
      {richState ? (
        <RichMarkdownRenderContext value={richState}>{markdown}</RichMarkdownRenderContext>
      ) : (
        markdown
      )}
      {clipped ? (
        <MarkdownOmissionNotice
          omittedCharacters={renderSource.omittedCharacters}
          fullSource={rich ? content : null}
        />
      ) : null}
    </div>
  );
});

/**
 * The parser-cap notice. Chrome, not content: find and copy skip it. Rich
 * renders also offer the exact full source, which the cap never altered.
 */
function MarkdownOmissionNotice({
  omittedCharacters,
  fullSource,
}: {
  omittedCharacters: number;
  fullSource: string | null;
}) {
  const [viewerOpen, setViewerOpen] = useState(false);
  return (
    <div
      data-markdown-truncated="true"
      data-rich-chrome="true"
      className="not-prose mt-2 flex select-none flex-wrap items-center gap-x-3 gap-y-1 text-xs italic text-muted-foreground"
    >
      <span>
        {omittedCharacters} additional characters omitted from this rendered view to keep it
        responsive.
      </span>
      {fullSource !== null ? (
        <>
          <button
            type="button"
            className="not-italic underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => void copyRichText(fullSource, "full source")}
          >
            Copy full source
          </button>
          <button
            type="button"
            className="not-italic underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setViewerOpen(true)}
          >
            Open full source
          </button>
          {viewerOpen ? (
            <SourceViewerDialog
              open={viewerOpen}
              onOpenChange={setViewerOpen}
              title="Full message source"
              source={fullSource}
              copyLabel="full source"
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
