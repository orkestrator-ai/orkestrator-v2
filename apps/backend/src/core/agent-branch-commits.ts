/**
 * The serialized write queue of the agent branch runner.
 *
 * Every write a runner makes goes through one queue, so branches advancing
 * concurrently never race one revision-checked save against another. Safety
 * transitions (session identity, the dispatch journal, an accepted result, a
 * terminal state) are written at once and awaited; observations (progress
 * digests and clocks, token usage, the stall warning) are staged and written
 * once at the end of the pass, riding on any safety write before then.
 */
import {
  agentBranchErrorMessage,
  type AgentBranchHost,
  type AgentBranchRecord,
  AGENT_BRANCH_LOG_PREFIX,
} from "./agent-branch-types.js";
import type { EfficiencyEvent } from "./multi-review-efficiency.js";

export type AgentBranchRecordEvent = (event: Omit<EfficiencyEvent, "owner">) => void;

/**
 * Errors that must not be absorbed into one branch's `error` field.
 *
 * A lost controller lease means this process no longer owns the workflow, so
 * writing to it at all would race the owner that does. Hosts name their own
 * fence error by class name because the runner cannot import theirs.
 */
export function isAgentBranchFenceError(error: unknown): boolean {
  return error instanceof Error && error.name.endsWith("FenceError");
}

export class AgentBranchCommitQueue {
  /** Tail of the serialized commit queue; never rejects. */
  private commitTail: Promise<void> = Promise.resolve();
  /** An observation changed the in-memory record since the last write. */
  private observationStaged = false;

  constructor(
    private readonly save: () => Promise<void>,
    private readonly record: AgentBranchRecordEvent,
    /** The host's log prefix (`[review-fanout]`, `[graph-agent]`). */
    private readonly logPrefix = AGENT_BRANCH_LOG_PREFIX,
  ) {}

  /**
   * Immediate, durable write of a safety transition: session identity, the
   * dispatch journal, an accepted result, or a terminal branch state.
   *
   * Serialized with every other write this queue makes, so concurrent
   * branches cannot lose one another's updates. The caller awaits its own
   * commit before its next fallible operation — that is what keeps
   * `dispatching` durable before `send`.
   *
   * `transition`, when given, is applied to the in-memory record only once
   * this write's turn in the queue comes, and reverted if the write fails.
   * Every save serializes the whole owner record, so a change made before then
   * would ride on a peer's earlier write; for `dispatching` that made a request
   * durable whose own commit, and so whose send, might never happen.
   */
  commit(transition?: { apply(): void; revert(): void }): Promise<void> {
    const run = this.commitTail.then(async () => {
      const staged = this.observationStaged;
      // Whatever was staged rides on this write.
      this.observationStaged = false;
      const started = Date.now();
      transition?.apply();
      try {
        await this.save();
      } catch (error) {
        // Reverted before the queue moves on, so no later write carries it.
        transition?.revert();
        this.observationStaged ||= staged;
        throw error;
      }
      this.record({ operation: "workflow.save_safety", elapsedMs: Date.now() - started });
    });
    this.commitTail = run.catch(() => undefined);
    return run;
  }

  /**
   * Marks an observational change for the single checkpoint at the end of the
   * pass. The change is already on the in-memory record, so any safety commit
   * before then carries it too.
   */
  stageObservation(): void {
    this.observationStaged = true;
    this.record({ operation: "workflow.observation_staged" });
  }

  /**
   * Writes staged observations once. A failure other than a lost fence is
   * logged, not thrown: an observation is recoverable from the provider on the
   * next pass, and must never turn an already-settled result into a retry.
   */
  async flushObservations(): Promise<void> {
    const run = this.commitTail.then(async () => {
      if (!this.observationStaged) return;
      this.observationStaged = false;
      const started = Date.now();
      try {
        await this.save();
      } catch (error) {
        this.observationStaged = true;
        throw error;
      }
      this.record({ operation: "workflow.save_observation", elapsedMs: Date.now() - started });
    });
    this.commitTail = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      if (isAgentBranchFenceError(error)) throw error;
      console.warn(
        `${this.logPrefix} Checkpointing reviewer observations failed:`,
        agentBranchErrorMessage(error),
      );
    }
  }
}

/** What the runner's collaborators share for one pass. */
export interface AgentBranchContext<B extends AgentBranchRecord> {
  readonly host: AgentBranchHost<B>;
  readonly commits: AgentBranchCommitQueue;
  readonly record: AgentBranchRecordEvent;
}
