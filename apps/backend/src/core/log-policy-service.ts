import type { StorageService } from "./storage.js";
import { createHash } from "node:crypto";
import { createLogger, emitLogRecord } from "@orkestrator/protocol/logger";
import {
  BRIDGE_LOG_POLICY_ROUTE,
  formatLogAreaLevels,
  type BridgeLogPolicy,
  type LogDetail,
} from "@orkestrator/protocol/log-policy";
import {
  readApplicationLogPolicy,
  readStoredApplicationLogPolicy,
  type InstalledApplicationLogging,
} from "@orkestrator/protocol/node/application-logging";
import {
  applyApplicationLogPolicy,
  logPolicyChangedRecord,
  logPolicyKey,
} from "@orkestrator/protocol/node/log-policy";

const log = createLogger("logging");

const REQUEST_TIMEOUT_MS = 5_000;
// A bridge can be busy without being gone: its event loop is exactly what a
// stuck turn may be holding up. After these, its next start resends.
const RETRY_DELAYS_MS = [2_000, 10_000];
const REQUEST_CONCURRENCY = 8;
// A full push prunes these to the bridges still running; between pushes, each
// replaced bridge adds an entry.
const MAX_TRACKED_BRIDGES = 1_024;

export interface BridgeLogPolicyTarget {
  /** The bridge's platform, for the log line. */
  agent: string;
  baseUrl: string;
  authToken: string;
}

export interface LogPolicyServiceOptions {
  dataDir: string;
  /** This process's own file writer; null when the desktop records this process. */
  logging: Pick<InstalledApplicationLogging, "updateSettings"> | null;
  /** Every bridge running now, without starting one or touching its sessions. */
  listRunningBridges: (
    onTarget?: (target: BridgeLogPolicyTarget) => void,
  ) => Promise<BridgeLogPolicyTarget[]>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

type PostOutcome =
  | { kind: "applied" }
  | { kind: "predates-route" }
  | { kind: "stale"; seq: number }
  | { kind: "failed"; reason: string };

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function targetIdentity(target: BridgeLogPolicyTarget): string {
  return createHash("sha256")
    .update(target.agent)
    .update("\0")
    .update(target.baseUrl)
    .update("\0")
    .update(target.authToken)
    .digest("hex");
}

function track(entries: Map<string, number>, id: string, seq: number): void {
  entries.delete(id);
  entries.set(id, seq);
  if (entries.size <= MAX_TRACKED_BRIDGES) return;
  const oldest = entries.keys().next().value;
  if (oldest !== undefined) entries.delete(oldest);
}

function bridgeDetailKey(detail: LogDetail): string {
  return `${detail.level}|${formatLogAreaLevels(detail)}`;
}

/**
 * Makes "Log detail" and "Save logs to disk" live: on a settings change this
 * applies the policy to this process, writes the audit line, and sends the levels
 * to every running bridge. The relay carries the same audit line to a desktop
 * that supervises this process, which re-reads `config.json` when it sees it
 * (docs/architecture/logging.md, "Live settings").
 *
 * Delivery is best-effort and never touches a session. A bridge that predates the
 * route answers 404 or 405, and takes the setting from its environment at its
 * next start. Every start resends, so a missed update cannot outlive a restart.
 */
export class LogPolicyService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private policyKey = "";
  private detailKey = "";
  private detail: LogDetail = { level: "info", areaLevels: {} };
  private seq = 0;
  private stopped = false;
  /** The last sequence each bridge generation took, so a repeated start sends nothing. */
  private readonly delivered = new Map<string, number>();
  /** One delivery loop per bridge; a newer policy is picked up by the running loop. */
  private readonly delivering = new Set<string>();
  private activeRequests = 0;
  private readonly requestWaiters: Array<() => void> = [];
  private readonly reportedFailures = new Map<string, number>();

  constructor(private readonly options: LogPolicyServiceOptions) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  /** Applies what is stored, with no audit line: a start is not a change. */
  start(): void {
    const policy = readApplicationLogPolicy(this.options.dataDir);
    this.policyKey = logPolicyKey(policy);
    this.setDetail(policy.detail);
    applyApplicationLogPolicy(policy, this.options.logging, undefined, this.env);
    // Container bridges outlive a backend restart and may hold an older policy.
    this.pushInBackground();
  }

  /** Call after any write to the config. Writes that leave logging alone do nothing. */
  configChanged(): void {
    if (this.stopped) return;
    const policy = readStoredApplicationLogPolicy(this.options.dataDir);
    if (!policy) return;
    const key = logPolicyKey(policy);
    if (key === this.policyKey) return;
    this.policyKey = key;
    applyApplicationLogPolicy(
      policy,
      this.options.logging,
      (changed) => emitLogRecord(logPolicyChangedRecord(changed)),
      this.env,
    );
    if (bridgeDetailKey(policy.detail) === this.detailKey) return;
    this.setDetail(policy.detail);
    this.pushInBackground();
  }

  /** A bridge just started or was found running. Sends only if it may be out of date. */
  bridgeStarted(target: BridgeLogPolicyTarget): void {
    if (this.stopped || this.seq === 0) return;
    this.deliver(target).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
  }

  private setDetail(detail: LogDetail): void {
    this.detail = detail;
    this.detailKey = bridgeDetailKey(detail);
    // Survives a restart without a stored counter: later than anything an
    // earlier process sent, as long as the clock has not gone backwards, and
    // the `stale` answer below recovers from that too.
    this.seq = Math.max(this.now(), this.seq + 1);
  }

  private pushInBackground(): void {
    this.pushToRunningBridges().catch(() => undefined);
  }

  private async pushToRunningBridges(): Promise<void> {
    let targets: BridgeLogPolicyTarget[];
    const deliveries: Promise<void>[] = [];
    const seen = new Set<string>();
    const deliver = (target: BridgeLogPolicyTarget) => {
      const id = targetIdentity(target);
      if (seen.has(id) || seen.size >= MAX_TRACKED_BRIDGES) return;
      seen.add(id);
      // Discovery can still be in flight when delivery settles; observe rejection now.
      deliveries.push(this.deliver(target).catch(() => undefined));
    };
    try {
      targets = await this.options.listRunningBridges(deliver);
    } catch {
      // Each bridge still takes the setting when it next starts.
      log.warn("policy.push-failed", { agent: "all", reason: "list-failed" });
      await Promise.all(deliveries);
      return;
    }
    for (const target of targets) deliver(target);
    const live = new Set(targets.map(targetIdentity));
    for (const id of Array.from(this.delivered.keys())) {
      if (!live.has(id)) this.delivered.delete(id);
    }
    for (const id of Array.from(this.reportedFailures.keys())) {
      if (!live.has(id)) this.reportedFailures.delete(id);
    }
    await Promise.all(deliveries);
  }

  private async deliver(target: BridgeLogPolicyTarget): Promise<void> {
    const id = targetIdentity(target);
    if (this.delivering.has(id) || this.delivering.size >= MAX_TRACKED_BRIDGES) return;
    this.delivering.add(id);
    try {
      let failures = 0;
      let retrySeq = this.seq;
      while (!this.stopped && this.delivered.get(id) !== this.seq) {
        const seq = this.seq;
        if (retrySeq !== seq) {
          failures = 0;
          retrySeq = seq;
        }
        const outcome = await this.post(target, seq, this.detail);
        // A failed final attempt must not strand a policy that arrived in flight.
        if (seq !== this.seq) continue;
        if (outcome.kind === "applied") {
          track(this.delivered, id, seq);
          this.reportedFailures.delete(id);
          failures = 0;
          continue;
        }
        if (outcome.kind === "predates-route") {
          // Not a failure: it keeps working and reads its environment next start.
          track(this.delivered, id, seq);
          log.debug("policy.bridge-predates-route", { agent: target.agent });
          failures = 0;
          continue;
        }
        if (outcome.kind === "stale") {
          this.seq = Math.max(this.seq, outcome.seq + 1);
          continue;
        }
        const delay = this.retryDelaysMs[failures];
        if (delay === undefined) {
          if (this.reportedFailures.get(id) !== seq) {
            track(this.reportedFailures, id, seq);
            log.warn("policy.push-failed", { agent: target.agent, reason: outcome.reason });
          }
          return;
        }
        failures += 1;
        await this.sleep(delay);
      }
    } finally {
      this.delivering.delete(id);
    }
  }

  private async post(
    target: BridgeLogPolicyTarget,
    seq: number,
    detail: LogDetail,
  ): Promise<PostOutcome> {
    // Limit HTTP work, not delivery loops: retry sleeps never occupy a slot.
    // deliver() bounds the number of loops and therefore this FIFO as well.
    if (this.activeRequests >= REQUEST_CONCURRENCY) {
      await new Promise<void>((resolve) => this.requestWaiters.push(resolve));
    } else {
      this.activeRequests += 1;
    }
    try {
      if (this.stopped) return { kind: "failed", reason: "stopped" };
      return await this.postRequest(target, seq, detail);
    } finally {
      const next = this.requestWaiters.shift();
      if (next) next();
      else this.activeRequests -= 1;
    }
  }

  private async postRequest(
    target: BridgeLogPolicyTarget,
    seq: number,
    detail: LogDetail,
  ): Promise<PostOutcome> {
    const body: BridgeLogPolicy = { seq, ...detail };
    let response: Response;
    try {
      response = await this.fetchImpl(`${target.baseUrl}${BRIDGE_LOG_POLICY_ROUTE}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        kind: "failed",
        reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable",
      };
    }
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "predates-route" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "failed", reason: `http-${response.status}` };
    }
    const answer = (await response.json().catch(() => null)) as {
      applied?: unknown;
      stale?: unknown;
      seq?: unknown;
    } | null;
    if (answer?.applied === true) return { kind: "applied" };
    if (answer?.stale === true && Number.isSafeInteger(answer.seq)) {
      return { kind: "stale", seq: answer.seq as number };
    }
    return { kind: "failed", reason: "malformed-answer" };
  }
}

/** The backend lifecycle owns the config listener as well as the service. */
export function startLogPolicyService(
  storage: Pick<StorageService, "getDataDir" | "addResourceChangeListener">,
  options: Omit<LogPolicyServiceOptions, "dataDir">,
): { service: LogPolicyService; stop: () => void } {
  const service = new LogPolicyService({ ...options, dataDir: storage.getDataDir() });
  const removeListener = storage.addResourceChangeListener((change) => {
    if (change.resource === "config") service.configChanged();
  });
  service.start();
  return {
    service,
    stop: () => {
      removeListener();
      service.stop();
    },
  };
}
