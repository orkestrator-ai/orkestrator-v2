import { useId } from "react";
import { Bug, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHostMaintenance } from "@/components/settings/useHostMaintenance";
import { openBugReport } from "@/lib/bug-report/open-bug-report";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useBugReportStore } from "@/stores/bugReportStore";

const SETTINGS_LABEL = "Global settings";
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
 * The static bar under the projects and environments list: global settings on
 * the left, the bug report on the right.
 *
 * Both open surfaces that live outside the sidebar (`GlobalSettingsHost` and
 * the bug report sheet, which `AppShell` hosts), because in the mobile drawer
 * the sidebar unmounts when the drawer closes for them. Settings go through
 * `requestGlobalSettings`, so every opener shares one path.
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

  return (
    <div
      data-sidebar-bottom-bar
      className="flex h-9 shrink-0 items-center justify-between border-t border-border/80 bg-chrome px-2"
    >
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
