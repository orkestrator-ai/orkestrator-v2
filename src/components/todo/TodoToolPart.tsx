import { useState } from "react";
import { AlertCircle, CheckSquare, ChevronRight, ListTodo, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { getTodoItems, getTodoToolLabel } from "@/lib/todo-tool";
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
}

export function TodoToolPart({
  toolName,
  toolState,
  toolArgs,
  toolOutput,
  toolError,
}: TodoToolPartProps) {
  const [isOpen, setIsOpen] = useState(false);
  const todos = getTodoItems(toolArgs, toolOutput, toolName);
  const toolLabel = getTodoToolLabel(toolName);
  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const cancelledCount = todos.filter((todo) => todo.status === "cancelled").length;
  const totalCount = todos.length;

  const hasExpandableContent =
    totalCount > 0 || Boolean(toolOutput) || Boolean(toolError);

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
            {completedCount}/{totalCount} complete
            {cancelledCount > 0 ? ` (${cancelledCount} cancelled)` : ""}
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
                {todos.map((todo, index) => (
                  <div
                    key={`todo-${index}-${todo.content.slice(0, 30)}`}
                    className={cn(
                      "flex items-start gap-2 text-xs",
                      todo.status === "completed" && "text-muted-foreground/60",
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
                ))}
              </div>
            )}

            {totalCount === 0 && toolOutput && (
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
