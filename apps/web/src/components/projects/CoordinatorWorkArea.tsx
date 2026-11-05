import { useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";
import { HumanPromptBanner } from "@/components/chat/HumanPromptBanner";
import { useHumanPrompts } from "@/hooks/useUserCommands";
import { useRemoteHumanPrompts, type RemoteHumanPromptEntry } from "@/hooks/useRemoteHumanPrompts";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import {
  remoteWorkKey,
  workerTabTarget,
  type CoordinatorWorkStop,
} from "@/lib/coordinator-work-items";
import { portalStore } from "@/lib/portal/portal-store";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { CoordinatorNextWakeLine, CoordinatorWorkPanel } from "./CoordinatorWorkPanel";
import { CoordinatorWorkflowStoreBanner } from "./CoordinatorPanelNotices";
import { useCoordinatorWorkItems } from "./useCoordinatorWorkItems";

interface CoordinatorWorkAreaProps {
  snapshot: CoordinatorSnapshot;
  /** Quiets the next-wake line: coordination is paused or a turn is running. */
  quiet: boolean;
  onStop?: (stop: CoordinatorWorkStop) => Promise<void>;
  onClearFinished: (associationIds: string[]) => Promise<void>;
  /** The conversation groups, shown beside the Work panel. */
  children: ReactNode;
}

/**
 * The workers' prompts banner, the Work panel and the next-wake line.
 *
 * These read app-wide stores (environments, build pipelines, Multi Reviews,
 * nodes and the rest `useCoordinatorWorkItems` follows), so they own those
 * subscriptions here rather than in the panel: a write anywhere then renders
 * this component, and the conversations passed in as `children` keep their
 * element and are not rendered again.
 */
export function CoordinatorWorkArea({
  snapshot,
  quiet,
  onStop,
  onClearFinished,
  children,
}: CoordinatorWorkAreaProps) {
  const environments = useEnvironmentStore((state) => state.environments);
  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const multiReviews = useMultiReviewStore((state) => state.workflows);
  /*
   * Commands waiting on the user in this coordinator's work — a question, an
   * approval, a sign-in link, a code — in its workers and in the environments
   * its builds and reviews run in. Read once: the Work panel marks those rows
   * as needing the user, and the banner shows the workers' own prompts so the
   * person talking to the coordinator sees them without opening the worker.
   * Workers on other nodes are read through each node's link, while a request
   * to them is open (`useRemoteHumanPrompts`).
   */
  const workerEnvironmentIds = useMemo(
    () =>
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
    [snapshot],
  );
  const workEnvironmentIds = useMemo(() => {
    const ids = new Set(workerEnvironmentIds);
    for (const association of snapshot.workflows) {
      if (association.coordinatorId !== snapshot.workspace.id || association.nodeId) continue;
      const environmentId =
        association.kind === "build-pipeline"
          ? pipelines.get(association.resourceId)?.environmentId
          : association.kind === "multi-review"
            ? multiReviews.get(association.resourceId)?.environmentId
            : undefined;
      if (environmentId) ids.add(environmentId);
    }
    return Array.from(ids);
  }, [snapshot, workerEnvironmentIds, pipelines, multiReviews]);
  const workPrompts = useHumanPrompts(workEnvironmentIds);
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
    () => [
      ...workPrompts.filter((entry) => workerEnvironmentIds.has(entry.environmentId)),
      ...remotePrompts,
    ],
    [workPrompts, workerEnvironmentIds, remotePrompts],
  );
  const promptEnvironmentIds = useMemo(
    () =>
      new Set([
        ...workPrompts.map((entry) => entry.environmentId),
        ...remotePrompts.map((entry) => remoteWorkKey(entry.nodeId, entry.environmentId)),
      ]),
    [workPrompts, remotePrompts],
  );
  const nodes = useStore(portalStore.store, (state) => state.nodes);
  // Everything this coordinator started, from every conversation and node.
  const work = useCoordinatorWorkItems(snapshot, promptEnvironmentIds);

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

      <div className="relative flex min-h-0 flex-1">
        {children}
        <CoordinatorWorkPanel
          items={work.items}
          counts={work.counts}
          openDelegations={work.openDelegations}
          onOpen={(target) => openCoordinatorWorkTarget(target)}
          {...(onStop ? { onStop } : {})}
          onClearFinished={onClearFinished}
        />
      </div>
      <CoordinatorNextWakeLine items={work.items} quiet={quiet} />
    </>
  );
}
