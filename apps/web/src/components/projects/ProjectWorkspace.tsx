import { KanbanBoard } from "@/components/kanban";
import { useUIStore } from "@/stores";
import { CoordinatorPanel } from "./CoordinatorPanel";

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  const tab = useUIStore((state) => state.projectBoardTab);
  return tab === "coordinator" ? (
    // A project switch must discard the prior checkout's live chat state even
    // when the next checkout fails to load.
    <CoordinatorPanel key={projectId} projectId={projectId} />
  ) : (
    <div id={`project-panel-${tab}`} role="tabpanel" className="h-full">
      <KanbanBoard projectId={projectId} />
    </div>
  );
}
