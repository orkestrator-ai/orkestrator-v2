import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useMemo,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { CheckSquare, Square } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList, Processor } from "unified";
import { openInBrowser } from "@/lib/backend";
import { cn } from "@/lib/utils";

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

const PLUGINS_WITH_BREAKS: PluggableList = [remarkGfm, remarkBreaks];
const PLUGINS_WITHOUT_BREAKS: PluggableList = [remarkGfm];

/**
 * Hard parser-boundary budgets. Transcript-specific presentation helpers may
 * apply smaller limits, but no caller can make react-markdown parse beyond
 * these caps accidentally.
 */
export const MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS = 32_000;
export const MAX_INLINE_MARKDOWN_RENDER_CHARACTERS = 8_000;

export interface MarkdownRenderSource {
  source: string;
  omittedCharacters: number;
}

export function markdownRenderSource(content: string, limit: number): MarkdownRenderSource {
  if (content.length <= limit) return { source: content, omittedCharacters: 0 };
  return {
    source: content.slice(0, limit),
    omittedCharacters: content.length - limit,
  };
}

/**
 * Block constructs that must not fire on a single-line inline render.
 *
 * An inline caller has already flattened its text onto one line, so none of
 * these can carry the meaning they normally would — they can only consume
 * their own marker. `- read the reducer` would render as `read the reducer`,
 * `# Plan` as `Plan`, and a line that is exactly `---` as nothing at all,
 * silently dropping text the caller asked to display. Disabling them keeps the
 * source characters visible and guarantees the parse yields one paragraph.
 *
 * `labelStartImage` is in the list for the same reason: an image is not
 * phrasing content this renderer emits, so `![alt](url)` would unwrap to an
 * empty string rather than showing the text the author wrote.
 */
const INLINE_ONLY_DISABLED_CONSTRUCTS = [
  "blockQuote",
  "codeFenced",
  "codeIndented",
  "definition",
  "headingAtx",
  "htmlFlow",
  "labelStartImage",
  "list",
  "setextUnderline",
  "thematicBreak",
];

/**
 * `micromarkExtensions` is contributed to unified's `Data` by `remark-parse`,
 * which reaches this package only as a transitive dependency of react-markdown
 * and so cannot be imported here for its type augmentation. Name the one field
 * this plugin touches rather than widening `data` to `any`.
 */
type MicromarkExtensionData = {
  micromarkExtensions?: Array<{ disable?: { null?: Array<string> } }>;
};

function remarkInlineOnly(this: Processor): undefined {
  const data = this.data() as MicromarkExtensionData;
  data.micromarkExtensions ??= [];
  data.micromarkExtensions.push({ disable: { null: INLINE_ONLY_DISABLED_CONSTRUCTS } });
}

const INLINE_PLUGINS: PluggableList = [remarkGfm, remarkInlineOnly];
const INLINE_MARKDOWN_ELEMENTS = ["p", "strong", "em", "del", "code", "a"];
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

function SafeMarkdownLink({
  href,
  children,
  className,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;

      event.preventDefault();
      if (!href) return;

      void openInBrowser(href).catch((error) => {
        console.error("[MessageMarkdown] Failed to open link:", error);
      });
    },
    [href, onClick],
  );

  return (
    <a
      {...props}
      href={href}
      className={cn("cursor-pointer text-primary hover:underline", className)}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}

const DEFAULT_COMPONENTS: Components = {
  a: SafeMarkdownLink,
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
}: MessageMarkdownProps) {
  const renderSource = useMemo(
    () => markdownRenderSource(content, MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS),
    [content],
  );
  const plugins = useMemo(
    () => (enableBreaks ? PLUGINS_WITH_BREAKS : PLUGINS_WITHOUT_BREAKS),
    [enableBreaks],
  );
  const mergedComponents = useMemo(
    () => (components ? { ...DEFAULT_COMPONENTS, ...components } : DEFAULT_COMPONENTS),
    [components],
  );

  return (
    <div className={cn(DEFAULT_MARKDOWN_CLASSNAME, className)}>
      <Markdown remarkPlugins={plugins} components={mergedComponents}>
        {renderSource.source}
      </Markdown>
      {renderSource.omittedCharacters > 0 ? (
        <p data-markdown-truncated="true" className="mt-2 text-xs italic text-muted-foreground">
          {renderSource.omittedCharacters} additional characters omitted from this rendered view to
          keep it responsive.
        </p>
      ) : null}
    </div>
  );
});
