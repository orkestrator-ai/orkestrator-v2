import { useId } from "react";
import { Bug, Container, FolderGit2, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHostMaintenance } from "@/components/settings/useHostMaintenance";
import { openBugReport } from "@/lib/bug-report/open-bug-report";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useBugReportStore } from "@/stores/bugReportStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";

const SETTINGS_LABEL = "Global settings";
const REPOSITORY_SETTINGS_LABEL = "Repository settings";
const ENVIRONMENT_SETTINGS_LABEL = "Environment settings";
const UPDATE_AVAILABLE = "Update available";
const BUG_REPORT_LABEL = "Report a bug";
const DRAFT_IN_PROGRESS = "Draft in progress";

/** The dot on a bar button that has something waiting behind it. */
function IndicatorDot({ testId }: { testId: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-primary"
    />
  );
}

/**
 * The static bar under the projects and environments list: global, repository
 * and environment settings on the left, the bug report on the right.
 *
 * Every button opens a surface that lives outside the sidebar
 * (`GlobalSettingsHost`, `AppDialogHost` and the bug report sheet, which
 * `AppShell` hosts), because in the mobile drawer the sidebar unmounts when the
 * drawer closes for them. Global settings go through `requestGlobalSettings`,
 * so every opener shares one path. Repository and environment settings target
 * the active machine’s selected project and environment. Remote requests go
 * to its workspace realm; local requests go to `AppDialogHost`. Buttons stay
 * in place but disabled while
 * there is none, so the bar does not shift as the selection changes.
 *
 * The settings dot follows the connected host's updater: the snapshot behind
 * Settings → Machines, where the update is installed, and the host update toast.
 */
export function SidebarBottomBar() {
  const settingsDescriptionId = useId();
  const bugDescriptionId = useId();
  const draftInProgress = useBugReportStore((state) => state.draftInProgress);
  const { snapshot } = useHostMaintenance();
  const updateAvailable = snapshot?.updater.updateAvailable === true;
  const openAppDialog = useAppDialogStore((state) => state.open);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const remote = useRemoteWorkspaceStore((state) => state.active);
  const openRemote = useRemoteWorkspaceStore((state) => state.open);
  const hasLocalProject = useProjectStore((state) =>
    selectedProjectId ? state.projects.some((project) => project.id === selectedProjectId) : false,
  );
  const hasLocalEnvironment = useEnvironmentStore((state) =>
    selectedEnvironmentId
      ? state.environments.some((environment) => environment.id === selectedEnvironmentId)
      : false,
  );

  const hasProject = remote ? !!remote.projectId : hasLocalProject;
  const hasEnvironment = remote
    ? !!remote.projectId && !!remote.environmentId
    : hasLocalEnvironment;

  function openSettings(dialog: "repository-settings" | "environment-settings") {
    if (remote) {
      if (remote.projectId && (dialog === "repository-settings" || remote.environmentId)) {
        openRemote(remote.nodeId, {
          projectId: remote.projectId,
          ...(remote.environmentId ? { environmentId: remote.environmentId } : {}),
          dialog,
        });
      }
    } else if (dialog === "repository-settings" && hasLocalProject && selectedProjectId) {
      openAppDialog({ kind: dialog, projectId: selectedProjectId });
    } else if (dialog === "environment-settings" && hasLocalEnvironment && selectedEnvironmentId) {
      openAppDialog({ kind: dialog, environmentId: selectedEnvironmentId });
    }
  }

  return (
    <div
      data-sidebar-bottom-bar
      className="flex h-9 shrink-0 items-center justify-between border-t border-border/80 bg-chrome px-2"
    >
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="relative h-7 w-7"
          onClick={() => requestGlobalSettings("general")}
          title={updateAvailable ? `${SETTINGS_LABEL} · ${UPDATE_AVAILABLE}` : SETTINGS_LABEL}
          aria-label={SETTINGS_LABEL}
          aria-describedby={updateAvailable ? settingsDescriptionId : undefined}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          {updateAvailable ? (
            <>
              <IndicatorDot testId="settings-update-dot" />
              <span id={settingsDescriptionId} className="sr-only">
                {UPDATE_AVAILABLE}
              </span>
            </>
          ) : null}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => openSettings("repository-settings")}
          disabled={!hasProject}
          title={hasProject ? REPOSITORY_SETTINGS_LABEL : "Select a project first"}
          aria-label={REPOSITORY_SETTINGS_LABEL}
        >
          <FolderGit2 className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => openSettings("environment-settings")}
          disabled={!hasEnvironment}
          title={hasEnvironment ? ENVIRONMENT_SETTINGS_LABEL : "Select an environment first"}
          aria-label={ENVIRONMENT_SETTINGS_LABEL}
        >
          <Container className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="relative h-7 w-7"
        // The machine in front: another machine's report opens in its realm.
        onClick={() => openBugReport()}
        title={BUG_REPORT_LABEL}
        aria-label={BUG_REPORT_LABEL}
        aria-describedby={draftInProgress ? bugDescriptionId : undefined}
      >
        <Bug className="h-4 w-4" aria-hidden="true" />
        {draftInProgress ? (
          <>
            <IndicatorDot testId="bug-report-draft-dot" />
            <span id={bugDescriptionId} className="sr-only">
              {DRAFT_IN_PROGRESS}
            </span>
          </>
        ) : null}
      </Button>
    </div>
  );
}
