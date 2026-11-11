import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AmbiguousPromptDispatchError, PromptRejectedError } from "./agent-provider-contract.js";
import { isDefaultDataDir } from "../data-dir.js";

/**
 * A test-only hold on prompt dispatch in the backend's bridge client
 * (to-do 0050 task 3), so a live spec can stop the backend at a known point
 * of the at-most-once dispatch window instead of racing it.
 *
 * A spec arms it by creating a marker file in the profile's data directory:
 *
 * - `<data dir>/agent-test-fixtures/dispatch-hold/hold-before-send` holds every
 *   prompt send after the caller journaled it (a build pipeline has saved
 *   `pendingPromptAttempt` with `dispatchingAt`) and before the request
 *   leaves the backend: "journaled, not sent".
 * - `.../hold-after-response` holds after the bridge answered 2xx and before
 *   the caller records the send: "accepted by the bridge, not yet recorded".
 *
 * While a send is held the hold writes `held-<point>.json` beside the marker
 * (ids and times only, never prompt text), and rewrites it with `releasedAt`
 * when the marker is removed. Killing the backend while it is held is the
 * whole point; removing the marker lets the send go on.
 *
 * It is reachable only in an isolated agent-test backend: the runtime flavor
 * must be `agent-test`, the desktop's `ORKESTRATOR_AGENT_TEST_ISOLATED=1` must
 * be set, and the data directory must not be the default one. A production
 * build hard-disables the capability, so {@link agentTestDispatchHold}
 * answers `undefined`, nothing is installed, and the bridge client never
 * touches the file system on a send.
 */
// Production bundlers replace this capability with false. Source-run dev:test
// backends retain it; runtime switches cannot override a bundled false.
declare const __ORKESTRATOR_DISPATCH_HOLD__: boolean;
const dispatchHoldBuildEnabled =
  typeof __ORKESTRATOR_DISPATCH_HOLD__ === "undefined" || __ORKESTRATOR_DISPATCH_HOLD__;

export const DISPATCH_HOLD_FIXTURE_DIR = path.join("agent-test-fixtures", "dispatch-hold");

export type DispatchHoldPoint = "before-send" | "after-response";

export const DISPATCH_HOLD_POINTS: readonly DispatchHoldPoint[] = ["before-send", "after-response"];

/** Ids only: what a spec needs to match the held send to the journal. */
export interface DispatchHoldDetail {
  agent: string;
  sessionId: string;
  requestId?: string;
}

export interface DispatchHoldRecord extends DispatchHoldDetail {
  point: DispatchHoldPoint;
  pid: number;
  heldAt: string;
  releasedAt?: string;
  /** Why the hold ended: the marker was removed, or the bound ran out. */
  release?: "marker-removed" | "max-hold" | "cancelled";
}

export function dispatchHoldMarkerName(point: DispatchHoldPoint): string {
  return `hold-${point}`;
}

export function dispatchHoldRecordName(point: DispatchHoldPoint): string {
  return `held-${point}.json`;
}

const MAX_ID_LENGTH = 256;
const DEFAULT_POLL_MS = 100;
/** A forgotten marker must not wedge a profile for good. */
const DEFAULT_MAX_HOLD_MS = 15 * 60_000;

export interface AgentTestDispatchHoldOptions {
  dataDir: string;
  runtimeFlavor: "production" | "development" | "agent-test" | undefined;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  maxHoldMs?: number;
}

export interface AgentTestDispatchHold {
  /** Resolves at once unless the point's marker exists; then waits for its removal. */
  hold(point: DispatchHoldPoint, detail: DispatchHoldDetail): Promise<void>;
  /** Refuses held sends without allowing a new dispatch during shutdown. */
  dispose(): void;
  cancel(agent: string, sessionId: string): void;
}

function boundedId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, MAX_ID_LENGTH);
}

/**
 * Whether this backend may enable an agent-test fixture capability: a source
 * build (production bundles define the capability off), the `agent-test`
 * runtime flavor, `ORKESTRATOR_AGENT_TEST_ISOLATED=1`, and a data directory
 * that is not the default one. Shared by the dispatch hold and the fan-out
 * stats recorder (`agent-test-fanout-stats.ts`).
 */
export function isolatedAgentTestBackend(options: {
  dataDir: string;
  runtimeFlavor: AgentTestDispatchHoldOptions["runtimeFlavor"];
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (!dispatchHoldBuildEnabled) return false;
  const env = options.env ?? process.env;
  if (options.runtimeFlavor !== "agent-test") return false;
  if (env.ORKESTRATOR_AGENT_TEST_ISOLATED !== "1") return false;
  return !isDefaultDataDir(options.dataDir, process.platform, env);
}

/** The hold for this backend, or `undefined` outside an isolated agent-test profile. */
export function agentTestDispatchHold(
  options: AgentTestDispatchHoldOptions,
): AgentTestDispatchHold | undefined {
  if (!isolatedAgentTestBackend(options)) return undefined;
  const directory = path.join(options.dataDir, DISPATCH_HOLD_FIXTURE_DIR);
  const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
  const maxHoldMs = Math.max(pollMs, options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Map<DispatchHoldDetail, () => void>();
  let disposed = false;
  let sequence = 0;

  const writeRecord = (point: DispatchHoldPoint, record: DispatchHoldRecord) => {
    // A failed write must not change dispatch: the spec then times out on
    // the missing record instead of the product doing something different.
    try {
      mkdirSync(directory, { recursive: true });
      const target = path.join(directory, dispatchHoldRecordName(point));
      const temporary = `${target}.${process.pid}.${++sequence}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      renameSync(temporary, target);
    } catch {
      // Diagnostics only.
    }
  };

  return {
    hold(point, detail) {
      if (disposed) return Promise.resolve();
      const marker = path.join(directory, dispatchHoldMarkerName(point));
      if (!existsSync(marker)) return Promise.resolve();
      const record: DispatchHoldRecord = {
        point,
        agent: boundedId(detail.agent) ?? "",
        sessionId: boundedId(detail.sessionId) ?? "",
        ...(detail.requestId !== undefined ? { requestId: boundedId(detail.requestId) } : {}),
        pid: process.pid,
        heldAt: new Date().toISOString(),
      };
      writeRecord(point, record);
      const startedAt = Date.now();
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        pending.set(detail, () => {
          clearTimeout(timer);
          timers.delete(timer);
          pending.delete(detail);
          writeRecord(point, {
            ...record,
            releasedAt: new Date().toISOString(),
            release: "cancelled",
          });
          reject(
            point === "before-send"
              ? new PromptRejectedError("Test dispatch hold cancelled before send")
              : new AmbiguousPromptDispatchError("Test dispatch hold cancelled after acceptance"),
          );
        });
        const poll = () => {
          if (disposed) return;
          const removed = !existsSync(marker);
          const expired = Date.now() - startedAt >= maxHoldMs;
          if (removed || expired) {
            writeRecord(point, {
              ...record,
              releasedAt: new Date().toISOString(),
              release: removed ? "marker-removed" : "max-hold",
            });
            pending.delete(detail);
            resolve();
            return;
          }
          schedule();
        };
        const schedule = () => {
          timer = setTimeout(() => {
            timers.delete(timer);
            poll();
          }, pollMs);
          timer.unref?.();
          timers.add(timer);
        };
        schedule();
      });
    },
    cancel(agent, sessionId) {
      for (const [detail, cancel] of Array.from(pending)) {
        if (detail.agent === agent && detail.sessionId === sessionId) cancel();
      }
    },
    dispose() {
      disposed = true;
      for (const cancel of Array.from(pending.values())) cancel();
      for (const timer of Array.from(timers)) clearTimeout(timer);
      timers.clear();
    },
  };
}

let installed: AgentTestDispatchHold | undefined;

/**
 * Makes `hold` the bridge client's dispatch hold until the returned function
 * runs. Only the backend installs one, and only when
 * {@link agentTestDispatchHold} returned it.
 */
export function installAgentTestDispatchHold(hold: AgentTestDispatchHold): () => void {
  installed = hold;
  return () => {
    hold.dispose();
    if (installed === hold) installed = undefined;
  };
}

/**
 * The bridge client's seam: `undefined` (nothing to await) unless an
 * agent-test hold is installed.
 */
export function promptDispatchHold(
  point: DispatchHoldPoint,
  detail: DispatchHoldDetail,
): Promise<void> | undefined {
  return installed?.hold(point, detail);
}

/** Abort only this session's held sends; other sessions retain their markers. */
export function cancelPromptDispatchHold(agent: string, sessionId: string): void {
  installed?.cancel(agent, sessionId);
}
