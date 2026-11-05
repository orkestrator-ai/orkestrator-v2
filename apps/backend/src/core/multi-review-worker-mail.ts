/**
 * A Multi Review's side of agent mail to its reviewers.
 *
 * Each reviewer is a worker with its own mailbox, addressed as a build pipeline
 * worker is (`pipelineWorkerTabId`), so the mail store, the directory and the
 * coordinator tools treat them alike. As on a pipeline, queued mail becomes the
 * reviewer's next turn before its result is accepted (`beforeResult` on the
 * fan-out host) and `deliverNow` steers into the running turn under the workflow
 * lock. Mail is never moved to a later attempt of the same reviewer: a restart
 * rotates the session key, and with it the address.
 */
import {
  multiReviewWorkers,
  pipelineWorkerEnded,
  pipelineWorkerSessionKey,
  type PipelineWorkerStatus,
} from "@orkestrator/protocol/pipeline-worker-mail";
import type {
  MultiReviewModelSelection,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import { PromptRejectedError, type BuildPipelineProvider } from "./build-pipeline-provider.js";
import type { PipelineWorkerMailPort } from "./build-pipeline-worker-mail.js";
import type { MailSteerDispatchOutcome } from "./native-agent-service-shared.js";
import type { StorageService } from "./storage.js";

export interface MultiReviewWorkerMailDeps {
  storage: Pick<StorageService, "listMultiReviewWorkflows">;
  withLock<T>(workflowId: string, run: () => Promise<T>): Promise<T>;
  provider(
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
  ): Promise<BuildPipelineProvider>;
}

export class MultiReviewWorkerMail implements PipelineWorkerMailPort {
  constructor(private readonly deps: MultiReviewWorkerMailDeps) {}

  /** The reviewer a worker address names, in whichever review of the environment owns it. */
  async locate(
    environmentId: string,
    tabId: string,
  ): Promise<{ workflow: MultiReviewWorkflow; reviewer: ReviewerRecord } | null> {
    const sessionKey = pipelineWorkerSessionKey(tabId);
    if (!sessionKey) return null;
    for (const record of await this.deps.storage.listMultiReviewWorkflows(environmentId)) {
      const workflow = record.snapshot as MultiReviewWorkflow;
      const reviewer = workflow.reviewers?.find((entry) => entry.sessionKey === sessionKey);
      if (reviewer) return { workflow, reviewer };
    }
    return null;
  }

  private status(workflow: MultiReviewWorkflow, tabId: string): PipelineWorkerStatus | null {
    return multiReviewWorkers(workflow).find((worker) => worker.address === tabId)?.status ?? null;
  }

  async state(environmentId: string, tabId: string): Promise<PipelineWorkerStatus | null> {
    const located = await this.locate(environmentId, tabId);
    return located ? this.status(located.workflow, tabId) : null;
  }

  async steer(input: {
    environmentId: string;
    tabId: string;
    text: string;
    requestId: string;
  }): Promise<MailSteerDispatchOutcome> {
    const owner = await this.locate(input.environmentId, input.tabId);
    if (!owner) return { outcome: "refused", reason: "steer-refused" };
    return this.deps.withLock(owner.workflow.id, async () => {
      const located = await this.locate(input.environmentId, input.tabId);
      const status = located ? this.status(located.workflow, input.tabId) : null;
      const sessionId = located?.reviewer.providerSessionId;
      if (!located || !sessionId || status === null || pipelineWorkerEnded(status)) {
        return { outcome: "refused", reason: "steer-refused" } as const;
      }
      if (status !== "running") return { outcome: "idle" } as const;
      // A prompt whose dispatch is unconfirmed has not started its turn yet;
      // steering now would reach the turn before it.
      if (located.reviewer.dispatchState !== "sent") {
        return { outcome: "refused", reason: "steer-refused" } as const;
      }
      const provider = await this.deps.provider(located.workflow, located.reviewer);
      if (!provider.steerSupported || !provider.activeSteerRun || !provider.performSessionAction)
        return { outcome: "refused", reason: "steer-unsupported" } as const;
      if (!(await provider.steerSupported(sessionId).catch(() => false)))
        return { outcome: "refused", reason: "steer-unsupported" } as const;
      const active = await provider.activeSteerRun(sessionId).catch(() => undefined);
      if (active?.state !== "running") return { outcome: "idle" } as const;
      let outcome;
      try {
        outcome = await provider.performSessionAction(sessionId, {
          kind: "steer",
          text: input.text,
          requestId: input.requestId,
          expectedRunId: active.runId,
        });
      } catch (error) {
        if (error instanceof PromptRejectedError)
          return { outcome: "refused", reason: "steer-refused" } as const;
        return { outcome: "unknown" } as const;
      }
      switch (outcome.outcome) {
        case "applied":
          return { outcome: "applied" } as const;
        case "rejected":
          return { outcome: "refused", reason: "steer-refused" } as const;
        case "unknown":
          return { outcome: "unknown" } as const;
        default:
          return { outcome: "idle" } as const;
      }
    });
  }

  /**
   * A claimed delivery from before a restart. The turn's request id is saved
   * before the claim settles, so the reviewer holding it proves the delivery; a
   * later turn has replaced it only after the claim settled.
   */
  async reconcileDelivery(
    environmentId: string,
    tabId: string,
    requestId: string,
  ): Promise<"dispatched" | "not-dispatched" | "unknown"> {
    const located = await this.locate(environmentId, tabId).catch(() => null);
    if (!located) return "unknown";
    return located.reviewer.requestId === requestId ? "dispatched" : "not-dispatched";
  }

  async reconcileSteer(
    environmentId: string,
    tabId: string,
    requestId: string,
  ): Promise<"dispatched" | "not-dispatched" | "unknown"> {
    const located = await this.locate(environmentId, tabId).catch(() => null);
    const sessionId = located?.reviewer.providerSessionId;
    if (!located || !sessionId) return "unknown";
    try {
      const provider = await this.deps.provider(located.workflow, located.reviewer);
      if (!provider.steerStatus) return "unknown";
      const status = await provider.steerStatus(sessionId, requestId);
      return status === "dispatched"
        ? "dispatched"
        : status === "absent"
          ? "not-dispatched"
          : "unknown";
    } catch {
      return "unknown";
    }
  }
}
