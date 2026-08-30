import { useState, useMemo, useCallback, useEffect } from "react";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Plus } from "lucide-react";
import { useKanbanStore, type KanbanStatus, type KanbanTask } from "@/stores/kanbanStore";
import { useEnvironmentStore, useUIStore, type ProjectBoardTab } from "@/stores";
import {
  useBuildPipelineStore,
  isActiveBuildPhase,
  type BuildPhase,
} from "@/stores/buildPipelineStore";
import { useShallow } from "zustand/react/shallow";
import { KanbanCard } from "./KanbanCard";
import { KanbanTaskDialog } from "./KanbanTaskDialog";
import { ProjectNotesView } from "./ProjectNotesView";
import { FeaturesView } from "./FeaturesView";
import { LinearTicketsView } from "@/components/linear";
import { GitHubIssuesView } from "@/components/github";

const COLUMNS: { id: KanbanStatus; label: string; color: string }[] = [
  { id: "backlog", label: "Backlog", color: "bg-zinc-500" },
  { id: "in-progress", label: "In Progress", color: "bg-blue-500" },
  { id: "review", label: "Review", color: "bg-amber-500" },
  { id: "done", label: "Done", color: "bg-green-500" },
];

interface KanbanBoardProps {
  projectId: string;
}

/**
 * Whether the "Clear status" action should be offered for a task. It requires a
 * clearable link (environment, pipeline, or any build phase) AND that the build
 * is not actively running — an active build owns a live agent session that must
 * be stopped (which aborts the session) before its status can be cleared.
 */
export function canClearTaskBuildStatus(
  task: KanbanTask,
  buildPhase: BuildPhase | undefined,
): boolean {
  const hasClearableStatus = !!(task.environmentId || task.buildPipelineId || buildPhase);
  return hasClearableStatus && !(buildPhase ? isActiveBuildPhase(buildPhase) : false);
}

function DroppableColumn({
  column,
  tasks,
  onClickTask,
  onAddTask,
  onClearTaskStatus,
  buildPhaseByTaskId,
  environmentNameByTaskId,
}: {
  column: (typeof COLUMNS)[number];
  tasks: KanbanTask[];
  onClickTask: (task: KanbanTask) => void;
  onAddTask?: () => void;
  onClearTaskStatus: (task: KanbanTask) => void;
  buildPhaseByTaskId: Map<string, BuildPhase>;
  environmentNameByTaskId: Map<string, string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      className="flex h-full w-[calc(100vw-2rem)] min-w-[260px] shrink-0 flex-col sm:w-[320px] sm:min-w-[280px]"
    >
      {/* Column Header */}
      <div className="mb-2 flex h-9 items-center gap-2 border-b border-border/60 px-1 pb-2">
        <div className={`h-2 w-2 rounded-full ${column.color}`} />
        <h3 className="text-sm font-semibold text-foreground">{column.label}</h3>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground">
          {tasks.length}
        </span>
        {onAddTask && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Add task to ${column.label}`}
            className="ml-auto h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={onAddTask}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Column Body */}
      <div
        className={`min-h-[200px] flex-1 overflow-y-auto rounded-lg p-1 transition-colors ${
          isOver ? "bg-accent/20" : "bg-transparent"
        }`}
      >
        <div className="space-y-2">
          {tasks.map((task) => {
            const buildPhase = buildPhaseByTaskId.get(task.id);
            return (
              <KanbanCard
                key={task.id}
                task={task}
                onClick={() => onClickTask(task)}
                buildPhase={buildPhase}
                environmentName={environmentNameByTaskId.get(task.id)}
                canClearStatus={canClearTaskBuildStatus(task, buildPhase)}
                onClearStatus={onClearTaskStatus}
              />
            );
          })}
        </div>
        {tasks.length === 0 && (
          <div
            className={`flex h-20 items-center justify-center rounded-lg border border-dashed text-xs transition-colors ${
              isOver
                ? "border-primary/60 bg-primary/5 text-primary"
                : "border-border/60 text-muted-foreground"
            }`}
          >
            Drop tasks here
          </div>
        )}
      </div>
    </div>
  );
}

export function KanbanBoard({ projectId }: KanbanBoardProps) {
  const tasks = useKanbanStore((s) => s.tasks);
  const loadTasks = useKanbanStore((s) => s.loadTasks);
  const moveTask = useKanbanStore((s) => s.moveTask);
  const clearTaskBuildStatus = useKanbanStore((s) => s.clearTaskBuildStatus);
  const screenTab = useUIStore((s) => s.projectBoardTab);
  const setScreenTab = useUIStore((s) => s.setProjectBoardTab);
  const projectBoardNotesOpen = useUIStore((s) => s.projectBoardNotesOpen);
  const setProjectBoardNotesOpen = useUIStore((s) => s.setProjectBoardNotesOpen);

  const buildPhaseRecord = useBuildPipelineStore(
    useShallow((s) => {
      const record: Record<string, BuildPhase> = {};
      for (const pipeline of s.pipelines.values()) {
        if (pipeline.projectId === projectId) {
          record[pipeline.taskId] = pipeline.phase;
        }
      }
      return record;
    }),
  );

  // A task links to its environment directly once the build has created one;
  // before that the pipeline is the only place the id exists.
  const pipelineEnvironmentRecord = useBuildPipelineStore(
    useShallow((s) => {
      const record: Record<string, string> = {};
      for (const pipeline of s.pipelines.values()) {
        if (pipeline.projectId === projectId && pipeline.environmentId) {
          record[pipeline.taskId] = pipeline.environmentId;
        }
      }
      return record;
    }),
  );

  const environmentNameRecord = useEnvironmentStore(
    useShallow((s) => {
      const record: Record<string, string> = {};
      for (const environment of s.environments) {
        if (environment.projectId === projectId) {
          record[environment.id] = environment.name;
        }
      }
      return record;
    }),
  );

  const buildPhaseByTaskId = useMemo(
    () => new Map(Object.entries(buildPhaseRecord)),
    [buildPhaseRecord],
  );

  // Load tasks from backend when project changes
  useEffect(() => {
    void loadTasks(projectId);
  }, [projectId, loadTasks]);

  const [selectedTask, setSelectedTask] = useState<KanbanTask | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId],
  );

  const tasksByColumn = useMemo(() => {
    const grouped: Record<KanbanStatus, KanbanTask[]> = {
      backlog: [],
      "in-progress": [],
      review: [],
      done: [],
    };
    for (const task of projectTasks) {
      grouped[task.status].push(task);
    }
    // Sort by order within each column
    for (const key of Object.keys(grouped) as KanbanStatus[]) {
      grouped[key].sort((a, b) => a.order - b.order);
    }
    return grouped;
  }, [projectTasks]);

  const environmentNameByTaskId = useMemo(() => {
    const byTaskId = new Map<string, string>();
    for (const task of projectTasks) {
      const environmentId = task.environmentId ?? pipelineEnvironmentRecord[task.id];
      const name = environmentId ? environmentNameRecord[environmentId] : undefined;
      if (name) byTaskId.set(task.id, name);
    }
    return byTaskId;
  }, [projectTasks, pipelineEnvironmentRecord, environmentNameRecord]);

  const activeTask = useMemo(
    () => (activeTaskId ? (projectTasks.find((t) => t.id === activeTaskId) ?? null) : null),
    [activeTaskId, projectTasks],
  );

  // Refresh selectedTask from store when dialog is open
  const currentSelectedTask = useMemo(() => {
    if (!selectedTask) return null;
    return tasks.find((t) => t.id === selectedTask.id) ?? null;
  }, [selectedTask, tasks]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveTaskId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTaskId(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const overId = over.id as string;

      // Dropped on a column
      const targetColumn = COLUMNS.find((c) => c.id === overId);
      if (targetColumn) {
        void moveTask(taskId, targetColumn.id);
      }
    },
    [moveTask],
  );

  const handleClickTask = useCallback((task: KanbanTask) => {
    setSelectedTask(task);
    setDialogOpen(true);
  }, []);

  const handleClearTaskStatus = useCallback(
    (task: KanbanTask) => {
      void clearTaskBuildStatus(task.id);
    },
    [clearTaskBuildStatus],
  );

  if (projectBoardNotesOpen) {
    return (
      <ProjectNotesView projectId={projectId} onBack={() => setProjectBoardNotesOpen(false)} />
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <Tabs
        value={screenTab}
        onValueChange={(value) => setScreenTab(value as ProjectBoardTab)}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsContent
          value="kanban"
          className="m-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col"
        >
          {/* Columns */}
          <div className="flex-1 snap-x snap-mandatory overflow-x-auto p-3 sm:p-6">
            <DndContext
              sensors={sensors}
              collisionDetection={pointerWithin}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <div className="flex h-full gap-3 sm:gap-4 [&>div]:snap-center">
                {COLUMNS.map((column) => (
                  <DroppableColumn
                    key={column.id}
                    column={column}
                    tasks={tasksByColumn[column.id]}
                    onClickTask={handleClickTask}
                    onAddTask={
                      column.id === "backlog" ? () => setCreateDialogOpen(true) : undefined
                    }
                    onClearTaskStatus={handleClearTaskStatus}
                    buildPhaseByTaskId={buildPhaseByTaskId}
                    environmentNameByTaskId={environmentNameByTaskId}
                  />
                ))}
              </div>

              <DragOverlay>
                {activeTask && (
                  <KanbanCard
                    task={activeTask}
                    onClick={() => {}}
                    isDragOverlay
                    buildPhase={buildPhaseByTaskId.get(activeTask.id)}
                    environmentName={environmentNameByTaskId.get(activeTask.id)}
                  />
                )}
              </DragOverlay>
            </DndContext>
          </div>
        </TabsContent>

        <TabsContent
          value="github"
          className="m-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col"
        >
          <GitHubIssuesView projectId={projectId} />
        </TabsContent>

        <TabsContent
          value="linear"
          className="m-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col"
        >
          <LinearTicketsView projectId={projectId} />
        </TabsContent>

        <TabsContent
          value="features"
          className="m-0 h-full min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col"
        >
          <FeaturesView projectId={projectId} />
        </TabsContent>
      </Tabs>

      {/* Task Detail Dialog */}
      <KanbanTaskDialog task={currentSelectedTask} open={dialogOpen} onOpenChange={setDialogOpen} />

      {/* Create Task Dialog */}
      <KanbanTaskDialog
        task={null}
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        createForProjectId={projectId}
      />
    </div>
  );
}
