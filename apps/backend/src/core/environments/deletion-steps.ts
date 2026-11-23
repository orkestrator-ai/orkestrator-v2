import { createLogger } from "@orkestrator/protocol/logger";
import {
  environmentDeletionStepLabel,
  type EnvironmentDeletionStep,
} from "@orkestrator/protocol/node-summaries";

const log = createLogger("environment");

/**
 * How long each step whose work runs in child processes may take before the
 * delete stops it. Only these steps can be stopped: their commands and the
 * confined-removal helper take the step's signal and are killed when it fires.
 *
 * Generous on purpose. Six fixture worktrees of 75,608 files each took 17.2 s
 * to remove together on a loaded Mac, and a deadline that fires on a genuinely
 * large tree on a slow disk only makes the user retry the same work.
 */
export const ENVIRONMENT_DELETION_STEP_DEADLINES_MS: Readonly<
  Partial<Record<EnvironmentDeletionStep, number>>
> = {
  container: 10 * 60_000,
  worktree: 20 * 60_000,
};

/** A step overran its deadline and was stopped. The message is fixed text. */
export class EnvironmentDeletionDeadlineError extends Error {
  override name = "EnvironmentDeletionDeadlineError";
  readonly step: EnvironmentDeletionStep;

  constructor(step: EnvironmentDeletionStep, deadlineMs: number) {
    const minutes = Math.max(1, Math.round(deadlineMs / 60_000));
    super(
      `Deletion stopped while ${environmentDeletionStepLabel(step)}: it took longer than ${minutes} min. Retry to continue.`,
    );
    this.step = step;
  }
}

export type EnvironmentDeletionSteps = {
  /** Records that the delete has reached `step`. Best-effort. */
  enter(step: EnvironmentDeletionStep): Promise<void>;
  /**
   * Records `step`, then runs `work` with a signal that fires at the step's
   * deadline. Settles only once `work` has. Child commands must opt into
   * termination confirmation so the delete guard outlives cancellation. This
   * confirms local processes, not work already accepted by the Docker daemon. If the signal
   * fired, the delete fails with `EnvironmentDeletionDeadlineError` whatever
   * `work` returned, because a step cut short has not done its job.
   */
  run<T>(step: EnvironmentDeletionStep, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
};

export function environmentDeletionSteps(options: {
  environmentId: string;
  /** Persists the step on the environment record. Failures are ignored. */
  record: (step: EnvironmentDeletionStep) => Promise<void>;
  /** Tests shorten these; production uses `ENVIRONMENT_DELETION_STEP_DEADLINES_MS`. */
  deadlinesMs?: Partial<Record<EnvironmentDeletionStep, number>>;
}): EnvironmentDeletionSteps {
  const deadlines = { ...ENVIRONMENT_DELETION_STEP_DEADLINES_MS, ...options.deadlinesMs };
  const enter = async (step: EnvironmentDeletionStep) => {
    await options.record(step).catch(() => undefined);
  };
  return {
    enter,
    async run(step, work) {
      await enter(step);
      const controller = new AbortController();
      const deadlineMs = deadlines[step];
      const timer =
        deadlineMs === undefined
          ? undefined
          : setTimeout(() => {
              log.warn("delete.step-deadline", {
                environmentId: options.environmentId,
                step,
                deadlineMs,
              });
              controller.abort();
            }, deadlineMs);
      try {
        const result = await work(controller.signal);
        if (controller.signal.aborted)
          throw new EnvironmentDeletionDeadlineError(step, deadlineMs!);
        return result;
      } catch (error) {
        if (controller.signal.aborted && !(error instanceof EnvironmentDeletionDeadlineError)) {
          throw new EnvironmentDeletionDeadlineError(step, deadlineMs!);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
