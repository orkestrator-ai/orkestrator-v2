import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { isActiveBuildPhase, isBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import {
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import {
  coordinatorWorkAssociations,
  countCoordinatorWork,
  deriveCoordinatorWorkItems,
  remoteWorkKey,
  type CoordinatorWorkCounts,
  type CoordinatorWorkItem,
  type WorkEnvironment,
  type WorkPrReading,
  type WorkTicket,
} from "@/lib/coordinator-work-items";
import { hydrateMultiReviewWorkflow } from "@/lib/multi-review-persistence";
import { portalStore } from "@/lib/portal/portal-store";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useGraphRunStore } from "@/stores/graphRunStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";

/** How often expiry is re-evaluated: finished work drops off without any event. */
export const WORK_PANEL_CLOCK_MS = 60_000;

const EMPTY_TICKETS: ReadonlyMap<string, WorkTicket> = new Map();

interface RemoteRecords {
  pipelines: Map<string, BuildPipeline>;
  reviews: Map<string, MultiReviewWorkflow>;
}

function remoteSnapshot(value: unknown): unknown {
  return value && typeof value === "object" && "snapshot" in value
    ? (value as { snapshot: unknown }).snapshot
    : undefined;
}

/**
 * The Work panel's rows for one coordinator, from backend state only.
 *
 * Every source is a store the app already keeps current from backend
 * snapshots and resource events (environments, build pipelines, Multi
 * Reviews, the PR monitor, node summaries), so a row moves while the
 * coordinator is idle and while this panel was unmounted. Graph runs are the
 * one source loaded on demand: this hook reads the coordinator's own runs and
 * re-reads one when the backend announces it changed. Builds and Multi
 * Reviews on another node are read through that node's link with the same
 * reads the backend's coordinator uses, again on safety checks and whenever
 * the node's summaries refresh.
 */
export function useCoordinatorWorkItems(
  snapshot: CoordinatorSnapshot | null,
  promptEnvironmentIds: ReadonlySet<string>,
): { items: CoordinatorWorkItem[]; counts: CoordinatorWorkCounts; openDelegations: number } {
  const environmentList = useEnvironmentStore((state) => state.environments);
  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const reviews = useMultiReviewStore((state) => state.workflows);
  const runEntries = useGraphRunStore((state) => state.runs);
  const loadRun = useGraphRunStore((state) => state.loadRun);
  const monitor = usePrMonitorStore((state) => state.states);
  const nodes = useStore(portalStore.store, (state) => state.nodes);
  const projectId = snapshot?.workspace.projectId;
  const kanbanTasks = useKanbanStore((state) =>
    projectId && state.currentProjectId === projectId ? state.tasks : null,
  );
  const [now, setNow] = useState(() => Date.now());
  const [remote, setRemote] = useState<RemoteRecords>(() => ({
    pipelines: new Map(),
    reviews: new Map(),
  }));

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), WORK_PANEL_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const associations = useMemo(
    () => (snapshot ? coordinatorWorkAssociations(snapshot.workflows, snapshot.workspace.id) : []),
    [snapshot],
  );

  // Graph runs on this machine: read on mount, on a change announcement for
  // one of them, and on resync and safety checks (missed events).
  const localRunIds = useMemo(
    () =>
      Array.from(
        new Set(
          associations
            .filter((association) => association.kind === "graph-run" && !association.nodeId)
            .map((association) => association.resourceId),
        ),
      )
        .sort()
        .join("\u0000"),
    [associations],
  );
  useEffect(() => {
    if (!localRunIds) return;
    const ids = localRunIds.split("\u0000");
    const wanted = new Set(ids);
    const loadAll = () => {
      for (const id of ids) void loadRun(id);
    };
    loadAll();
    const offChange = onResourceChanged("graph-run", (change) => {
      if (wanted.has(change.id)) void loadRun(change.id);
    });
    const offResync = onResourceResync(loadAll);
    const offSafety = onViewSafetyCheck(loadAll);
    return () => {
      offChange();
      offResync();
      offSafety();
    };
  }, [localRunIds, loadRun]);

  // Local builds and reviews are hydrated app-wide; one the stores do not
  // hold yet (started a moment ago, or in a project not hydrated) is read once.
  // Only a change of the coordinator's work asks again: a store update for an
  // unrelated record must not repeat a read that came back empty.
  useEffect(() => {
    const heldPipelines = useBuildPipelineStore.getState().pipelines;
    const heldReviews = useMultiReviewStore.getState().workflows;
    for (const association of associations) {
      if (association.nodeId) continue;
      if (association.kind === "build-pipeline" && !heldPipelines.has(association.resourceId)) {
        void hydrateBuildPipeline(association.resourceId).catch(() => undefined);
      } else if (association.kind === "multi-review" && !heldReviews.has(association.resourceId)) {
        void hydrateMultiReviewWorkflow(association.resourceId).catch(() => undefined);
      }
    }
  }, [associations]);

  // Builds name their ticket; the criteria count reads its checks. The store
  // holds one project's tickets, the same project the board shows.
  const needsTickets = associations.some(
    (association) => association.kind === "build-pipeline" && !association.nodeId,
  );
  useEffect(() => {
    if (!projectId || !needsTickets) return;
    if (useKanbanStore.getState().currentProjectId !== projectId) {
      void useKanbanStore.getState().loadTasks(projectId);
    }
  }, [needsTickets, projectId]);

  // Builds and Multi Reviews on other nodes.
  const remoteRefs = useMemo(
    () =>
      associations.flatMap((association) =>
        association.nodeId &&
        (association.kind === "build-pipeline" || association.kind === "multi-review")
          ? [{ kind: association.kind, nodeId: association.nodeId, id: association.resourceId }]
          : [],
      ),
    [associations],
  );
  const remoteNodesStamp = useMemo(() => {
    const involved = new Set(remoteRefs.map((ref) => ref.nodeId));
    return nodes
      .filter((node) => involved.has(node.nodeId))
      .map((node) => `${node.nodeId}:${node.loadedAt ?? ""}:${node.available}`)
      .join("|");
  }, [nodes, remoteRefs]);
  const [remoteTick, setRemoteTick] = useState(0);
  // Read only to skip settled records, so holding them does not trigger reads.
  const remoteRef = useRef(remote);
  useEffect(() => {
    remoteRef.current = remote;
  }, [remote]);
  useEffect(() => {
    if (remoteRefs.length === 0) return;
    const bump = () => setRemoteTick((tick) => tick + 1);
    const offSafety = onViewSafetyCheck(bump);
    const offResync = onResourceResync(bump);
    return () => {
      offSafety();
      offResync();
    };
  }, [remoteRefs.length]);
  useEffect(() => {
    if (remoteRefs.length === 0) return;
    let disposed = false;
    const settled = (key: string, kind: "build-pipeline" | "multi-review") => {
      const remote = remoteRef.current;
      if (kind === "build-pipeline") {
        const held = remote.pipelines.get(key);
        return held !== undefined && !isActiveBuildPhase(held.phase) && held.phase !== "paused";
      }
      const held = remote.reviews.get(key);
      return held !== undefined && isMultiReviewTerminalPhase(held.phase);
    };
    void Promise.all(
      remoteRefs.map(async (ref) => {
        const key = remoteWorkKey(ref.nodeId, ref.id);
        // A finished record does not change again; its PR state comes from summaries.
        if (settled(key, ref.kind)) return null;
        try {
          const value = await portalStore.invokeOnNode<unknown>(
            ref.nodeId as BackendId,
            ref.kind === "build-pipeline" ? "get_build_pipeline" : "get_multi_review_workflow",
            ref.kind === "build-pipeline" ? { pipelineId: ref.id } : { workflowId: ref.id },
          );
          return { key, kind: ref.kind, snapshot: remoteSnapshot(value) };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (disposed) return;
      setRemote((current) => {
        let pipelinesNext: Map<string, BuildPipeline> | null = null;
        let reviewsNext: Map<string, MultiReviewWorkflow> | null = null;
        for (const result of results) {
          if (!result) continue;
          if (result.kind === "build-pipeline" && isBuildPipeline(result.snapshot)) {
            pipelinesNext ??= new Map(current.pipelines);
            pipelinesNext.set(result.key, result.snapshot);
          } else if (result.kind === "multi-review" && isMultiReviewWorkflow(result.snapshot)) {
            reviewsNext ??= new Map(current.reviews);
            reviewsNext.set(result.key, result.snapshot);
          }
        }
        return pipelinesNext || reviewsNext
          ? {
              pipelines: pipelinesNext ?? current.pipelines,
              reviews: reviewsNext ?? current.reviews,
            }
          : current;
      });
    });
    return () => {
      disposed = true;
    };
  }, [remoteRefs, remoteNodesStamp, remoteTick]);

  const environments = useMemo(
    () => new Map<string, WorkEnvironment>(environmentList.map((item) => [item.id, item])),
    [environmentList],
  );
  const graphRuns = useMemo(() => {
    const runs = new Map<string, GraphRun>();
    for (const [id, entry] of runEntries) if (entry.run) runs.set(id, entry.run);
    return runs;
  }, [runEntries]);
  const prReadings = monitor as ReadonlyMap<string, WorkPrReading>;
  const tickets = useMemo(
    () =>
      kanbanTasks
        ? new Map<string, WorkTicket>(kanbanTasks.map((task) => [task.id, task]))
        : EMPTY_TICKETS,
    [kanbanTasks],
  );

  return useMemo(() => {
    if (!snapshot) {
      return {
        items: [],
        counts: { running: 0, needsYou: 0, finished: 0 },
        openDelegations: 0,
      };
    }
    const items = deriveCoordinatorWorkItems({
      coordinatorId: snapshot.workspace.id,
      workflows: snapshot.workflows,
      environments,
      pipelines,
      reviews,
      graphRuns,
      prReadings,
      tickets,
      nodes,
      remotePipelines: remote.pipelines,
      remoteReviews: remote.reviews,
      promptEnvironmentIds,
      now,
    });
    return {
      items,
      counts: countCoordinatorWork(items),
      // Every open delegation, including ones on rows already past expiry.
      openDelegations: associations.filter(
        (association) =>
          association.kind === "environment" && association.delegation?.state === "running",
      ).length,
    };
  }, [
    snapshot,
    associations,
    environments,
    pipelines,
    reviews,
    graphRuns,
    prReadings,
    tickets,
    nodes,
    remote,
    promptEnvironmentIds,
    now,
  ]);
}
