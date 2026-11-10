import { useState } from "react";
import { AlertCircle, FolderX, GitBranch, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadProjectsFromBackend } from "@/hooks/useProjects";
import { useNodeScope } from "@/lib/node-scope/providers";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useProjectListError, type ProjectCheckoutState } from "./useProjectCheckout";

/**
 * The coordinator's panel while it cannot read the project's checkout. A
 * project this node does not have is told apart from one with no local path:
 * only the second can be fixed in Repository settings, which would otherwise
 * open for a project the node cannot find and close at once. A list that
 * could not be read is not reported as an absence: it shows the read error.
 */
export function ProjectCheckoutNotice({
  projectId,
  state,
}: {
  projectId: string;
  state: Exclude<ProjectCheckoutState, "ready">;
}) {
  const scope = useNodeScope();
  const listError = useProjectListError();
  const [reloading, setReloading] = useState(false);

  if (state === "loading") {
    return (
      <div
        id="project-panel-coordinator"
        role="tabpanel"
        className="grid h-full place-items-center"
      >
        <div role="status">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading project</span>
        </div>
      </div>
    );
  }

  const unavailable = state === "unavailable";
  const missing = state === "missing";
  const canReload = unavailable || missing;
  const Icon = unavailable ? AlertCircle : missing ? FolderX : GitBranch;
  return (
    <div
      id="project-panel-coordinator"
      role="tabpanel"
      className="grid h-full place-items-center p-8"
    >
      <div className="max-w-lg rounded-xl border border-border bg-card p-6 text-center">
        <Icon className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">
          {unavailable
            ? "Could not load this machine's projects"
            : missing
              ? "Project not found on this machine"
              : "Connect a local checkout"}
        </h2>
        {unavailable ? (
          <>
            <p role="alert" className="mt-2 text-sm text-muted-foreground">
              The project list could not be read: {listError ?? "Failed to load projects"}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Whether this machine has the project is unknown until its project list loads.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {missing
              ? "This machine's project list has no project with this id. Open the project again from the sidebar, or reload this machine's projects."
              : "Coordinator reads the project’s real local checkout. Set a valid local path in Repository settings to continue."}
          </p>
        )}
        {canReload ? (
          <Button
            className="mt-4"
            variant="outline"
            disabled={reloading}
            onClick={() => {
              setReloading(true);
              void loadProjectsFromBackend(scope).finally(() => setReloading(false));
            }}
          >
            <RotateCcw className="size-4" />
            {reloading ? "Reloading…" : "Reload projects"}
          </Button>
        ) : (
          <Button
            className="mt-4"
            variant="outline"
            onClick={() =>
              useAppDialogStore
                .getState()
                .open({ kind: "repository-settings", nodeId: scope.nodeId, projectId })
            }
          >
            Repository settings
          </Button>
        )}
      </div>
    </div>
  );
}
