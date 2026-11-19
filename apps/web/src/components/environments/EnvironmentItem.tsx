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
import { isLocalDeletionRetryable } from "@/lib/federation/selected-environments";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import { mergePrControl } from "@/lib/merge-pr-control";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { resolveEnvironmentAgentActivity } from "@/lib/environment-agent-activity";
import { hydrationFreshnessNotice } from "@/lib/view-freshness";
import { useBuildPipelineStore, useEnvironmentDiffStore, useEnvironmentStore } from "@/stores";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useMergePrRequestStore } from "@/stores/mergePrRequestStore";
import type { Environment, EnvironmentType } from "@/types";
import { EnvironmentAgentSummary, LOCAL_AGENT_SUMMARY_SOURCE } from "./EnvironmentAgentSummary";
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
  // The row's environment is on the node of the scope it renders in.
  const scope = useScopesWithCommandFallback().scope;
  const nodeId = scope.nodeId;
  // The owning machine is named whenever this client can show several machines.
  const { boundMachine: windowMachine, supported: multiMachineClient } = useFederation();
  const boundMachine = multiMachineClient ? windowMachine : null;
  const { displayedActivityState, isRunning } = useEnvironmentDisplayActivity(environment);
  const deleting = useEnvironmentStore((s) => s.isDeleting(environment.id));
  const deletingStartedAt = useEnvironmentStore((s) => s.deletingStartedAt.get(environment.id));
  const deletionRetryable = useEnvironmentStore((s) =>
    isLocalDeletionRetryable(environment, s.deletingEnvironments),
  );
  // Its pull request is ready to merge or blocked by conflicts (pr-merge-readiness).
  const prMergeState = useEnvironmentPrMergeState(environment.id, environment);
  const buildPipeline = useBuildPipelineStore((s) => s.buildEnvironmentIds.has(environment.id));

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
    deletingStartedAt,
    deletionRetryable,
    activity: displayedActivityState,
    running: isRunning,
    buildPipeline,
    prMergeState,
    machine: boundMachine,
    dockerAvailable,
    localCheckoutAvailable,
  });

  // The same rule as the Merge PR dialog's merge option.
  const mergePr = mergePrControl(environment, { dockerAvailable });
  const localAddress = getEnvironmentPortAddress(environment);
  const initialPrompt = environment.initialPrompt?.trim();
  const tooltip = useHoverTooltip();

  return (
    <EnvironmentRow
      facts={facts}
      selected={isSelected}
      subtitle={subtitle}
      multiSelect={{
        id: environment.id,
        active: isMultiSelectMode,
        checked: isChecked,
        // Toggle individual item selection (Cmd/Ctrl+Click behavior).
        onToggle: () => onSelect(environment.id, { metaKey: true }),
      }}
      onActivate={(modifiers) => onSelect(environment.id, modifiers)}
      actions={{
        // Opens the environment and then the action bar's own merge dialog,
        // exactly as clicking its Merge PR button would.
        ...(mergePr
          ? {
              mergePr: {
                disabled: mergePr.disabled,
                run: () => {
                  onSelect(environment.id);
                  useMergePrRequestStore.getState().requestMergePr(nodeId, environment.id);
                },
              },
            }
          : {}),
        // The dialog lives in `AppDialogHost`, not in this row: in the mobile
        // projects drawer the row unmounts with the drawer, and a modal opened
        // from inside the drawer would be trapped behind it.
        openSettings: () =>
          useAppDialogStore
            .getState()
            .open({ kind: "environment-settings", nodeId, environmentId: environment.id }),
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
      attentionSource={LOCAL_AGENT_SUMMARY_SOURCE}
      onOpenAttention={(tabId, interactionId) => {
        onSelect(environment.id);
        // Focuses the tab once the environment's layout has it, as a worker link does.
        if (tabId) {
          openCoordinatorWorkTarget(
            {
              type: "worker-tab",
              projectId: environment.projectId,
              environmentId: environment.id,
              tabId,
              interactionId,
            },
            undefined,
            scope,
          );
        }
      }}
      deleteNotice={(open) => (
        <DesignEnvironmentDeletionNotice environmentId={environment.id} open={open} />
      )}
    />
  );
});
