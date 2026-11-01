import { memo } from "react";
import { toast } from "sonner";
import { DesignEnvironmentDeletionNotice } from "@/components/design/DesignEnvironmentDeletionNotice";
import { useHoverTooltip } from "@/components/ui/hover-tooltip";
import { useFederation } from "@/components/federation/FederationProvider";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import { useEnvironmentChangeProjection } from "@/hooks/useChangeProjection";
import { useEnvironmentDisplayActivity } from "@/hooks/useEnvironmentDisplayActivity";
import { useEnvironmentPrMergeState } from "@/hooks/useEnvironmentNameSignal";
import { useLocalEnvironmentAvailable } from "@/hooks/useLocalEnvironmentAvailable";
import { getEnvironmentPortAddress } from "@/lib/environment-address";
import { resolveEnvironmentAgentActivity } from "@/lib/environment-agent-activity";
import { hydrationFreshnessNotice } from "@/lib/view-freshness";
import { useBuildPipelineStore, useEnvironmentDiffStore, useEnvironmentStore } from "@/stores";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useConfigStore } from "@/stores/configStore";
import type { Environment, EnvironmentType } from "@/types";
import { EnvironmentAgentSummary } from "./EnvironmentAgentSummary";
import { EnvironmentRow, type EnvironmentRowChanges } from "./EnvironmentRow";
import { localEnvironmentRowFacts } from "./environment-row-facts";

export { resolveEnvironmentAgentActivity };
export {
  EnvironmentChangeBadge,
  EnvironmentChangeSummary,
  EnvironmentMenuItems,
  type EnvironmentMenuItem,
} from "./EnvironmentRow";

interface EnvironmentItemProps {
  environment: Environment;
  isSelected: boolean;
  onSelect: (environmentId: string, modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => void;
  onDelete: (environmentId: string) => void;
  onStart: (environmentId: string) => void;
  onStop: (environmentId: string) => void;
  onRestart: (environmentId: string) => void;
  onFork?: (environmentId: string, environmentType: EnvironmentType) => void;
  isMultiSelectMode?: boolean;
  isChecked?: boolean;
  /** Optional secondary label used by the flat activity view. */
  subtitle?: string;
}

/** Unread agent mail for one environment, as this machine's mailboxes count it. */
function useEnvironmentMail(environmentId: string): { unread: number; failed: boolean } {
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );
  const unread = useAgentMailStore((state) => {
    if (!messagingEnabled) return 0;
    let count = 0;
    for (const mailbox of state.summary.values()) {
      if (mailbox.environmentId === environmentId)
        count += mailbox.userUnseenCount ?? mailbox.unreadCount;
    }
    return count;
  });
  const failed = useAgentMailStore(
    (state) =>
      messagingEnabled &&
      Array.from(state.summary.values()).some(
        (mailbox) => mailbox.environmentId === environmentId && mailbox.failedInjectCount > 0,
      ),
  );
  return { unread, failed };
}

function copyToClipboard(text: string, success: () => void, failure: string) {
  navigator.clipboard
    .writeText(text)
    .then(success)
    .catch(() => {
      toast.error(failure);
    });
}

/**
 * A row of this window's own machine: the facts come from its full stores,
 * the drawing from `EnvironmentRow`, which other machines' rows share.
 */
export const EnvironmentItem = memo(function EnvironmentItem({
  environment,
  isSelected,
  onSelect,
  onDelete,
  onStart,
  onStop,
  onRestart,
  onFork,
  isMultiSelectMode = false,
  isChecked = false,
  subtitle,
}: EnvironmentItemProps) {
  const dockerAvailable = useDockerAvailability();
  const localCheckoutAvailable = useLocalEnvironmentAvailable(environment.projectId);
  // The owning machine is named whenever this client can show several machines.
  const { boundMachine: windowMachine, supported: multiMachineClient } = useFederation();
  const boundMachine = multiMachineClient ? windowMachine : null;
  const { displayedActivityState, isRunning } = useEnvironmentDisplayActivity(environment);
  const deleting = useEnvironmentStore((s) => s.isDeleting(environment.id));
  // Its pull request is ready to merge or blocked by conflicts (pr-merge-readiness).
  const prMergeState = useEnvironmentPrMergeState(environment.id, environment);
  const buildPipeline = useBuildPipelineStore((s) => s.buildEnvironmentIds.has(environment.id));
  const mail = useEnvironmentMail(environment.id);

  // The badge is the backend's `environment-net` projection — the same
  // measurement the Files → Changes rows page through. An older backend
  // answers no projection; only then does the legacy diff-stat mirror drive it.
  const changeProjection = useEnvironmentChangeProjection(environment.id);
  const diffStats = useEnvironmentDiffStore((s) =>
    changeProjection ? undefined : s.stats.get(environment.id),
  );
  const diffSyncStatus = useEnvironmentDiffStore((s) =>
    changeProjection ? "current" : s.syncStatus,
  );
  const changes: EnvironmentRowChanges | null = changeProjection
    ? { kind: "projection", projection: changeProjection }
    : diffStats
      ? {
          kind: "legacy",
          stats: diffStats,
          freshness: hydrationFreshnessNotice(diffSyncStatus, "change counts"),
        }
      : null;

  const facts = localEnvironmentRowFacts(environment, {
    deleting,
    activity: displayedActivityState,
    running: isRunning,
    buildPipeline,
    unreadMail: mail.unread,
    failedMail: mail.failed,
    prMergeState,
    machine: boundMachine,
    dockerAvailable,
    localCheckoutAvailable,
  });

  const localAddress = getEnvironmentPortAddress(environment);
  const initialPrompt = environment.initialPrompt?.trim();
  const tooltip = useHoverTooltip();

  return (
    <EnvironmentRow
      facts={facts}
      selected={isSelected}
      subtitle={subtitle}
      multiSelect={{
        active: isMultiSelectMode,
        checked: isChecked,
        // Toggle individual item selection (Cmd/Ctrl+Click behavior).
        onToggle: () => onSelect(environment.id, { metaKey: true }),
      }}
      onActivate={(modifiers) => onSelect(environment.id, modifiers)}
      actions={{
        // The dialog lives in `AppDialogHost`, not in this row: in the mobile
        // projects drawer the row unmounts with the drawer, and a modal opened
        // from inside the drawer would be trapped behind it.
        openSettings: () =>
          useAppDialogStore
            .getState()
            .open({ kind: "environment-settings", environmentId: environment.id }),
        ...(localAddress
          ? {
              copyAddress: () =>
                copyToClipboard(
                  localAddress,
                  () => toast.success("Copied address", { description: localAddress }),
                  "Failed to copy address",
                ),
            }
          : {}),
        ...(initialPrompt
          ? {
              copyInitialPrompt: () =>
                copyToClipboard(
                  initialPrompt,
                  () => toast.success("Initial prompt copied to clipboard"),
                  "Failed to copy initial prompt",
                ),
            }
          : {}),
        fork: (environmentType) => onFork?.(environment.id, environmentType),
        start: () => onStart(environment.id),
        stop: () => onStop(environment.id),
        restart: () => onRestart(environment.id),
        confirmDelete: () => onDelete(environment.id),
      }}
      changes={changes}
      tooltip={tooltip}
      tooltipDetails={environment}
      agentSummary={<EnvironmentAgentSummary environmentId={environment.id} open={tooltip.open} />}
      deleteNotice={(open) => (
        <DesignEnvironmentDeletionNotice environmentId={environment.id} open={open} />
      )}
    />
  );
});
