import * as backend from "@/lib/backend";
import { ScheduleManager } from "./ScheduleManager";
import { SettingsPageLayout } from "./SettingsPageLayout";

export { AccountSwitchPermissionBadge } from "./ScheduleManager";

/**
 * Settings → Schedules: every scheduled job on the window's own machine,
 * across projects (operator schedules need not belong to one). A project's
 * own schedules are also on its Scheduling tab.
 */
export function SchedulesSettings() {
  return (
    <ScheduleManager
      api={backend}
      emptyText="No schedules yet. Agents and coordinators can create them with create_schedule."
      frame={({ actions, children }) => (
        <SettingsPageLayout
          width="wide"
          title="Schedules"
          description="Actions the backend runs at a set time, once or repeatedly, as whoever created them: you, a Control MCP client, an agent or a coordinator. Missed fires run late only within their catch-up window."
          actions={actions}
        >
          {children}
        </SettingsPageLayout>
      )}
    />
  );
}
