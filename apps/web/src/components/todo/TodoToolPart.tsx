import { useState } from "react";
import { AlertCircle, CheckSquare, ChevronRight, ListTodo, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { getTodoItems, getTodoToolLabel } from "@/lib/todo-tool";
import type { TodoStatus } from "@/lib/todo-tool";
import type { TaskListSnapshot } from "@/lib/chat/native-message-types";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export const TOOL_STATE_COLORS = {
  success: "text-green-600",
  failure: "text-red-400",
  pending: "text-yellow-600 animate-pulse",
} as const;

interface TodoToolPartProps {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  /**
   * State of the whole task list after this call, for providers whose task
   * tools mutate one task at a time. Computed by the backend that saw the call
   * — including which task it changed — so nothing here re-parses tool output.
   * When present it is what gets rendered, so every call shows the current list
   * rather than just the task it touched.
   */
  taskSnapshot?: TaskListSnapshot;
}

interface DisplayTask {
  id?: string;
  content: string;
  status: TodoStatus;
}

export function TodoToolPart({
  toolName,
  toolState,
  toolArgs,
  toolOutput,
  toolError,
  taskSnapshot,
}: TodoToolPartProps) {
  const [isOpen, setIsOpen] = useState(false);
  const toolLabel = getTodoToolLabel(toolName);

  // A snapshot describes the whole list, so it wins over the per-call args and
  // output, which only ever describe a single task. An empty snapshot is a real
  // state (every task deleted) and is rendered as such. A backend that could
  // not parse the call sends no snapshot at all, which lands on the fallback
  // below rather than showing an empty list as though it were fact.
  const hasSnapshot = taskSnapshot !== undefined;
  const todos: DisplayTask[] = hasSnapshot
    ? taskSnapshot.items.map((task) => ({
        id: task.id,
        content: task.subject,
        status: task.status,
      }))
    : getTodoItems(toolArgs, toolOutput, toolName);

  const changedTaskId = taskSnapshot?.changedTaskId;
  const truncatedCount = taskSnapshot?.truncated ?? 0;
  // The backend knows its view is missing tasks it never saw created, so the
  // list is shown without any claim to be the whole of it.
  const isPartialList = hasSnapshot && !taskSnapshot.complete;

  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const cancelledCount = todos.filter((todo) => todo.status === "cancelled").length;
  const totalCount = todos.length;

  const hasExpandableContent =
    totalCount > 0 || hasSnapshot || Boolean(toolOutput) || Boolean(toolError);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-0">
      <CollapsibleTrigger
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs leading-none text-muted-foreground transition-colors hover:text-foreground",
          hasExpandableContent ? "cursor-pointer" : "cursor-default",
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0",
          )}
        />
        <ListTodo className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0 font-medium leading-none">
          {toolLabel}
        </span>
        {totalCount > 0 && (
          <span className="flex-1 text-left text-muted-foreground/80 leading-none">
            {/* A partial list has no denominator worth quoting: the total is
                whatever this backend happened to see, not the real one. */}
            {isPartialList
              ? `${totalCount} task${totalCount === 1 ? "" : "s"} tracked`
              : `${completedCount}/${totalCount} complete`}
            {cancelledCount > 0 ? ` (${cancelledCount} cancelled)` : ""}
            {truncatedCount > 0 ? ` +${truncatedCount} more` : ""}
          </span>
        )}
        {totalCount === 0 && hasSnapshot && (
          <span className="flex-1 text-left text-muted-foreground/80 leading-none">
            {isPartialList ? "no tasks tracked" : "no tasks"}
          </span>
        )}
        {toolState && (
          <span className={cn("ml-auto shrink-0 leading-none", TOOL_STATE_COLORS[toolState] || "")}>
            {toolState === "pending" ? "running..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="overflow-hidden border-l border-border/40 pl-3">
            {totalCount > 0 && (
              <div className="space-y-1.5 px-3 py-2">
                {todos.map((todo, index) => {
                  const isChanged =
                    todo.id !== undefined && todo.id === changedTaskId;

                  return (
                    <div
                      key={todo.id ?? `todo-${index}-${todo.content.slice(0, 30)}`}
                      className={cn(
                        "flex items-start gap-2 rounded-sm text-xs",
                        todo.status === "completed" && "text-muted-foreground/60",
                        isChanged && "bg-muted/50 -mx-1 px-1 py-0.5",
                      )}
                    >
                      {todo.status === "completed" ? (
                        <CheckSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                      ) : (
                        <Square
                          className={cn(
                            "mt-0.5 h-3.5 w-3.5 shrink-0",
                            todo.status === "in_progress"
                              ? "text-yellow-500"
                              : todo.status === "cancelled"
                                ? "text-red-500"
                                : "text-muted-foreground/50",
                          )}
                        />
                      )}
                      {todo.id !== undefined && (
                        <span className="mt-px shrink-0 font-mono text-[10px] text-muted-foreground/60">
                          #{todo.id}
                        </span>
                      )}
                      <span
                        className={cn(
                          "flex-1",
                          todo.status === "completed" && "line-through",
                          todo.status === "cancelled" &&
                            "line-through text-muted-foreground/70",
                          todo.status === "in_progress" && "font-medium text-foreground",
                        )}
                      >
                        {todo.content}
                      </span>
                      {todo.status === "in_progress" && (
                        <span className="shrink-0 text-[10px] text-yellow-500">
                          in progress
                        </span>
                      )}
                      {todo.status === "cancelled" && (
                        <span className="shrink-0 text-[10px] text-red-500">
                          cancelled
                        </span>
                      )}
                    </div>
                  );
                })}

                {isPartialList && (
                  <div className="pt-1 text-[10px] text-muted-foreground/60">
                    Tasks created before this session was being watched are not
                    shown.
                  </div>
                )}

                {truncatedCount > 0 && (
                  <div className="pt-1 text-[10px] text-muted-foreground/60">
                    {truncatedCount} more task{truncatedCount === 1 ? "" : "s"} not
                    shown.
                  </div>
                )}
              </div>
            )}

            {totalCount === 0 && hasSnapshot && (
              <div className="px-3 py-2 text-xs text-muted-foreground/70">
                {isPartialList
                  ? "No tasks tracked yet for this session."
                  : "Task list is empty."}
              </div>
            )}

            {totalCount === 0 && !hasSnapshot && toolOutput && (
              <div className="max-h-64 overflow-auto px-3 py-2">
                <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground/80">
                  {toolOutput}
                </pre>
              </div>
            )}

            {toolError && (
              <div className="border-t border-destructive/20 px-3 py-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  <pre className="whitespace-pre-wrap break-all font-mono text-xs text-destructive/80">
                    {toolError}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
