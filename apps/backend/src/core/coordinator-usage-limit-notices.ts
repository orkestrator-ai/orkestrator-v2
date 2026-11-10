/**
 * A session stopped on a usage limit: tell the coordinator that should hear it.
 * See docs/architecture/coordinator.md ("Usage-limit stop notices").
 *
 * The machine where the session stopped raises it once and routes it, and the
 * machine with the receiving coordinator groups what arrives by account and reset
 * window, so many sessions hitting one limit cost one wake listing them. A later
 * stop in a window that has had its wake is filed without one.
 *
 * Before that wake, a coordinator on the limited account (matched by provider and
 * identity, so across machines too) has this machine moved off it, through the
 * automatic switcher so nothing is pinned. When that cannot happen the notice is
 * kept without a wake and says why: a turn on that account would only fail.
 *
 * Loop protection: a coordinator's own stop never wakes itself. A leaf
 * coordinator's goes up the hierarchy; with nobody above, it tries the switch, and
 * the provider's error in its transcript is what the user sees. So a wake that
 * fails on a limit ends there rather than raising another wake.
 */
import { createHash } from "node:crypto";
import {
  AGENT_MAIL_MAX_BODY_BYTES,
  AgentMailError,
  normalizeAgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import {
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  coordinatorMainConversation,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import {
  USAGE_LIMIT_NOTICE_COALESCED_REASON,
  USAGE_LIMIT_NOTICE_KEPT_REASON,
  USAGE_LIMIT_NOTICE_QUIET_REASON,
  noticeText,
  usageLimitAccountKey,
  usageLimitStopNoticeText,
  type CoordinatorAccountKeptReason,
  type UsageLimitStop,
} from "@orkestrator/protocol/coordinator-notices";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { LimitedAccountMove, UsageLimitStopReport } from "./agent-accounts-auto-switch.js";
import type { CoordinatorNoticeRouter } from "./coordinator-notice-router.js";
import type {
  UsageLimitNoticeGroup,
  UsageLimitNoticeLedger,
} from "./storage-coordinator-notices.js";
import type { StorageService } from "./storage.js";

const log = createLogger("coordinator");

/** Sessions stop on one limit within moments of each other. */
export const USAGE_LIMIT_NOTICE_COALESCE_MS = 30_000;
/** A window with no known reset is taken to last as long as the shortest provider window. */
const UNKNOWN_RESET_WINDOW_MS = 5 * 60 * 60_000;
/** One account's limit reads a few minutes apart across machines and readings. */
const RESET_TOLERANCE_MS = 60 * 60_000;
const GROUP_RETENTION_MS = 24 * 60 * 60_000;
const MAX_GROUPS = 256;
const MAX_STOPS_PER_GROUP = 100;
const MAX_RAISED = 2_000;
const FLUSH_RETRY_MS = 60_000;

export type UsageLimitNoticeStorage = Pick<
  StorageService,
  | "sendAgentMail"
  | "getEnvironment"
  | "getProject"
  | "getAgentMailMailbox"
  | "loadConfig"
  | "coordinatorNotices"
> & {
  coordinators: Pick<
    StorageService["coordinators"],
    | "getCoordinatorWorkspaceById"
    | "getCoordinatorWorkspace"
    | "listCoordinatorWorkflowAssociations"
  >;
};

export interface UsageLimitNoticeDeps {
  storage: UsageLimitNoticeStorage;
  router: Pick<CoordinatorNoticeRouter, "route" | "sendUp" | "mainFor">;
  machine(): Promise<{ key: string; name: string }>;
  /** The login a coordinator's next turn would run on, or null when no account covers it. */
  coordinatorAccountKey(environmentId: string, agent: string): Promise<string | null>;
  /** Move this machine off every login with this key. */
  moveOff(
    platform: string,
    accountKey: string,
    options: { quietProjectId?: string },
  ): Promise<LimitedAccountMove>;
  now?(): number;
  coalesceMs?: number;
}

function stopId(environmentId: string, requestId: string): string {
  const hash = createHash("sha256").update(`${environmentId}\0${requestId}`).digest("hex");
  return `stop-${hash.slice(0, 32)}`;
}

function groupId(projectId: string, accountKey: string, openedAt: number): string {
  const hash = createHash("sha256")
    .update(`${projectId}\0${accountKey}\0${openedAt}`)
    .digest("hex");
  return `group-${hash.slice(0, 32)}`;
}

function resetTime(stop: UsageLimitStop): number | undefined {
  const time = stop.resetsAt ? Date.parse(stop.resetsAt) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}

function pruneLedger(ledger: UsageLimitNoticeLedger, now: number): void {
  ledger.groups = ledger.groups
    .filter((group) => group.windowEndsAt + GROUP_RETENTION_MS > now || unsent(group).length > 0)
    .slice(-MAX_GROUPS);
  const ids = Object.keys(ledger.raised);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_RAISED))) delete ledger.raised[id];
}

function unsent(group: UsageLimitNoticeGroup): UsageLimitStop[] {
  return group.stops.filter((stop) => !group.sentStopIds.includes(stop.id));
}

export class CoordinatorUsageLimitNotices {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flushes = new Map<string, Promise<void>>();
  /** Each armed flush timer's wall-clock due time, and when it fired (or was cleared). */
  private readonly flushTimers = new Map<
    string,
    { dueAt: number; fired: Promise<void>; release: () => void }
  >();
  private stopped = false;

  constructor(private readonly deps: UsageLimitNoticeDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Sends what a previous run grouped but did not get to send. */
  start(): void {
    this.stopped = false;
    const groups = this.deps.storage.coordinatorNotices.updateUsageLimitNoticeLedger((ledger) => {
      pruneLedger(ledger, this.now());
      return ledger.groups.filter((group) => unsent(group).length > 0);
    });
    for (const group of groups) this.schedule(group.id, group.flushAt);
    const reports = this.deps.storage.coordinatorNotices.updateUsageLimitNoticeLedger((ledger) =>
      Object.values(ledger.pendingReports ?? {}),
    );
    for (const report of reports) {
      void this.noteStop(report).catch((error: unknown) => {
        log.warn("limit-stop.notice-failed", { error: formatLogError(error) });
      });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.flushTimers.values()) timer.release();
    this.flushTimers.clear();
  }

  /**
   * Resolves once every flush due so far has finished. Tests use it. With
   * `dueWithinMs`, it first waits for flush timers due within that many
   * milliseconds to fire, and for any flush they schedule in turn, instead of a
   * test sleeping through the coalescing window.
   */
  async settled(dueWithinMs?: number): Promise<void> {
    if (dueWithinMs === undefined) {
      await Promise.all(this.flushes.values());
      return;
    }
    for (;;) {
      const horizon = Date.now() + dueWithinMs;
      const due = Array.from(this.flushTimers.values())
        .filter((timer) => timer.dueAt <= horizon)
        .map((timer) => timer.fired);
      if (due.length === 0 && this.flushes.size === 0) return;
      await Promise.all([...due, ...this.flushes.values()]);
    }
  }

  /** The machine where the session stopped: raise it once, and route it. */
  async noteStop(report: UsageLimitStopReport): Promise<void> {
    try {
      await this.processStop(report);
    } catch (error) {
      const key = `report:${stopId(report.environmentId, report.requestId)}`;
      if (!this.stopped && !this.timers.has(key) && this.timers.size < MAX_RAISED) {
        const timer = setTimeout(() => {
          this.timers.delete(key);
          void this.noteStop(report).catch((retryError: unknown) => {
            log.warn("limit-stop.notice-failed", { error: formatLogError(retryError) });
          });
        }, FLUSH_RETRY_MS);
        timer.unref?.();
        this.timers.set(key, timer);
      }
      throw error;
    }
  }

  private async processStop(report: UsageLimitStopReport): Promise<void> {
    const id = stopId(report.environmentId, report.requestId);
    const { storage, router } = this.deps;
    const seen = storage.coordinatorNotices.updateUsageLimitNoticeLedger(
      (ledger) => ledger.raised[id] !== undefined,
    );
    if (seen) return;
    storage.coordinatorNotices.updateUsageLimitNoticeLedger((ledger) => {
      ledger.pendingReports ??= {};
      if (!ledger.pendingReports[id] && Object.keys(ledger.pendingReports).length >= MAX_RAISED) {
        throw new Error("Usage-limit report queue is full.");
      }
      ledger.pendingReports[id] = report;
    });
    const place = await this.placeOf(report);
    if (!place) {
      storage.coordinatorNotices.updateUsageLimitNoticeLedger((ledger) => {
        delete ledger.pendingReports?.[id];
      });
      return;
    }
    const machine = await this.deps.machine();
    const email = report.account?.identity.email;
    const account = {
      platform: report.platform,
      key: usageLimitAccountKey({
        platform: report.platform,
        machineKey: machine.key,
        email,
        accountId: report.account?.id,
      }),
      ...(report.account ? { label: report.account.label } : {}),
      ...(email ? { email } : {}),
    };
    const stop: UsageLimitStop = {
      id,
      at: new Date(this.now()).toISOString(),
      machine: machine.name,
      repository: place.repository,
      environmentId: report.environmentId,
      ...(place.environmentName ? { environmentName: place.environmentName } : {}),
      ...(report.session?.tabId ? { tabId: report.session.tabId } : {}),
      session: place.session,
      sessionKind: place.kind,
      account,
      ...(report.resetsAt !== undefined
        ? { resetsAt: new Date(report.resetsAt).toISOString() }
        : {}),
      ...(report.resetHint ? { resetHint: noticeText(report.resetHint, 60) ?? "" } : {}),
      next: report.verdict,
    };
    const route = await router.route(place.projectId);
    const queued =
      route.kind === "command-node" &&
      (await router.sendUp(route, {
        requestId: id,
        fromEnvironmentId: report.environmentId,
        fromTabId: report.session?.tabId ?? "notice",
        ...(place.environmentName ? { fromEnvironmentName: place.environmentName } : {}),
        subject: `${place.session} stopped on a usage limit`,
        body: usageLimitStopNoticeText({
          stops: [stop],
          coordinator: { kind: "unaffected" },
          followUp: false,
        }).body,
        coordinatorNotice: { kind: "usage-limit-stop", stop },
        noticeProjectId: place.projectId,
      }));
    if (!queued) await this.takeBack(stop, place.projectId);
    storage.coordinatorNotices.updateUsageLimitNoticeLedger((ledger) => {
      ledger.raised[id] = stop.at;
      delete ledger.pendingReports?.[id];
      pruneLedger(ledger, this.now());
    });
  }

  /**
   * A stop this machine's coordinator takes. Its own stop stops here: it attempts
   * the move, and nothing wakes it to say it stopped.
   */
  async takeBack(stop: UsageLimitStop, projectId: string): Promise<void> {
    const coordinatorId = coordinatorIdFromRuntimeId(stop.environmentId);
    if (coordinatorId) {
      const workspace =
        await this.deps.storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
      const main = workspace ? coordinatorMainConversation(workspace) : undefined;
      if (main && coordinatorConversationIdFromRuntimeId(stop.environmentId) === main.id) {
        const move = await this.deps.moveOff(stop.account.platform, stop.account.key, {
          quietProjectId: projectId,
        });
        log.info("limit-stop.own", {
          moved: move.moved,
          reason: move.moved ? null : move.reason,
        });
        return;
      }
    }
    await this.receive(stop, projectId);
  }

  /** The machine with the receiving coordinator: add it to its window. Idempotent. */
  async receive(stop: UsageLimitStop, projectId: string): Promise<void> {
    const now = this.now();
    const reset = resetTime(stop);
    const group = this.deps.storage.coordinatorNotices.updateUsageLimitNoticeLedger((ledger) => {
      pruneLedger(ledger, now);
      if (ledger.groups.some((entry) => entry.stops.some((known) => known.id === stop.id))) {
        return null;
      }
      const matching = ledger.groups.filter(
        (entry) =>
          entry.projectId === projectId &&
          entry.accountKey === stop.account.key &&
          entry.windowEndsAt > now &&
          (entry.resetsAt === undefined ||
            reset === undefined ||
            Math.abs(entry.resetsAt - reset) <= RESET_TOLERANCE_MS),
      );
      const open = matching.find((entry) => entry.stops.length < MAX_STOPS_PER_GROUP);
      const flushAt = now + (this.deps.coalesceMs ?? USAGE_LIMIT_NOTICE_COALESCE_MS);
      if (open) {
        open.stops.push(stop);
        if (unsent(open).length === 1) open.flushAt = flushAt;
        if (open.resetsAt === undefined && reset !== undefined) {
          open.resetsAt = reset;
          open.windowEndsAt = Math.max(reset, now);
        }
        return open;
      }
      const created: UsageLimitNoticeGroup = {
        id: groupId(projectId, stop.account.key, now) + `-${ledger.groups.length}`,
        projectId,
        accountKey: stop.account.key,
        ...(reset !== undefined ? { resetsAt: reset } : {}),
        windowEndsAt: reset ?? now + UNKNOWN_RESET_WINDOW_MS,
        flushAt,
        stops: [stop],
        sentStopIds: [],
        flushes: matching.length ? 1 : 0,
      };
      ledger.groups.push(created);
      return created;
    });
    if (group) this.schedule(group.id, group.flushAt);
  }

  private schedule(id: string, at: number): void {
    if (this.stopped || this.timers.has(id) || this.flushes.has(id)) return;
    const delay = Math.max(0, at - this.now());
    let release!: () => void;
    const fired = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.flushTimers.set(id, { dueAt: Date.now() + delay, fired, release });
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.flushTimers.delete(id);
      let failed = false;
      const flush = this.flush(id)
        .catch((error: unknown) => {
          // It stays in the ledger and goes again under the same request id,
          // while the window it is about still matters, and on the next start.
          log.warn("limit-stop.notice-failed", { error: formatLogError(error) });
          failed = true;
        })
        .finally(() => {
          if (this.flushes.get(id) === flush) this.flushes.delete(id);
          if (failed) this.retry(id);
          else {
            const next = this.update(id, (group) =>
              unsent(group).length ? group.flushAt : undefined,
            );
            if (next !== undefined) this.schedule(id, next);
          }
        });
      this.flushes.set(id, flush);
      release();
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private retry(id: string): void {
    const open = this.update(id, (group) => group.windowEndsAt > this.now());
    if (open) this.schedule(id, this.now() + FLUSH_RETRY_MS);
  }

  private update<T>(id: string, change: (group: UsageLimitNoticeGroup) => T): T | undefined {
    return this.deps.storage.coordinatorNotices.updateUsageLimitNoticeLedger((ledger) => {
      const group = ledger.groups.find((entry) => entry.id === id);
      return group ? change(group) : undefined;
    });
  }

  /** Leave room for account-move text while bounding the fully encoded mail body. */
  private boundedBatch(stops: UsageLimitStop[]): UsageLimitStop[] {
    const batch: UsageLimitStop[] = [];
    for (const stop of stops) {
      const candidate = [...batch, stop];
      const text = usageLimitStopNoticeText({
        stops: candidate,
        coordinator: { kind: "unaffected" },
        followUp: true,
      });
      if (Buffer.byteLength(text.body, "utf8") > AGENT_MAIL_MAX_BODY_BYTES - 8192) {
        if (!batch.length) throw new Error("A usage-limit stop exceeds the mail budget.");
        break;
      }
      batch.push(stop);
    }
    return batch;
  }

  /** Send a window's unsent stops. Only the window's first message can wake. */
  private async flush(id: string): Promise<void> {
    const claimed = this.update(id, (group) => {
      // Older backends may have claimed an oversized batch that mail could never accept.
      // Only split provably unsendable batches; all other retries keep their exact IDs.
      if (group.sending) {
        const prior = group.stops.filter((stop) => group.sending!.stopIds.includes(stop.id));
        if (
          prior.length &&
          Buffer.byteLength(
            usageLimitStopNoticeText({
              stops: prior,
              coordinator: { kind: "unaffected" },
              followUp: false,
            }).body,
            "utf8",
          ) > AGENT_MAIL_MAX_BODY_BYTES
        ) {
          group.sending.stopIds = this.boundedBatch(prior).map((stop) => stop.id);
        }
      }
      const sending = group.sending ?? {
        index: group.flushes,
        stopIds: this.boundedBatch(unsent(group)).map((stop) => stop.id),
      };
      group.sending = sending;
      return structuredClone({ group, sending });
    });
    if (!claimed || claimed.sending.stopIds.length === 0) {
      this.update(id, (group) => {
        delete group.sending;
      });
      return;
    }
    const { group, sending } = claimed;
    const stops = group.stops.filter((stop) => sending.stopIds.includes(stop.id));
    const first = sending.index === 0;
    const settings = normalizeAgentMessagingSettings(
      (await this.deps.storage.loadConfig()).global.agentMessaging,
    );
    const quiet = settings.coordinatorStatusWakes === "off";
    // A window that ended while this backend was down is older state, not a new event.
    const windowOpen = group.windowEndsAt > this.now();
    // A later stop also starts a main if the one woken has since closed. It is filed
    // there without a wake, so the window still costs one turn and the stop is not lost.
    const target = await this.deps.router.mainFor(group.projectId, !quiet && windowOpen);
    if (!target) {
      // Nobody to file it with and no leave to start anyone: the window ends with it.
      this.update(id, (current) => {
        current.sentStopIds.push(...sending.stopIds);
        delete current.sending;
      });
      return;
    }
    const coordinator =
      first && !quiet && windowOpen
        ? await this.coordinatorSituation(group, target.main, target.workspace.id)
        : ({ kind: "unaffected" } as const);
    const { subject, body } = usageLimitStopNoticeText({
      stops,
      coordinator,
      followUp: !first,
    });
    const keepWithoutWake =
      coordinator.kind === "kept"
        ? USAGE_LIMIT_NOTICE_KEPT_REASON
        : quiet
          ? USAGE_LIMIT_NOTICE_QUIET_REASON
          : !first || !windowOpen
            ? USAGE_LIMIT_NOTICE_COALESCED_REASON
            : undefined;
    const lead = stops[0]!;
    try {
      await this.deps.storage.sendAgentMail(
        {
          kind: "system",
          projectId: group.projectId,
          source: "workflow",
          resourceId: `usage-limit:${lead.account.platform}`,
        },
        {
          requestId: `usage-limit:${group.id}:${sending.index}`,
          toEnvironmentId: coordinatorRuntimeId(target.workspace.id, target.main.id),
          toTabId: target.main.tabId,
          subject,
          body,
        },
        {
          notice: {
            resource: {
              kind: "agent-tab",
              id: lead.tabId ?? lead.environmentId,
              environmentId: lead.environmentId,
              ...(lead.tabId ? { tabId: lead.tabId } : {}),
              label: (lead.environmentName ?? lead.session).slice(0, 120),
            },
            state: "usage-limit-stop",
            tone: "attention",
          },
          ...(keepWithoutWake ? { keepWithoutWake } : {}),
        },
      );
    } catch (error) {
      if (!(error instanceof AgentMailError && error.code === "idempotency-conflict")) throw error;
    }
    const more = this.update(id, (current) => {
      current.sentStopIds.push(...sending.stopIds);
      current.flushes = Math.max(current.flushes, sending.index + 1);
      delete current.sending;
      if (coordinator.kind === "kept") current.keptReason = coordinator.reason;
      return unsent(current).length > 0 ? current.flushAt : undefined;
    });
    if (more !== undefined) this.schedule(id, more);
  }

  /** Whether the coordinator can run, moving this machine first when it is the limited login. */
  private async coordinatorSituation(
    group: UsageLimitNoticeGroup,
    main: { id: string; agent?: string | null | undefined },
    coordinatorId: string,
  ): Promise<
    | { kind: "unaffected" }
    | { kind: "moved"; to: string }
    | { kind: "kept"; reason: CoordinatorAccountKeptReason }
  > {
    if (!main.agent) return { kind: "unaffected" };
    const key = await this.deps.coordinatorAccountKey(
      coordinatorRuntimeId(coordinatorId, main.id),
      main.agent,
    );
    if (key !== group.accountKey) return { kind: "unaffected" };
    const platform = group.stops[0]!.account.platform;
    const move = await this.deps.moveOff(platform, group.accountKey, {
      quietProjectId: group.projectId,
    });
    if (!move.moved) return { kind: "kept", reason: move.reason };
    // An idle bridge moves on its next use. One with live work keeps its login until
    // that work ends, so a turn woken now would still run on the limited account.
    const after = await this.deps.coordinatorAccountKey(
      coordinatorRuntimeId(coordinatorId, main.id),
      main.agent,
    );
    return after === group.accountKey
      ? { kind: "kept", reason: "coordinator-busy" }
      : { kind: "moved", to: move.to };
  }

  /** Which repository and session a report is about. */
  private async placeOf(report: UsageLimitStopReport): Promise<{
    projectId: string;
    repository: string;
    environmentName?: string;
    session: string;
    kind: UsageLimitStop["sessionKind"];
  } | null> {
    const { storage } = this.deps;
    const coordinatorId = coordinatorIdFromRuntimeId(report.environmentId);
    if (coordinatorId) {
      const workspace = await storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
      if (!workspace) return null;
      const project = await storage.getProject(workspace.projectId).catch(() => null);
      return {
        projectId: workspace.projectId,
        repository: project?.name ?? workspace.projectId,
        session: "Coordinator",
        kind: "coordinator",
      };
    }
    const environment = await storage.getEnvironment(report.environmentId).catch(() => null);
    if (!environment) return null;
    const project = await storage.getProject(environment.projectId).catch(() => null);
    const place = {
      projectId: environment.projectId,
      repository: project?.name ?? environment.projectId,
      environmentName: environment.name,
    };
    if (report.session?.label) {
      return { ...place, session: report.session.label, kind: "pipeline" };
    }
    const tabId = report.session?.tabId;
    const mailbox = tabId
      ? await storage
          .getAgentMailMailbox(report.environmentId, tabId, { limit: 1 })
          .catch(() => null)
      : null;
    const associations = await storage.coordinators
      .listCoordinatorWorkflowAssociations(environment.projectId)
      .catch(() => []);
    const delegated = associations.some(
      (association) =>
        association.kind === "environment" &&
        !association.nodeId &&
        association.resourceId === report.environmentId &&
        association.delegation?.workerTabId === tabId,
    );
    return {
      ...place,
      session: mailbox?.descriptor.displayName || tabId || "session",
      kind: delegated ? "worker" : "tab",
    };
  }
}
