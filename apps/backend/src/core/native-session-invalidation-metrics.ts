import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  isNativeSessionInvalidationCause,
  type NativeSessionInvalidationCause,
  type NativeSessionInvalidationScope,
  type NativeSessionInvalidationSnapshot,
} from "@orkestrator/protocol/native-agent-observation";
import { recurringMetricsEnabled } from "./recurring-work-metrics.js";

const AGENT_PLATFORM_SET: ReadonlySet<string> = new Set(AGENT_PLATFORMS);

export interface NativeSessionInvalidationMetricsOptions {
  enabled?: boolean;
  /** Monotonic milliseconds; only differences are used. */
  now?: () => number;
}

/**
 * Counts every native session invalidation the backend emits, by cause and by
 * the platform it was scoped to (todo 0049 task 4): which code path keeps
 * waking an idle view.
 *
 * Both labels are fixed vocabularies. The agent is kept only when it is a
 * known platform; a session key, environment id or anything else never
 * becomes a label, and a value outside either vocabulary is counted in
 * `droppedLabels` without being retained. Memory is bounded by the vocabulary
 * size. Recording never throws into the announcing code path, and reading the
 * snapshot performs no I/O. Follows `ORKESTRATOR_RECURRING_METRICS` with the
 * rest of the recurring-work diagnostics.
 */
export class NativeSessionInvalidationMetrics {
  private readonly byCause = new Map<NativeSessionInvalidationCause, number>();
  private readonly byScope = new Map<
    NativeSessionInvalidationScope,
    Map<NativeSessionInvalidationCause, number>
  >();
  private readonly now: () => number;
  private enabledFlag: boolean;
  private createdAt: number;
  private total = 0;
  private droppedLabels = 0;

  constructor(options: NativeSessionInvalidationMetricsOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.enabledFlag = options.enabled ?? true;
    this.createdAt = this.safeNow();
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
  }

  /**
   * One emitted invalidation. `agent` is the platform the announcement named;
   * omitted for one that addressed every session of an environment.
   */
  record(cause: NativeSessionInvalidationCause, agent?: string): void {
    if (!this.enabledFlag) return;
    try {
      if (!isNativeSessionInvalidationCause(cause)) {
        this.droppedLabels += 1;
        return;
      }
      this.total += 1;
      this.byCause.set(cause, (this.byCause.get(cause) ?? 0) + 1);
      let scope: NativeSessionInvalidationScope;
      if (agent === undefined) scope = "environment";
      else if (AGENT_PLATFORM_SET.has(agent)) scope = agent as NativeSessionInvalidationScope;
      else {
        this.droppedLabels += 1;
        return;
      }
      let causes = this.byScope.get(scope);
      if (!causes) {
        causes = new Map();
        this.byScope.set(scope, causes);
      }
      causes.set(cause, (causes.get(cause) ?? 0) + 1);
    } catch {
      // Observation must never fail the announcement it observes.
    }
  }

  snapshot(): NativeSessionInvalidationSnapshot {
    const byScope: NativeSessionInvalidationSnapshot["byScope"] = {};
    for (const [scope, causes] of this.byScope) byScope[scope] = Object.fromEntries(causes);
    return {
      enabled: this.enabledFlag,
      windowMs: Math.max(0, Math.round(this.safeNow() - this.createdAt)),
      total: this.total,
      byCause: Object.fromEntries(this.byCause),
      byScope,
      droppedLabels: this.droppedLabels,
    };
  }

  reset(): void {
    this.byCause.clear();
    this.byScope.clear();
    this.total = 0;
    this.droppedLabels = 0;
    this.createdAt = this.safeNow();
  }

  private safeNow(): number {
    try {
      return this.now();
    } catch {
      return 0;
    }
  }
}

/** The process-wide counter; read through `get_recurring_work_diagnostics`. */
export const nativeSessionInvalidationMetrics = new NativeSessionInvalidationMetrics({
  enabled: recurringMetricsEnabled(),
});
