import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { KanbanBoard, ProjectNotesView } from "@/components/kanban";
import { useUIStore } from "@/stores";
import { CoordinatorPanel } from "./CoordinatorPanel";
import { LeafModeCoordinatorGate } from "./LeafModeCoordinatorGate";
import { ProjectSchedulesView } from "./ProjectSchedulesView";
import { useProjectCheckout, useProjectListError } from "./useProjectCheckout";

export function ProjectWorkspace({
  projectId,
  homeError,
  onRetryHome,
}: {
  projectId: string;
  homeError?: string | null;
  onRetryHome?: () => void;
}) {
  const tab = useUIStore((state) => state.projectBoardTab);
  const checkout = useProjectCheckout(projectId);
  const listError = useProjectListError();
  const hasCheckout = checkout === "ready";
  if (tab === "home") {
    // The project home's own tabs replace this panel once it is active.
    return (
      <div
        id="project-panel-home"
        role="tabpanel"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        {hasCheckout && homeError ? (
          <div role="alert" className="flex flex-col items-center gap-3">
            <p>Could not open the project home: {homeError}</p>
            <Button onClick={onRetryHome}>Retry opening Home</Button>
          </div>
        ) : hasCheckout ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Opening project home…
          </>
        ) : checkout === "unavailable" ? (
          <p role="alert">
            Could not load this machine's projects: {listError ?? "Failed to load projects"}
          </p>
        ) : checkout === "missing" ? (
          "This machine's project list has no project with this id. Open the project again from the sidebar."
        ) : checkout === "loading" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading project…
          </>
        ) : (
          "Set a local checkout in repository settings to work in the project home."
        )}
      </div>
    );
  }
  if (tab === "schedules") {
    return <ProjectSchedulesView key={projectId} projectId={projectId} />;
  }
  if (tab === "notes") {
    return (
      <div id="project-panel-notes" role="tabpanel" className="h-full">
        <ProjectNotesView projectId={projectId} />
      </div>
    );
  }
  return tab === "coordinator" ? (
    // A project switch must discard the prior checkout's live chat state even
    // when the next checkout fails to load.
    <LeafModeCoordinatorGate key={projectId} projectId={projectId}>
      <CoordinatorPanel projectId={projectId} />
    </LeafModeCoordinatorGate>
  ) : (
    <div id={`project-panel-${tab}`} role="tabpanel" className="h-full">
      <KanbanBoard projectId={projectId} />
    </div>
  );
}
