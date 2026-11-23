import {
  CAPABILITY_LIMITS,
  MY_SETUP_ID,
  isTerminalCapabilityOperationState,
} from "@orkestrator/protocol/capability-resources";

import {
  CAPABILITY_COLLECTIONS,
  CAPABILITY_STATE_FORMAT_VERSION,
  type CapabilityExecutorState,
  type CapabilityState,
} from "../capabilities/types.js";
import type { StorageContext } from "./context.js";
import { isRecord, nowIso } from "./shared.js";

/** The built-in My setup every enrolled machine follows. */
export function defaultMySetup(): CapabilityState["setups"][string] {
  return {
    id: MY_SETUP_ID,
    name: "My setup",
    description: "Everything you use on every enrolled machine.",
    builtIn: true,
    revision: 1,
    packageSelections: [],
    providerSelectors: [],
    machineSelectors: [],
    exclusions: [],
    parentSetupIds: [],
    updatePolicy: "approve",
    updatedAt: nowIso(),
  };
}

export function emptyCapabilityState(): CapabilityState {
  return {
    formatVersion: CAPABILITY_STATE_FORMAT_VERSION,
    revision: 0,
    epoch: 1,
    settings: {
      trustedSources: [],
      forbiddenSources: [],
      forbiddenComponents: [],
      enrollNewMachines: true,
    },
    packages: {},
    components: {},
    setups: { [MY_SETUP_ID]: defaultMySetup() },
    assignments: {},
    operations: {},
    receipts: {},
    observations: {},
    updates: {},
    drift: {},
    activity: {},
    artifacts: {},
    machines: {},
    inspections: {},
    approvals: {},
    requests: {},
    imports: {},
    launches: {},
  };
}

/** Fills missing collections of a stored value (an older or partial row set). */
function normalizeState(value: unknown): CapabilityState {
  const base = emptyCapabilityState();
  if (!isRecord(value)) return base;
  const state = { ...base, ...(value as Partial<CapabilityState>) } as CapabilityState;
  for (const collection of CAPABILITY_COLLECTIONS) {
    if (!isRecord(state[collection]))
      (state as unknown as Record<string, unknown>)[collection] = {};
  }
  if (!isRecord(state.settings)) state.settings = base.settings;
  state.settings = { ...base.settings, ...state.settings };
  if (!state.setups[MY_SETUP_ID]) state.setups[MY_SETUP_ID] = defaultMySetup();
  if (typeof state.revision !== "number") state.revision = 0;
  if (typeof state.epoch !== "number" || state.epoch < 1) state.epoch = 1;
  return state;
}

/** Keeps the newest `max` entries of a collection by `at(entry)`. */
function keepNewest<T>(
  records: Record<string, T>,
  max: number,
  at: (entry: T) => string,
  keep: (entry: T) => boolean = () => false,
): void {
  const entries = Object.entries(records);
  if (entries.length <= max) return;
  const removable = entries
    .filter(([, entry]) => !keep(entry))
    .sort(([, a], [, b]) => at(a).localeCompare(at(b)));
  let excess = entries.length - max;
  for (const [key] of removable) {
    if (excess <= 0) break;
    delete records[key];
    excess -= 1;
  }
}

/**
 * Bounds every growing collection. Operations still in flight, receipts and
 * the artifacts something references are never pruned: a reconciliation may
 * still need them.
 */
export function pruneCapabilityState(state: CapabilityState, now = Date.now()): void {
  keepNewest(state.activity, CAPABILITY_LIMITS.maxActivity, (entry) => entry.at);
  keepNewest(
    state.operations,
    CAPABILITY_LIMITS.maxOperations,
    (entry) => entry.updatedAt,
    (entry) => !isTerminalCapabilityOperationState(entry.state),
  );
  keepNewest(
    state.updates,
    CAPABILITY_LIMITS.maxUpdates,
    (entry) => entry.detectedAt,
    (entry) => entry.state === "pending",
  );
  keepNewest(
    state.drift,
    CAPABILITY_LIMITS.maxDrift,
    (entry) => entry.detectedAt,
    (entry) => entry.state === "open",
  );
  keepNewest(state.observations, CAPABILITY_LIMITS.maxObservations, (entry) => entry.observedAt);
  keepNewest(state.requests, 2_000, (entry) => entry.at);
  keepNewest(
    state.launches,
    2_000,
    (entry) => entry.launchedAt,
    (entry) => Boolean(entry.privatePlugin),
  );
  // A preview nobody applied within a day is withdrawn; its approval could no longer match anyway.
  for (const operation of Object.values(state.operations)) {
    if (
      (operation.state === "awaiting-approval" || operation.state === "planned") &&
      Date.parse(operation.updatedAt) + 24 * 60 * 60_000 <= now
    ) {
      operation.state = "cancelled";
      operation.error = "The preview expired without being applied.";
    }
  }
  for (const [id, inspection] of Object.entries(state.inspections)) {
    if (Date.parse(inspection.expiresAt) <= now) delete state.inspections[id];
  }
  for (const [id, update] of Object.entries(state.updates)) {
    if (update.state === "pending" && !state.inspections[`update:${id}`]) {
      delete state.updates[id];
    }
  }
  for (const [id, entry] of Object.entries(state.imports)) {
    if (Date.parse(entry.createdAt) + 60 * 60_000 <= now) delete state.imports[id];
  }
  const liveOperations = new Set(
    Object.values(state.operations)
      .filter((operation) => !isTerminalCapabilityOperationState(operation.state))
      .map((operation) => operation.id),
  );
  for (const [id, approval] of Object.entries(state.approvals)) {
    if (!state.operations[approval.operationId] && !liveOperations.has(approval.operationId)) {
      delete state.approvals[id];
    }
  }
}

/**
 * The `capabilities` store (docs/architecture/agent-capabilities-management.md,
 * "Storage"): one envelope, written only through `updateStore`, so every
 * read-modify-write is one synchronous SQLite transaction and two backends
 * sharing the data directory cannot interleave a compare-and-swap. The
 * `capability-executor` document is this machine's own executor record (the
 * epoch it accepts plans at, and the plan keys it already applied).
 */
export class CapabilitiesRepository {
  constructor(private readonly context: StorageContext) {}

  private stateFile(): string {
    return this.context.file("capabilities.json");
  }

  private executorFile(): string {
    return this.context.file("capability-executor.json");
  }

  async loadCapabilityState(): Promise<CapabilityState> {
    return normalizeState(await this.context.loadJson<unknown>(this.stateFile(), () => null));
  }

  /**
   * Read-modify-write of the whole state in one transaction. `mutate`
   * returns its result; returning with `changed: false` commits nothing and
   * does not bump the revision.
   */
  mutateCapabilityState<T>(mutate: (state: CapabilityState) => { result: T; changed: boolean }): T {
    let result!: T;
    this.context.updateStore<Record<string, unknown>, void>(
      this.stateFile(),
      () => ({}),
      (raw) => {
        const state = normalizeState(raw);
        const outcome = mutate(state);
        result = outcome.result;
        if (!outcome.changed) return;
        state.revision += 1;
        pruneCapabilityState(state);
        for (const key of Object.keys(raw)) delete raw[key];
        Object.assign(raw, state);
      },
    );
    return result;
  }

  async loadCapabilityExecutorState(): Promise<CapabilityExecutorState> {
    const value = await this.context.loadJson<unknown>(this.executorFile(), () => null);
    if (!isRecord(value)) return { epoch: 0, applied: {} };
    return {
      ...(typeof value.controllerId === "string" ? { controllerId: value.controllerId } : {}),
      epoch: typeof value.epoch === "number" ? value.epoch : 0,
      applied: isRecord(value.applied) ? (value.applied as CapabilityExecutorState["applied"]) : {},
    };
  }

  forgetCapabilityLaunches(
    matches: (launch: CapabilityState["launches"][string]) => boolean,
  ): void {
    this.mutateCapabilityState((state) => {
      const removed = Object.entries(state.launches).filter(([, launch]) => matches(launch));
      for (const [key] of removed) delete state.launches[key];
      return { result: undefined, changed: removed.length > 0 };
    });
  }

  mutateCapabilityExecutorState<T>(mutate: (state: CapabilityExecutorState) => T): T {
    let result!: T;
    this.context.updateStore<Record<string, unknown>, void>(
      this.executorFile(),
      () => ({}),
      (raw) => {
        const state: CapabilityExecutorState = {
          ...(typeof raw.controllerId === "string" ? { controllerId: raw.controllerId } : {}),
          epoch: typeof raw.epoch === "number" ? raw.epoch : 0,
          applied: isRecord(raw.applied) ? (raw.applied as CapabilityExecutorState["applied"]) : {},
        };
        result = mutate(state);
        const entries = Object.entries(state.applied).sort(([, a], [, b]) =>
          b.at.localeCompare(a.at),
        );
        state.applied = Object.fromEntries(entries.slice(0, CAPABILITY_LIMITS.maxReceipts));
        for (const key of Object.keys(raw)) delete raw[key];
        Object.assign(raw, state);
      },
    );
    return result;
  }
}

/**
 * The capabilities store: what callers reach as `storage.capabilities`.
 * Every name here is an entry point `writer-guards.test.ts` follows
 * store writes back to.
 */
export type CapabilitiesStorage = Pick<
  CapabilitiesRepository,
  | "loadCapabilityState"
  | "mutateCapabilityState"
  | "forgetCapabilityLaunches"
  | "loadCapabilityExecutorState"
  | "mutateCapabilityExecutorState"
>;
