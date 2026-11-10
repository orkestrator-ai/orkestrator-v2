import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  NATIVE_AGENT_DISCOVERY_SECTIONS,
  type NativeAgentDiscoverySection,
} from "@orkestrator/protocol/native-agent";
import {
  isNativeSessionInvalidationCause,
  type NativeSessionInvalidationCause,
  type NativeSessionInvalidationScope,
  type NativeSessionInvalidationSnapshot,
} from "@orkestrator/protocol/native-agent-observation";
import { recurringMetricsEnabled } from "./recurring-work-metrics.js";

const AGENT_PLATFORM_SET: ReadonlySet<string> = new Set(AGENT_PLATFORMS);
const DISCOVERY_SECTION_SET: ReadonlySet<string> = new Set(NATIVE_AGENT_DISCOVERY_SECTIONS);
/** Distinct changed paths kept per scope and section; later ones count as `other`. */
export const DISCOVERY_RENEWAL_PATH_LIMIT = 64;
const DISCOVERY_RENEWAL_PATH = /^[A-Za-z0-9_.[\]-]{1,160}$/;

interface DiscoveryRenewalCounter {
  count: number;
  changed: Map<string, number>;
}

export interface NativeSessionInvalidationMetricsOptions {
  enabled?: boolean;
  /** Monotonic milliseconds; only differences are used. */
  now?: () => number;
}

/**
 * Counts every native session invalidation the backend emits, by cause and by
 * the platform it was scoped to (todo 0049 task 4): which code path keeps
 * waking an idle view. Discovery announcements are also counted by section
 * and changed value path (#2062), which names the field that keeps
 * moving.
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
  /** #2062: which section a discovery announcement was about. */
  private readonly discoveryRenewals = new Map<
    NativeSessionInvalidationScope,
    Map<NativeAgentDiscoverySection, DiscoveryRenewalCounter>
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

  /**
   * Which discovery section an announced renewal (or deadline) was about, and
   * the content-free paths of its value that changed
   * (`discoveryChangedPaths`). Counted beside the cause, which `record` has
   * already counted when the announcement went out. A section or agent
   * outside the vocabulary, or a path that is not a structural name, is
   * dropped and counted in `droppedLabels`.
   */
  recordDiscoveryRenewal(
    section: NativeAgentDiscoverySection,
    agent: string | undefined,
    changedPaths: readonly string[],
  ): void {
    if (!this.enabledFlag) return;
    try {
      if (!DISCOVERY_SECTION_SET.has(section)) {
        this.droppedLabels += 1;
        return;
      }
      let scope: NativeSessionInvalidationScope;
      if (agent === undefined) scope = "environment";
      else if (AGENT_PLATFORM_SET.has(agent)) scope = agent as NativeSessionInvalidationScope;
      else {
        this.droppedLabels += 1;
        return;
      }
      let sections = this.discoveryRenewals.get(scope);
      if (!sections) {
        sections = new Map();
        this.discoveryRenewals.set(scope, sections);
      }
      let counter = sections.get(section);
      if (!counter) {
        counter = { count: 0, changed: new Map() };
        sections.set(section, counter);
      }
      counter.count += 1;
      for (const candidate of changedPaths.slice(0, 16)) {
        if (typeof candidate !== "string" || !DISCOVERY_RENEWAL_PATH.test(candidate)) {
          this.droppedLabels += 1;
          continue;
        }
        const path =
          counter.changed.has(candidate) || counter.changed.size < DISCOVERY_RENEWAL_PATH_LIMIT
            ? candidate
            : "other";
        counter.changed.set(path, (counter.changed.get(path) ?? 0) + 1);
      }
    } catch {
      // Observation must never fail the announcement it observes.
    }
  }

  snapshot(): NativeSessionInvalidationSnapshot {
    const byScope: NativeSessionInvalidationSnapshot["byScope"] = {};
    for (const [scope, causes] of this.byScope) byScope[scope] = Object.fromEntries(causes);
    const discoveryRenewals: NonNullable<NativeSessionInvalidationSnapshot["discoveryRenewals"]> =
      {};
    for (const [scope, sections] of this.discoveryRenewals) {
      discoveryRenewals[scope] = Object.fromEntries(
        Array.from(sections, ([section, counter]) => [
          section,
          { count: counter.count, changed: Object.fromEntries(counter.changed) },
        ]),
      );
    }
    return {
      enabled: this.enabledFlag,
      windowMs: Math.max(0, Math.round(this.safeNow() - this.createdAt)),
      total: this.total,
      byCause: Object.fromEntries(this.byCause),
      byScope,
      droppedLabels: this.droppedLabels,
      discoveryRenewals,
    };
  }

  reset(): void {
    this.byCause.clear();
    this.byScope.clear();
    this.discoveryRenewals.clear();
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
