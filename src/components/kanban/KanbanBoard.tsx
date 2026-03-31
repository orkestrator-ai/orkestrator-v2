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
import { Plus, StickyNote } from "lucide-react";
import { useKanbanStore, type KanbanStatus, type KanbanTask } from "@/stores/kanbanStore";
import { useProjectStore } from "@/stores";
import { useBuildPipelineStore, type BuildPhase } from "@/stores/buildPipelineStore";
import { useShallow } from "zustand/react/shallow";
import { KanbanCard } from "./KanbanCard";
import { KanbanTaskDialog } from "./KanbanTaskDialog";
import { ProjectNotesView } from "./ProjectNotesView";

const COLUMNS: { id: KanbanStatus; label: string; color: string }[] = [
  { id: "backlog", label: "Backlog", color: "bg-zinc-500" },
  { id: "in-progress", label: "In Progress", color: "bg-blue-500" },
  { id: "review", label: "Review", color: "bg-amber-500" },
  { id: "done", label: "Done", color: "bg-green-500" },
];

interface KanbanBoardProps {
  projectId: string;
}

function DroppableColumn({
  column,
  tasks,
  onClickTask,
  onAddTask,
  buildPhaseByTaskId,
}: {
  column: (typeof COLUMNS)[number];
  tasks: KanbanTask[];
  onClickTask: (task: KanbanTask) => void;
  onAddTask?: () => void;
  buildPhaseByTaskId: Map<string, BuildPhase>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      className="flex flex-col min-w-[280px] w-[320px] shrink-0 h-full"
    >
      {/* Column Header */}
      <div className="flex items-center gap-2 px-3 py-2 mb-2">
        <div className={`h-2.5 w-2.5 rounded-full ${column.color}`} />
        <h3 className="text-sm font-semibold text-foreground">{column.label}</h3>
        <span className="text-xs text-muted-foreground ml-auto">
          {tasks.length}
        </span>
        {onAddTask && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={onAddTask}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Column Body */}
      <div
        className={`flex-1 rounded-lg border border-border/50 p-2 transition-colors min-h-[200px] overflow-y-auto ${
          isOver ? "bg-accent/30 border-primary/30" : "bg-muted/20"
        }`}
      >
        <div className="space-y-2">
          {tasks.map((task) => (
            <KanbanCard
              key={task.id}
              task={task}
              onClick={() => onClickTask(task)}
              buildPhase={buildPhaseByTaskId.get(task.id)}
            />
          ))}
        </div>
        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
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
  const getProjectById = useProjectStore((s) => s.getProjectById);

  const buildPhaseRecord = useBuildPipelineStore(
    useShallow((s) => {
      const record: Record<string, BuildPhase> = {};
      for (const pipeline of s.pipelines.values()) {
        if (pipeline.projectId === projectId) {
          record[pipeline.taskId] = pipeline.phase;
        }
      }
      return record;
    })
  );

  const buildPhaseByTaskId = useMemo(
    () => new Map(Object.entries(buildPhaseRecord)),
    [buildPhaseRecord]
  );

  const project = getProjectById(projectId);

  // Load tasks from backend when project changes
  useEffect(() => {
    void loadTasks(projectId);
  }, [projectId, loadTasks]);

  const [selectedTask, setSelectedTask] = useState<KanbanTask | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId]
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

  const activeTask = useMemo(
    () => (activeTaskId ? projectTasks.find((t) => t.id === activeTaskId) ?? null : null),
    [activeTaskId, projectTasks]
  );

  // Refresh selectedTask from store when dialog is open
  const currentSelectedTask = useMemo(() => {
    if (!selectedTask) return null;
    return tasks.find((t) => t.id === selectedTask.id) ?? null;
  }, [selectedTask, tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

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
    [moveTask]
  );

  const handleClickTask = useCallback((task: KanbanTask) => {
    setSelectedTask(task);
    setDialogOpen(true);
  }, []);

  if (showNotes) {
    return <ProjectNotesView projectId={projectId} onBack={() => setShowNotes(false)} />;
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Board Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground">
          {project?.name ?? "Project"} Board
        </h2>
        <span className="text-sm text-muted-foreground">
          {projectTasks.length} task{projectTasks.length !== 1 && "s"}
        </span>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setShowNotes(true)}
          >
            <StickyNote className="h-3.5 w-3.5" />
            Project Notes
          </Button>
        </div>
      </div>

      {/* Columns */}
      <div className="flex-1 overflow-x-auto p-6">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 h-full">
            {COLUMNS.map((column) => (
              <DroppableColumn
                key={column.id}
                column={column}
                tasks={tasksByColumn[column.id]}
                onClickTask={handleClickTask}
                onAddTask={
                  column.id === "backlog"
                    ? () => setCreateDialogOpen(true)
                    : undefined
                }
                buildPhaseByTaskId={buildPhaseByTaskId}
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
              />
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Task Detail Dialog */}
      <KanbanTaskDialog
        task={currentSelectedTask}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />

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
