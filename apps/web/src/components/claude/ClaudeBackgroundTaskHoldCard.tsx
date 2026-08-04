import { useCallback, useEffect, useState } from "react";
import { Clock3, Loader2, Square } from "lucide-react";
import { BlockingPromptCard } from "@/components/chat/BlockingPromptCard";
import { Button } from "@/components/ui/button";
import type { ClaudeBackgroundTask } from "@/lib/claude-client";

interface ClaudeBackgroundTaskHoldCardProps {
  tasks: ClaudeBackgroundTask[];
  onStopTask: (taskId: string) => Promise<boolean>;
}

interface StopError {
  taskId: string;
  message: string;
}

function taskLabel(task: ClaudeBackgroundTask): string {
  return task.description?.trim() || `Background task ${task.id}`;
}

/**
 * Explains the otherwise-confusing state where Claude has produced its answer
 * but intentionally remains running so real background work can continue.
 */
export function ClaudeBackgroundTaskHoldCard({
  tasks,
  onStopTask,
}: ClaudeBackgroundTaskHoldCardProps) {
  const [stoppingTaskIds, setStoppingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [stopError, setStopError] = useState<StopError | null>(null);

  useEffect(() => {
    const liveTaskIds = new Set(tasks.map((task) => task.id));
    setStoppingTaskIds((current) => {
      const next = new Set(
        Array.from(current).filter((taskId) => liveTaskIds.has(taskId)),
      );
      return next.size === current.size ? current : next;
    });
    setStopError((current) => (
      current && !liveTaskIds.has(current.taskId) ? null : current
    ));
  }, [tasks]);

  const stopTask = useCallback(
    async (task: ClaudeBackgroundTask) => {
      if (stoppingTaskIds.has(task.id)) return;
      setStopError(null);
      setStoppingTaskIds((current) => new Set(current).add(task.id));
      let stopped = false;
      try {
        stopped = await onStopTask(task.id);
      } catch {
        stopped = false;
      }
      if (!stopped) {
        setStoppingTaskIds((current) => {
          const next = new Set(current);
          next.delete(task.id);
          return next;
        });
        setStopError({
          taskId: task.id,
          message: `Could not stop “${taskLabel(task)}”. Try again or use the main Stop control.`,
        });
      }
      // On success the button remains disabled until the authoritative task
      // snapshot removes it from this live list. That prevents duplicate stop
      // requests while the SSE/REST lifecycle update is in flight.
    },
    [onStopTask, stoppingTaskIds],
  );

  const count = tasks.length;
  const noun = count === 1 ? "task" : "tasks";

  return (
    <BlockingPromptCard
      title={`Response ready · ${count} background ${noun} still running`}
      description="Claude will finish this turn when these tasks stop. Stop only tasks that were created for waiting."
      icon={<Clock3 className="h-4 w-4" />}
      error={stopError?.message ?? null}
      arrivalAnnouncement="Claude's response is ready, but background tasks are still running."
      aria-label="Claude background tasks keeping the turn open"
      data-testid="claude-background-task-hold"
    >
      <div className="max-h-44 divide-y divide-border/70 overflow-y-auto">
        {tasks.map((task) => {
          const stopping = stoppingTaskIds.has(task.id);
          const label = taskLabel(task);
          return (
            <div
              key={task.id}
              className="flex min-w-0 items-center gap-3 px-4 py-2.5"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={label}>
                {label}
              </span>
              <span className="shrink-0 text-[11px] capitalize text-muted-foreground">
                {task.status}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={stopping}
                aria-label={`Stop ${label}`}
                onClick={() => void stopTask(task)}
              >
                {stopping ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Square className="h-3 w-3 fill-current" aria-hidden />
                )}
                {stopping ? "Stopping" : "Stop"}
              </Button>
            </div>
          );
        })}
      </div>
    </BlockingPromptCard>
  );
}
