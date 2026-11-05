import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { isBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  canonicalBuildPipeline,
  canonicalMultiReview,
} from "@orkestrator/protocol/workflow-vocabulary";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import {
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
import { isGraphRunNotFound, useGraphRunStore } from "@/stores/graphRunStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";

/** How often expiry is re-evaluated: finished work drops off without any event. */
export const WORK_PANEL_CLOCK_MS = 60_000;

const EMPTY_TICKETS: ReadonlyMap<string, WorkTicket> = new Map();

interface RemoteRecords {
  pipelines: Map<string, BuildPipeline>;
  reviews: Map<string, MultiReviewWorkflow>;
  graphRuns: Map<string, GraphRun>;
  /** `graph-run:<remoteWorkKey>` for runs the node said do not exist. */
  missing: Set<string>;
}

type RemoteKind = "build-pipeline" | "multi-review" | "graph-run";

/** The node read for each remote kind: the same reads its own views use. */
const REMOTE_READS: Record<RemoteKind, { command: string; args: (id: string) => object }> = {
  "build-pipeline": { command: "get_build_pipeline", args: (pipelineId) => ({ pipelineId }) },
  "multi-review": { command: "get_multi_review_workflow", args: (workflowId) => ({ workflowId }) },
  "graph-run": { command: "graph_run_get", args: (runId) => ({ runId }) },
};

function remoteSnapshot(value: unknown): unknown {
  return value && typeof value === "object" && "snapshot" in value
    ? (value as { snapshot: unknown }).snapshot
    : undefined;
}

/** A `graph_run_get` answer's run, when it is this run's snapshot. */
function remoteGraphRun(value: unknown, runId: string): GraphRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as { status?: unknown; run?: unknown };
  if (result.status !== "changed" || !result.run || typeof result.run !== "object")
    return undefined;
  const run = result.run as Partial<GraphRun>;
  return run.id === runId && typeof run.status === "string" ? (run as GraphRun) : undefined;
}

/**
 * The Work panel's rows for one coordinator, from backend state only.
 *
 * Every source is a store the app already keeps current from backend
 * snapshots and resource events (environments, build pipelines, Multi
 * Reviews, the PR monitor, node summaries), so a row moves while the
 * coordinator is idle and while this panel was unmounted. Graph runs are the
 * one source loaded on demand: this hook reads the coordinator's own runs and
 * re-reads one when the backend announces it changed. Builds, Multi Reviews
 * and graph runs on another node are read through that node's link with the
 * same reads their own views use (`graph_run_get` is classified as a routed
 * read), again on resync, safety checks and whenever the node's summaries
 * refresh.
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
    graphRuns: new Map(),
    missing: new Set(),
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

  const [missingLocal, setMissingLocal] = useState<ReadonlySet<string>>(() => new Set());

  // Local builds and reviews are hydrated app-wide; one the stores do not
  // hold yet is read on mount and retried on reconciliation signals. A failed
  // read stays loading; a successful empty read proves the record is missing.
  useEffect(() => {
    let disposed = false;
    const inFlight = new Set<string>();
    const refresh = () => {
      for (const association of associations) {
        if (association.nodeId) continue;
        const kind = association.kind;
        if (kind !== "build-pipeline" && kind !== "multi-review") continue;
        const key = `${kind}:${association.resourceId}`;
        const held =
          kind === "build-pipeline"
            ? useBuildPipelineStore.getState().pipelines.has(association.resourceId)
            : useMultiReviewStore.getState().workflows.has(association.resourceId);
        if (held || inFlight.has(key)) continue;
        inFlight.add(key);
        const load = kind === "build-pipeline" ? hydrateBuildPipeline : hydrateMultiReviewWorkflow;
        void load(association.resourceId)
          .then((record) => {
            if (disposed) return;
            setMissingLocal((current) => {
              const next = new Set(current);
              if (record) next.delete(key);
              else next.add(key);
              return next;
            });
          })
          .catch(() => undefined)
          .finally(() => inFlight.delete(key));
      }
    };
    refresh();
    const offResync = onResourceResync(refresh);
    const offSafety = onViewSafetyCheck(refresh);
    const offChange = onResourceChanged("build-pipeline", refresh);
    const offReview = onResourceChanged("multi-review", refresh);
    const offPipelines = useBuildPipelineStore.subscribe((state, previous) => {
      if (Array.from(previous.pipelines.keys()).some((id) => !state.pipelines.has(id))) refresh();
    });
    const offReviews = useMultiReviewStore.subscribe((state, previous) => {
      if (Array.from(previous.workflows.keys()).some((id) => !state.workflows.has(id))) refresh();
    });
    return () => {
      disposed = true;
      offResync();
      offSafety();
      offChange();
      offReview();
      offPipelines();
      offReviews();
    };
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

  // Builds, Multi Reviews and graph runs on other nodes.
  const remoteRefs = useMemo(
    () =>
      associations.flatMap((association) =>
        !association.nodeRelease &&
        association.nodeId &&
        (association.kind === "build-pipeline" ||
          association.kind === "multi-review" ||
          association.kind === "graph-run")
          ? [
              {
                kind: association.kind as RemoteKind,
                nodeId: association.nodeId,
                id: association.resourceId,
              },
            ]
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
    void Promise.all(
      remoteRefs.map(async (ref) => {
        const key = remoteWorkKey(ref.nodeId, ref.id);
        const read = REMOTE_READS[ref.kind];
        try {
          const value = await portalStore.invokeOnNode<unknown>(
            ref.nodeId as BackendId,
            read.command,
            read.args(ref.id) as Record<string, unknown>,
          );
          return {
            key,
            kind: ref.kind,
            missing: ref.kind !== "graph-run" && value === null,
            snapshot:
              ref.kind === "graph-run"
                ? remoteGraphRun(value, ref.id)
                : ref.kind === "build-pipeline"
                  ? canonicalBuildPipeline(remoteSnapshot(value))
                  : canonicalMultiReview(remoteSnapshot(value)),
          };
        } catch (error) {
          // A run the node says does not exist is finished; any other error
          // keeps the last reading.
          return ref.kind === "graph-run" && isGraphRunNotFound(error)
            ? { key, kind: ref.kind, missing: true, snapshot: undefined }
            : null;
        }
      }),
    ).then((results) => {
      if (disposed) return;
      setRemote((current) => {
        let pipelinesNext: Map<string, BuildPipeline> | null = null;
        let reviewsNext: Map<string, MultiReviewWorkflow> | null = null;
        let runsNext: Map<string, GraphRun> | null = null;
        let missingNext: Set<string> | null = null;
        for (const result of results) {
          if (!result) continue;
          const missingKey = `${result.kind}:${result.key}`;
          if (result.missing) {
            missingNext ??= new Set(current.missing);
            missingNext.add(missingKey);
            if (result.kind === "build-pipeline") {
              pipelinesNext ??= new Map(current.pipelines);
              pipelinesNext.delete(result.key);
            }
            if (result.kind === "multi-review") {
              reviewsNext ??= new Map(current.reviews);
              reviewsNext.delete(result.key);
            }
          } else if (isBuildPipeline(result.snapshot) || isMultiReviewWorkflow(result.snapshot)) {
            missingNext ??= new Set(current.missing);
            missingNext.delete(missingKey);
          }
          if (result.kind === "build-pipeline" && isBuildPipeline(result.snapshot)) {
            pipelinesNext ??= new Map(current.pipelines);
            pipelinesNext.set(result.key, result.snapshot);
          } else if (result.kind === "multi-review" && isMultiReviewWorkflow(result.snapshot)) {
            reviewsNext ??= new Map(current.reviews);
            reviewsNext.set(result.key, result.snapshot);
          } else if (result.kind === "graph-run") {
            const missingKey = `graph-run:${result.key}`;
            if (result.missing) {
              if (current.missing.has(missingKey) && !current.graphRuns.has(result.key)) continue;
              runsNext ??= new Map(current.graphRuns);
              runsNext.delete(result.key);
              missingNext ??= new Set(current.missing);
              missingNext.add(missingKey);
            } else if (result.snapshot) {
              runsNext ??= new Map(current.graphRuns);
              runsNext.set(result.key, result.snapshot as GraphRun);
              if (current.missing.has(missingKey)) {
                missingNext ??= new Set(current.missing);
                missingNext.delete(missingKey);
              }
            }
          }
        }
        return pipelinesNext || reviewsNext || runsNext || missingNext
          ? {
              pipelines: pipelinesNext ?? current.pipelines,
              reviews: reviewsNext ?? current.reviews,
              graphRuns: runsNext ?? current.graphRuns,
              missing: missingNext ?? current.missing,
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
      remoteGraphRuns: remote.graphRuns,
      promptEnvironmentIds,
      now,
      missingResources: new Set([
        ...missingLocal,
        ...remote.missing,
        ...Array.from(runEntries)
          .filter(([, entry]) => entry.status === "missing")
          .map(([id]) => `graph-run:${id}`),
      ]),
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
    missingLocal,
    runEntries,
  ]);
}
