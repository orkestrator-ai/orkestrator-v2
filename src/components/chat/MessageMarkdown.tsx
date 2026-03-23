import {
  Children,
  isValidElement,
  useMemo,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { CheckSquare, Square } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { cn } from "@/lib/utils";

const DEFAULT_MARKDOWN_CLASSNAME =
  "text-sm text-foreground leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:p-3 prose-pre:rounded-md prose-table:text-xs prose-table:my-2";

const PLUGINS_WITH_BREAKS: PluggableList = [remarkGfm, remarkBreaks];
const PLUGINS_WITHOUT_BREAKS: PluggableList = [remarkGfm];

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

function isTaskListCheckbox(
  child: ReactNode,
): child is ReactElement<TaskListCheckboxProps> {
  return isValidElement(child) && child.type === TaskListCheckbox;
}

function MarkdownList({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLUListElement>) {
  const isTaskList = className?.includes("contains-task-list");

  return (
    <ul
      className={cn(className, isTaskList && "list-none space-y-1 pl-0")}
      {...props}
    >
      {children}
    </ul>
  );
}

function MarkdownListItem({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLLIElement>) {
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
    <li
      className={cn("my-1 flex list-none items-start gap-2", className)}
      {...props}
    >
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

const DEFAULT_COMPONENTS: Components = {
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

export function MessageMarkdown({
  content,
  components,
  className,
  enableBreaks = true,
}: MessageMarkdownProps) {
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
        {content}
      </Markdown>
    </div>
  );
}
