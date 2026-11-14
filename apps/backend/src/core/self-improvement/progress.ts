/**
 * What a run reports about itself while it works, so the Settings page can show
 * that it is moving rather than only that it is "running". The service owns one
 * {@link RunProgress} per run; `status()` reads a copy of it.
 *
 * Numbers and timestamps only: nothing here names a conversation, a note or a
 * ticket (the log-content rules in `docs/architecture/self-improvement.md`).
 */
import {
  SELF_IMPROVEMENT_STEPS,
  type SelfImprovementProgress,
  type SelfImprovementSkipReason,
  type SelfImprovementStage,
  type SelfImprovementStep,
} from "@orkestrator/protocol/self-improvement";
import type { ModelRunner } from "./insights/model.js";

/** What the conversation review tells the run as it goes. */
export interface InsightProgress {
  /** A history file was checked for new parts. `total` is known once they are listed. */
  fileChecked(checked: number, total: number): void;
  /** The files have all been checked: this many parts will be read, this many are left for later. */
  scanned(parts: number, waiting: number): void;
  partRead(notesAdded: number): void;
  partFailed(): void;
}

export interface RunPlan {
  /** The conversation review is on, so reading and grouping can happen. */
  conversations: boolean;
  /** A preview reads and reports but files nothing. */
  dryRun: boolean;
  /** How long one model call may run before it is given up. */
  modelTimeoutMs: number;
}

export class RunProgress implements InsightProgress {
  private readonly stages: SelfImprovementStage[];
  private lastActivityAt: string;
  private review: NonNullable<SelfImprovementProgress["conversations"]> | null = null;
  private readonly calls = new Map<number, string>();
  private nextCall = 0;

  constructor(
    private readonly plan: RunPlan,
    private readonly now: () => Date,
  ) {
    // Decided from the plan, so a setting changed while the run works cannot
    // change why one of its stages was skipped.
    const skippedBecause = (step: SelfImprovementStep): SelfImprovementSkipReason | null => {
      if (!plan.conversations && (step === "reading-conversations" || step === "grouping-themes")) {
        return "review-off";
      }
      if (plan.dryRun && step === "filing") return "preview";
      return null;
    };
    this.stages = SELF_IMPROVEMENT_STEPS.map((step) => {
      const skipReason = skippedBecause(step);
      return skipReason ? { step, state: "skipped", skipReason } : { step, state: "pending" };
    });
    this.lastActivityAt = this.stamp();
    this.begin("exporting");
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private touch(): void {
    this.lastActivityAt = this.stamp();
  }

  /**
   * The run moved on to `step`: whatever was running is done, and a stage the
   * run passed without doing (grouping, when no saved notes needed it) is
   * skipped.
   */
  begin(step: SelfImprovementStep): void {
    const at = this.stamp();
    const index = SELF_IMPROVEMENT_STEPS.indexOf(step);
    this.stages.forEach((stage, position) => {
      if (position < index) {
        if (stage.state === "running") {
          stage.state = "done";
          stage.finishedAt = at;
        } else if (stage.state === "pending") {
          stage.state = "skipped";
          stage.skipReason = stage.step === "grouping-themes" ? "no-notes" : "not-needed";
        }
      } else if (position === index && stage.state === "pending") {
        stage.state = "running";
        stage.startedAt = at;
      }
    });
    if (step === "reading-conversations" && !this.review) {
      this.review = {
        filesChecked: 0,
        files: null,
        parts: null,
        read: 0,
        failed: 0,
        notesAdded: 0,
        waiting: 0,
      };
    }
    this.touch();
  }

  fileChecked(checked: number, total: number): void {
    if (this.review) Object.assign(this.review, { filesChecked: checked, files: total });
    this.touch();
  }

  scanned(parts: number, waiting: number): void {
    if (this.review) Object.assign(this.review, { parts, waiting });
    this.touch();
  }

  partRead(notesAdded: number): void {
    if (this.review) {
      this.review.read += 1;
      this.review.notesAdded += notesAdded;
    }
    this.touch();
  }

  partFailed(): void {
    if (this.review) this.review.failed += 1;
    this.touch();
  }

  /** The runner, counting its calls so a long one reads as working rather than stuck. */
  track(runner: ModelRunner): ModelRunner {
    return async <T>(call: Parameters<ModelRunner>[0]) => {
      const id = this.nextCall++;
      this.calls.set(id, this.stamp());
      this.touch();
      try {
        return await runner<T>(call);
      } finally {
        this.calls.delete(id);
        this.touch();
      }
    };
  }

  snapshot(): SelfImprovementProgress {
    const started = [...this.calls.values()].sort()[0] ?? null;
    return {
      stages: this.stages.map((stage) => ({ ...stage })),
      observedAt: this.stamp(),
      lastActivityAt: this.lastActivityAt,
      ...(this.review ? { conversations: { ...this.review } } : {}),
      modelCalls: {
        inFlight: this.calls.size,
        oldestStartedAt: started,
        timeoutMs: this.plan.modelTimeoutMs,
      },
    };
  }
}
