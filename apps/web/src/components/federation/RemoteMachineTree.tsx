import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { EnvironmentRow } from "@/components/environments/EnvironmentRow";
import {
  nodeEnvironmentRowFacts,
  nodeEnvironmentTooltipDetails,
} from "@/components/environments/environment-row-facts";
import { EnvironmentAgentSummary } from "@/components/environments/EnvironmentAgentSummary";
import { useShimmerRequiresChecks } from "@/hooks/useEnvironmentNameSignal";
import { useHoverTooltip } from "@/components/ui/hover-tooltip";
import { incompatibilityNotice, updatableMachine } from "@/lib/federation/fleet-currency";
import { shellOpenExternal } from "@/lib/native/shell";
import type { MachineView } from "@/lib/federation/aggregate";
import { useNodeEnvironmentChangeProjection } from "@/lib/federation/node-change-projections";
import {
  nodeAgentSummarySource,
  useNodeEnvironment,
} from "@/lib/federation/node-environment-reads";
import { useStore } from "zustand";
import { remoteOrdersFor } from "@/lib/federation/remote-order-writes";
import { moveId, withOrder } from "@/lib/federation/remote-order";
import type { FederatedEnvironment, FederatedProject } from "@/lib/federation/summaries";
import { OutcomeUnknownError } from "@/lib/portal/portal-store";
import { applySidebarModifierSelection } from "@/lib/sidebar-selection";
import { useUIStore } from "@/stores/uiStore";
import { useRemoteEnvironmentShown } from "@/stores/remoteWorkspaceStore";
import { SortableEnvironmentRowFrame } from "@/components/sidebar/EnvironmentRowFrame";
import {
  ProjectHomeActivityButton,
  projectHomeStatus,
} from "@/components/sidebar/ProjectHomeActivity";
import { useFederation } from "./FederationProvider";
import { useFederatedEnvironmentActions } from "./useFederatedEnvironmentActions";

const NO_ENVIRONMENTS: readonly FederatedEnvironment[] = [];

/**
 * Opens a public web page on this client. No node is involved, so this skips
 * the backend's `open_in_browser`, which the window's workspace (possibly a
 * leaf) would run.
 */
export function openWebPage(url: string): void {
  const openExternal = shellOpenExternal();
  if (openExternal) {
    void openExternal(url).catch(() => toast.error("Could not open repository in browser."));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function reportWriteError(machine: MachineView, what: string, error: unknown): void {
  // A typed incompatibility error leads to the machine's update (plan item 5006).
  const notice = incompatibilityNotice(error, updatableMachine(machine));
  if (error instanceof OutcomeUnknownError) {
    toast.warning(`${what}: outcome unknown on ${machine.name}`, {
      description: error.message,
    });
  } else if (notice) {
    toast.error(`Could not ${what.toLowerCase()} on ${machine.name}`, {
      description: notice.text,
      ...(notice.update ? { action: notice.update } : {}),
    });
  } else {
    toast.error(`Could not ${what.toLowerCase()} on ${machine.name}`, {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Another machine's environment order, with the drags this client sent and
 * the owner has not reflected yet. A drag is written to the owner.
 */
export function useRemoteEnvironments() {
  const { portal } = useFederation();
  const orderWrites = useMemo(() => remoteOrdersFor(portal), [portal]);
  const orders = useStore(orderWrites.store);

  const environmentsOf = useCallback(
    (machine: MachineView, project: FederatedProject) =>
      withOrder(
        (machine.environmentsByProject.get(project.ref.projectId) ?? NO_ENVIRONMENTS)
          .filter((environment) => !environment.isProjectHome)
          .sort((left, right) => left.order - right.order),
        orders.get(project.key),
        (environment) => environment.ref.environmentId,
      ),
    [orders],
  );

  /** Persists dragging environment `activeKey` onto `overKey`; false when neither is in `project`. */
  const reorder = useCallback(
    (machine: MachineView, project: FederatedProject, activeKey: string, overKey: string) => {
      const visible = environmentsOf(machine, project);
      const keys = moveId(
        visible.map((environment) => environment.key),
        activeKey,
        overKey,
      );
      if (!keys) return false;
      const idByKey = new Map(visible.map((environment) => [environment.key, environment]));
      const ids = keys.map((key) => idByKey.get(key)!.ref.environmentId);
      // Reorder only visible slots; home rows keep their owner position and are
      // included in the whole-project payload so the owner never appends them.
      let nextVisible = 0;
      const allIds = [
        ...(machine.environmentsByProject.get(project.ref.projectId) ?? NO_ENVIRONMENTS),
      ]
        .sort((left, right) => left.order - right.order)
        .map((environment) =>
          environment.isProjectHome ? environment.ref.environmentId : ids[nextVisible++]!,
        );
      orderWrites.submit(project.ref, allIds, (error: unknown) =>
        reportWriteError(machine, "Reorder environments", error),
      );
      return true;
    },
    [environmentsOf, orderWrites],
  );

  return { environmentsOf, reorder };
}

/** Whether a drag id is one of `projects`' environments, and in which project. */
export function remoteEnvironmentProject(
  machine: MachineView,
  projects: readonly FederatedProject[],
  environmentKey: string,
): FederatedProject | null {
  for (const project of projects) {
    const environments = machine.environmentsByProject.get(project.ref.projectId) ?? [];
    if (environments.some((environment) => environment.key === environmentKey)) return project;
  }
  return null;
}

/**
 * An environment of another machine in a project, in the frame this window's
 * rows use. Its drag id is its node-qualified key.
 */
export function RemoteSortableEnvironmentItem({
  machine,
  environment,
  sortable,
}: {
  machine: MachineView;
  environment: FederatedEnvironment;
  sortable: boolean;
}) {
  const shown = useRemoteEnvironmentShown(machine.connectionId, environment.ref.environmentId);
  const multiSelecting = useUIStore((state) => state.selectedEnvironmentIds.length > 0);
  return (
    <SortableEnvironmentRowFrame
      sortableId={environment.key}
      // Read-only while the owner is unavailable.
      sortable={sortable}
      selected={shown && !multiSelecting}
      offline={machine.transport !== "connected"}
      name={environment.name}
      data={{
        "data-testid": "federated-environment-row",
        "data-machine": machine.connectionId,
        "data-selected": shown || undefined,
      }}
    >
      <RemoteEnvironmentItem machine={machine} environment={environment} />
    </SortableEnvironmentRowFrame>
  );
}

/**
 * The row content of another machine's environment: the same `EnvironmentRow`
 * this window's rows draw, fed from the machine's node summary. Selecting it
 * moves the window to the owner's workspace.
 */
export function RemoteEnvironmentItem({
  machine,
  environment,
  subtitle,
}: {
  machine: MachineView;
  environment: FederatedEnvironment;
  subtitle?: string;
}) {
  const actions = useFederatedEnvironmentActions(machine, environment);
  const shown = useRemoteEnvironmentShown(machine.connectionId, environment.ref.environmentId);
  // The same `environment-net` projection the machine's own rows show, read
  // through the command node and kept current by the machine's relayed events.
  const changeProjection = useNodeEnvironmentChangeProjection(environment.ref);
  // The hover card reads the full record and agent summary from the machine
  // while it or the delete dialog is open; until then it shows the summary.
  const tooltip = useHoverTooltip();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const details = useNodeEnvironment(environment.ref, tooltip.open || deleteOpen);
  const live = machine.transport === "connected";
  const requireChecks = useShimmerRequiresChecks();
  const facts = nodeEnvironmentRowFacts(machine, environment, actions, requireChecks);
  const selectionId = environment.key;
  const multiSelecting = useUIStore((state) => state.selectedEnvironmentIds.length > 0);
  const checked = useUIStore((state) => state.selectedEnvironmentIds.includes(selectionId));
  const clearMultiSelection = useUIStore((state) => state.clearMultiSelection);

  return (
    <EnvironmentRow
      facts={facts}
      selected={shown}
      subtitle={subtitle}
      multiSelect={{
        id: selectionId,
        active: multiSelecting,
        checked,
        onToggle: () => applySidebarModifierSelection(selectionId, { metaKey: true }),
      }}
      onActivate={(modifiers, openUnreadResult) => {
        if (applySidebarModifierSelection(selectionId, modifiers)) return;
        // As on this window's rows, a plain click ends a multi-selection and opens the row.
        clearMultiSelection();
        if (openUnreadResult) actions.openUnreadResult();
        else actions.open();
      }}
      actions={{
        open: actions.open,
        copyLink: actions.copyLink,
        openSettings: actions.openSettings,
        fork: actions.fork,
        start: actions.start,
        stop: actions.stop,
        restart: actions.restart,
        confirmDelete: actions.remove,
      }}
      changes={changeProjection ? { kind: "projection", projection: changeProjection } : null}
      tooltip={tooltip}
      tooltipDetails={details ?? nodeEnvironmentTooltipDetails(environment)}
      onDeleteOpenChange={setDeleteOpen}
      agentSummary={
        live ? (
          <EnvironmentAgentSummary
            environmentId={environment.ref.environmentId}
            open={tooltip.open}
            source={nodeAgentSummarySource(environment.ref.backendId)}
          />
        ) : null
      }
      attentionSource={nodeAgentSummarySource(environment.ref.backendId)}
      onOpenAttention={(tabId, interactionId) => {
        clearMultiSelection();
        if (tabId) actions.openTab(tabId, interactionId);
        else actions.open();
      }}
    />
  );
}

/** Shared by remote project headers and the activity list. */
export function RemoteProjectHomeActivity({
  machine,
  environment,
  projectName,
  compact,
}: {
  machine: MachineView;
  environment: FederatedEnvironment;
  projectName: string;
  compact?: boolean;
}) {
  if (machine.transport !== "connected") return null;
  const status = projectHomeStatus({
    deleting: environment.deleting,
    buildActive: environment.buildActive === true,
    activity: environment.activity,
    hasUnreadWork: environment.hasUnreadWork,
    hasWaitingNativeTab: environment.status === "running" && environment.hasWaitingNativeTab,
  });
  if (!status) return null;
  const {
    projectId,
    ref: { environmentId, backendId },
  } = environment;
  return (
    <ProjectHomeActivityButton
      status={status}
      projectName={projectName}
      environmentId={environmentId}
      source={nodeAgentSummarySource(backendId)}
      lastActivityAt={environment.lastActivityAt}
      compact={compact}
      onOpen={(tabId, interactionId) =>
        openMachineWorkspace({
          connectionId: machine.connectionId,
          projectId,
          environmentId,
          boardTab: "home",
          title: projectName,
          ...(tabId
            ? { workTarget: { type: "worker-tab", projectId, environmentId, tabId, interactionId } }
            : {}),
        })
      }
    />
  );
}
