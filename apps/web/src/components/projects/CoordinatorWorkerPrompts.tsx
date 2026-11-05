import { useMemo } from "react";
import { useStore } from "zustand";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";
import { HumanPromptBanner } from "@/components/chat/HumanPromptBanner";
import { useHumanPrompts } from "@/hooks/useUserCommands";
import { useRemoteHumanPrompts, type RemoteHumanPromptEntry } from "@/hooks/useRemoteHumanPrompts";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import { workerTabTarget } from "@/lib/coordinator-work-items";
import { portalStore } from "@/lib/portal/portal-store";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { CoordinatorWorkflowStoreBanner } from "./CoordinatorPanelNotices";

/**
 * The workflow-store notice and the workers' prompts banner.
 *
 * These read app-wide stores (environments and nodes), so they own those
 * subscriptions here, beside the conversations rather than above them: a write
 * anywhere then renders this component and not the conversation groups.
 */
export function CoordinatorWorkerPrompts({ snapshot }: { snapshot: CoordinatorSnapshot }) {
  const environments = useEnvironmentStore((state) => state.environments);
  /*
   * Commands waiting on the user in this coordinator's workers — a question,
   * an approval, a sign-in link, a code — so the person talking to the
   * coordinator sees them without opening the worker. Workers on other nodes
   * are read through each node's link, while a request to them is open
   * (`useRemoteHumanPrompts`).
   */
  const workerEnvironmentIds = useMemo(
    () =>
      Array.from(
        new Set(
          snapshot.workflows
            .filter(
              (association) =>
                association.kind === "environment" &&
                association.coordinatorId === snapshot.workspace.id &&
                !association.nodeId &&
                !association.pending,
            )
            .map((association) => association.resourceId),
        ),
      ),
    [snapshot],
  );
  const workPrompts = useHumanPrompts(workerEnvironmentIds);
  const remoteWorkers = useMemo(
    () =>
      snapshot.workflows.flatMap((association) =>
        association.kind === "environment" &&
        association.coordinatorId === snapshot.workspace.id &&
        association.nodeId &&
        !association.pending &&
        association.delegation?.state === "running"
          ? [{ nodeId: association.nodeId, environmentId: association.resourceId }]
          : [],
      ),
    [snapshot],
  );
  const remotePrompts = useRemoteHumanPrompts(remoteWorkers);
  const workerPrompts = useMemo<Array<HumanPromptEntry | RemoteHumanPromptEntry>>(
    () => [...workPrompts, ...remotePrompts],
    [workPrompts, remotePrompts],
  );
  const nodes = useStore(portalStore.store, (state) => state.nodes);

  const promptLabel = (entry: HumanPromptEntry | RemoteHumanPromptEntry) => {
    if (!("nodeId" in entry)) {
      return (
        environments.find((item) => item.id === entry.environmentId)?.name ?? entry.environmentId
      );
    }
    const node = nodes.find((item) => item.nodeId === entry.nodeId);
    const name =
      node?.environments.find((item) => item.ref.environmentId === entry.environmentId)?.name ??
      entry.environmentId;
    return `${name} on ${node?.view.displayName ?? entry.nodeId}`;
  };
  const promptTarget = (entry: HumanPromptEntry | RemoteHumanPromptEntry) =>
    workerTabTarget(
      {
        environmentId: entry.environmentId,
        tabId: entry.tabId,
        ...("nodeId" in entry ? { nodeId: entry.nodeId } : {}),
        title: promptLabel(entry),
      },
      { environments, nodes },
    );

  return (
    <>
      <CoordinatorWorkflowStoreBanner state={snapshot.workflowStore} />
      <HumanPromptBanner
        prompts={workerPrompts}
        label={promptLabel}
        canOpen={(entry) => promptTarget(entry) !== null}
        onOpen={(entry) => {
          const target = promptTarget(entry);
          if (target) openCoordinatorWorkTarget(target);
        }}
      />
    </>
  );
}
