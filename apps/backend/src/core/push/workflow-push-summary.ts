import {
  isGraphRunId,
  isGraphRunTerminal,
  type GraphRunStatus,
} from "@orkestrator/protocol/graphs/run";
import {
  isMultiReviewTerminalPhase,
  type MultiReviewPhase,
} from "@orkestrator/protocol/multi-review";
import { createHash } from "node:crypto";
import { parseAutoPipelinePushId, type WorkflowPushKey } from "@orkestrator/protocol/push-events";
import type { WorkflowPushSummary } from "./workflow-push-topic.js";

/** The storage reads the `workflow` topic's summaries come from. */
export interface WorkflowSummaryStorage {
  getBuildPipeline(id: string): Promise<{ revision: number; snapshot: unknown } | null>;
  getMultiReviewWorkflow(id: string): Promise<{ revision: number; snapshot?: unknown } | null>;
  graphRuns: {
    getGraphRun(id: string): Promise<{ revision: number; status: GraphRunStatus } | null>;
  };
}

/** A build pipeline ends in these phases; `paused` can resume. */
const TERMINAL_BUILD_PHASES: ReadonlySet<string> = new Set(["complete", "failed"]);
/** Longer is not a phase name; compared, never sent. */
const STATUS_MAX_LENGTH = 64;

function statusOf(snapshot: unknown, field: "phase"): string {
  const value = (snapshot as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === "string" ? value.slice(0, STATUS_MAX_LENGTH) : "unknown";
}

/**
 * The Auto-pipeline reads an `auto-pipeline` key compares: the toolbar's
 * offer for the environment and one tab's draft. Both read storage and
 * in-memory activity only, never a bridge (`AutoPipelineService`).
 */
export interface WorkflowSummaryAutoPipeline {
  sources(environmentId: string): Promise<{ available: boolean; sources: unknown[] }>;
  state(environmentId: string, tabId: string): { phase: string };
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function isRunNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "run-not-found";
}

/**
 * Reads one run's summary from its authoritative record: the record's
 * storage revision and its phase or status, and whether that phase ends the
 * run. `null` when the run does not exist.
 */
export function createWorkflowSummaryReader(
  storage: WorkflowSummaryStorage,
  /** Looked up per read; without it an `auto-pipeline` key is `missing`. */
  autoPipeline?: () => WorkflowSummaryAutoPipeline | null,
): (key: WorkflowPushKey) => Promise<WorkflowPushSummary | null> {
  return async ({ kind, id }) => {
    switch (kind) {
      case "auto-pipeline": {
        const target = parseAutoPipelinePushId(id);
        const service = autoPipeline?.() ?? null;
        if (!target || !service) return null;
        // No record revision: the digest of the view's own answer is compared.
        if (target.tabId === undefined) {
          const offer = await service.sources(target.environmentId);
          return {
            revision: 0,
            status: offer.available ? "available" : "unavailable",
            terminal: false,
            digest: digestOf(offer),
          };
        }
        const state = service.state(target.environmentId, target.tabId);
        return {
          revision: 0,
          status: state.phase.slice(0, STATUS_MAX_LENGTH),
          terminal: state.phase === "promoted",
          digest: digestOf(state),
        };
      }
      case "build-pipeline": {
        const record = await storage.getBuildPipeline(id);
        if (!record) return null;
        const status = statusOf(record.snapshot, "phase");
        return { revision: record.revision, status, terminal: TERMINAL_BUILD_PHASES.has(status) };
      }
      case "multi-review": {
        const record = await storage.getMultiReviewWorkflow(id);
        if (!record) return null;
        const status = statusOf(record.snapshot, "phase");
        return {
          revision: record.revision,
          status,
          terminal: isMultiReviewTerminalPhase(status as MultiReviewPhase),
        };
      }
      case "graph-run": {
        if (!isGraphRunId(id)) return null;
        try {
          const run = await storage.graphRuns.getGraphRun(id);
          if (!run) return null;
          return {
            revision: run.revision,
            status: run.status,
            terminal: isGraphRunTerminal(run.status),
          };
        } catch (error) {
          if (isRunNotFound(error)) return null;
          throw error;
        }
      }
    }
  };
}
