/**
 * The update workflow, owned by the backend on every kind of machine: channel
 * resolution, manifest verification, consent, the job state machine, audit and
 * progress events. The platform-specific install is delegated to the host
 * (Electron main or the headless supervisor) over {@link UpdateHostChannel}.
 *
 * One implementation serves the local renderer, remote clients, the hosted web
 * client and the CLI. Design: docs/architecture/release-channels-and-updates.md.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_RELEASE_CHANNEL,
  isReleaseChannel,
  releaseChannelOfVersion,
  resolveChannelUpdate,
  type ReleaseChannel,
  type ReleaseChannelEntry,
} from "@orkestrator/protocol/release-channels";
import {
  actionsOnHost,
  checkConsent,
  diffReleaseRequirements,
  UPDATE_PROTOCOL_VERSION,
  type ReleaseRequirements,
  type ReleaseRequirementsDiffContext,
} from "@orkestrator/protocol/release-requirements";
import {
  advanceUpdateJobTo,
  transitionUpdateJob,
  type UpdateJobEvent,
} from "@orkestrator/protocol/update-job";
import {
  isCancellableUpdatePhase,
  isTerminalUpdatePhase,
  UPDATE_STATUS_EVENT,
  type GatewayStatusPayload,
  type UpdateAuditEntry,
  type UpdateCheckState,
  type UpdateHostOutcome,
  type UpdateHostRegistration,
  type UpdateHostReport,
  type UpdateHostRequest,
  type UpdateJob,
  type UpdateJobError,
  type UpdateJobStep,
  type UpdateNotice,
  type UpdateOffer,
  type UpdateRequester,
  type UpdateStartArgs,
  type UpdateStatusSnapshot,
} from "@orkestrator/protocol/updates";
import { UpdateFeedError, type UpdateFeed } from "./update-feed.js";
import { UpdateFiles, MAX_NOTICES } from "./update-files.js";
import { UpdateHostChannel, UpdateHostError } from "./update-host-channel.js";

export const INITIAL_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A download that reports no progress for this long has stalled. */
export const PREPARE_STALL_MS = 10 * 60 * 1000;
/** Time for the host to begin a restart once asked to install. */
export const INSTALL_START_MS = 2 * 60 * 1000;
/** Time after a restart for the host to report how it went. */
export const OUTCOME_WAIT_MS = 10 * 60 * 1000;

export type UpdateErrorCode =
  | "invalid-request"
  | "job-in-progress"
  | "no-job"
  | "no-host"
  | "updates-disabled"
  | "stale-target"
  | "consent-missing"
  | "blocked"
  | "not-cancellable"
  | "not-ready"
  | "forbidden";

/** Command errors carry a parseable code: `UpdateError:<code>: <message>`. */
export class UpdateCommandError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    message: string,
  ) {
    super(`UpdateError:${code}: ${message}`);
    this.name = "UpdateCommandError";
  }
}

export type UpdateDependencies = {
  /** The local default image, for the container-capability diff (phase 3). */
  inspectLocalImage?(): Promise<ReleaseRequirementsDiffContext["localImage"]>;
  /** Fetches and verifies what the target needs before restarting (phase 3). */
  prefetch?(
    manifest: ReleaseRequirements,
    job: UpdateJob,
    report: (percent: number | null, message: string | null) => void,
  ): Promise<void>;
  /** Runs on the old version right before handing over to the host. */
  beforeInstall?(manifest: ReleaseRequirements, job: UpdateJob): Promise<void>;
};

export type UpdateServiceOptions = {
  dataDir: string;
  currentVersion: string;
  platform: string;
  arch: string;
  feed: UpdateFeed;
  emit(event: string, payload: unknown): void;
  readOwnRequirements(): ReleaseRequirements | null;
  readChannel(): Promise<unknown>;
  writeChannel(channel: ReleaseChannel): Promise<void>;
  storageSchemaVersion(): number | null;
  /** Periodic checks; off in dev and agent-test runs and under the opt-out. */
  automaticChecks: boolean;
  /** Installs are refused entirely (the managed-install opt-out). */
  disabledReason?: string | null;
  dependencies?: UpdateDependencies;
  files?: UpdateFiles;
  now?: () => Date;
  randomId?: () => string;
  timers?: {
    setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
    setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
    clearInterval(timer: ReturnType<typeof setInterval>): void;
  };
  log?: Pick<Console, "info" | "warn">;
};

type CachedOffer = { offer: UpdateOffer; manifest: ReleaseRequirements };

function describe(error: unknown): { code: string; message: string } {
  if (error instanceof UpdateFeedError || error instanceof UpdateHostError) {
    return { code: error.code, message: error.message };
  }
  return { code: "unexpected", message: error instanceof Error ? error.message : String(error) };
}

export class UpdateService {
  readonly host: UpdateHostChannel;
  private readonly files: UpdateFiles;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly timers: NonNullable<UpdateServiceOptions["timers"]>;
  private readonly log: Pick<Console, "info" | "warn">;
  private revision = 0;
  private channel: ReleaseChannel = DEFAULT_RELEASE_CHANNEL;
  private checkState: UpdateCheckState = {
    status: "never",
    checkedAt: null,
    error: null,
    resolution: null,
  };
  private available: CachedOffer | null = null;
  private downgradeOption: CachedOffer | null = null;
  private job: UpdateJob | null = null;
  private notices: UpdateNotice[] = [];
  private checkInFlight: Promise<UpdateStatusSnapshot> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private outcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private jobManifest: ReleaseRequirements | null = null;
  private stopped = false;

  constructor(private readonly options: UpdateServiceOptions) {
    this.files = options.files ?? new UpdateFiles(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.timers = options.timers ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (timer) => clearTimeout(timer),
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (timer) => clearInterval(timer),
    };
    this.log = options.log ?? console;
    this.host = new UpdateHostChannel({
      emit: options.emit,
      randomId: this.randomId,
      setTimeout: this.timers.setTimeout,
      clearTimeout: this.timers.clearTimeout,
      unregisteredReason:
        "This backend runs without an installer. Restart it with `orkestrator serve --supervised`, or update it by hand.",
    });
  }

  private at(): string {
    return this.now().toISOString();
  }

  /** Loads persisted state, recovers a job a restart interrupted, schedules checks. */
  async start(): Promise<void> {
    this.channel = await this.readChannel();
    const state = this.files.readState();
    this.job = state.job;
    this.notices = state.notices;
    this.recoverJob();
    if (this.options.automaticChecks) {
      const background = () => void this.check().catch(() => undefined);
      this.initialTimer = this.timers.setTimeout(background, INITIAL_CHECK_DELAY_MS);
      this.intervalTimer = this.timers.setInterval(background, CHECK_INTERVAL_MS);
      for (const timer of [this.initialTimer, this.intervalTimer] as Array<{ unref?(): void }>) {
        timer.unref?.();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.initialTimer) this.timers.clearTimeout(this.initialTimer);
    if (this.intervalTimer) this.timers.clearInterval(this.intervalTimer);
    if (this.outcomeTimer) this.timers.clearTimeout(this.outcomeTimer);
    this.host.dispose();
  }

  private async readChannel(): Promise<ReleaseChannel> {
    const stored = await this.options.readChannel().catch(() => null);
    return isReleaseChannel(stored) ? stored : DEFAULT_RELEASE_CHANNEL;
  }

  snapshot(): UpdateStatusSnapshot {
    const job = this.job;
    return {
      revision: this.revision,
      updateProtocol: UPDATE_PROTOCOL_VERSION,
      currentVersion: this.options.currentVersion,
      currentChannel: releaseChannelOfVersion(this.options.currentVersion),
      channel: this.channel,
      platform: this.options.platform,
      arch: this.options.arch,
      host: this.hostInfo(),
      automaticChecks: this.options.automaticChecks,
      check: { ...this.checkState },
      available: this.available?.offer ?? null,
      downgradeOption: this.downgradeOption?.offer ?? null,
      job: job ? structuredClone(job) : null,
      notices: this.notices.map((notice) => structuredClone(notice)),
    };
  }

  private hostInfo() {
    const info = this.host.info();
    if (this.options.disabledReason) {
      return { ...info, canInstall: false, unavailableReason: this.options.disabledReason };
    }
    return info;
  }

  /** The `/__orkestrator/status` additions: authenticated, so the version is fine to disclose. */
  gatewayStatus(): GatewayStatusPayload {
    const host = this.hostInfo();
    return {
      ok: true,
      appVersion: this.options.currentVersion,
      updateProtocol: UPDATE_PROTOCOL_VERSION,
      host: { kind: host.kind, installKind: host.installKind, canInstall: host.canInstall },
      updates: {
        channel: this.channel,
        available: this.available?.offer.version ?? null,
        jobPhase: this.job && !isTerminalUpdatePhase(this.job.phase) ? this.job.phase : null,
      },
    };
  }

  private changed(persist: boolean): void {
    this.revision += 1;
    if (persist) {
      try {
        this.files.writeState({ version: 1, job: this.job, notices: this.notices });
      } catch (error) {
        this.log.warn("[Updates] Could not persist update state:", error);
      }
    }
    this.options.emit(UPDATE_STATUS_EVENT, { revision: this.revision, snapshot: this.snapshot() });
  }

  private audit(
    action: UpdateAuditEntry["action"],
    requester: UpdateRequester | null,
    extra: Partial<UpdateAuditEntry> = {},
  ): void {
    const job = this.job;
    try {
      this.files.appendAudit({
        at: this.at(),
        action,
        jobId: job?.id ?? null,
        fromVersion: job?.fromVersion ?? this.options.currentVersion,
        toVersion: job?.target.version ?? null,
        channel: job?.target.channel ?? this.channel,
        requester,
        ...extra,
      });
    } catch (error) {
      this.log.warn("[Updates] Could not append to the audit log:", error);
    }
  }

  auditLog(limit: number): UpdateAuditEntry[] {
    return this.files.readAudit(limit);
  }

  // ---- Checks ---------------------------------------------------------------

  private async diffContext(
    clientVersion?: string | null,
  ): Promise<ReleaseRequirementsDiffContext> {
    let localImage: ReleaseRequirementsDiffContext["localImage"];
    try {
      localImage = await this.options.dependencies?.inspectLocalImage?.();
    } catch {
      localImage = undefined;
    }
    return {
      currentVersion: this.options.currentVersion,
      platform: this.options.platform,
      storageSchemaVersion: this.options.storageSchemaVersion(),
      clientVersion: clientVersion ?? null,
      localImage,
    };
  }

  private async offer(
    channel: ReleaseChannel,
    entry: ReleaseChannelEntry,
    downgrade: boolean,
  ): Promise<CachedOffer> {
    const { manifest } = await this.options.feed.fetchRequirements(entry);
    const diff = diffReleaseRequirements(
      this.options.readOwnRequirements(),
      manifest,
      await this.diffContext(),
    );
    return {
      manifest,
      offer: {
        version: entry.version,
        tag: entry.tag,
        channel,
        requirementsSha256: entry.requirementsSha256,
        publishedAt: entry.publishedAt,
        diff,
        compatibility: {
          minClientVersion: manifest.compatibility.minClientVersion,
          minBackendVersion: manifest.compatibility.minBackendVersion,
        },
        downgrade,
      },
    };
  }

  /** Runs a check, or joins the one in flight. A failure keeps the last offer. */
  check(): Promise<UpdateStatusSnapshot> {
    this.checkInFlight ??= this.performCheck().finally(() => {
      this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  private async performCheck(): Promise<UpdateStatusSnapshot> {
    this.checkState = { ...this.checkState, status: "checking" };
    this.changed(false);
    try {
      const index = await this.options.feed.fetchIndex();
      const resolution = resolveChannelUpdate({
        index,
        subscribed: this.channel,
        currentVersion: this.options.currentVersion,
      });
      if (resolution.kind === "update") {
        this.available = await this.offer(resolution.channel, resolution.entry, false);
        this.downgradeOption = null;
      } else if (resolution.kind === "waiting-for-channel") {
        this.available = null;
        this.downgradeOption = resolution.newest
          ? await this.offer(resolution.newest.channel, resolution.newest.entry, true)
          : null;
      } else {
        this.available = null;
        this.downgradeOption = null;
      }
      this.checkState = {
        status: "ok",
        checkedAt: this.at(),
        error: null,
        resolution: resolution.kind,
      };
    } catch (error) {
      this.checkState = {
        ...this.checkState,
        status: "failed",
        checkedAt: this.at(),
        error: describe(error),
      };
      this.log.warn(`[Updates] Update check failed: ${describe(error).message}`);
    }
    this.changed(false);
    return this.snapshot();
  }

  async setChannel(channel: unknown, requester: UpdateRequester): Promise<UpdateStatusSnapshot> {
    if (!isReleaseChannel(channel)) {
      throw new UpdateCommandError("invalid-request", "channel must be stable, beta or unstable");
    }
    await this.options.writeChannel(channel);
    const previous = this.channel;
    this.channel = channel;
    this.available = null;
    this.downgradeOption = null;
    this.audit("set-channel", requester, { channel, detail: `from ${previous}` });
    this.changed(false);
    return this.check();
  }

  // ---- Jobs -----------------------------------------------------------------

  private assertNoActiveJob(): void {
    if (this.job && !isTerminalUpdatePhase(this.job.phase)) {
      throw new UpdateCommandError("job-in-progress", "An update is already in progress");
    }
  }

  async startJob(args: UpdateStartArgs, requester: UpdateRequester): Promise<UpdateStatusSnapshot> {
    if (this.options.disabledReason) {
      throw new UpdateCommandError("updates-disabled", this.options.disabledReason);
    }
    this.assertNoActiveJob();
    const host = this.hostInfo();
    if (!host.canInstall) {
      throw new UpdateCommandError(
        "no-host",
        host.unavailableReason ?? "No installer is available",
      );
    }
    const downgrade = args.allowDowngrade === true;
    const pick = () => (downgrade ? this.downgradeOption : this.available);
    let target = pick();
    if (
      !target ||
      target.offer.version !== args.targetVersion ||
      target.offer.requirementsSha256 !== args.requirementsSha256
    ) {
      // The client may have shown an offer older than our last check, or we
      // restarted since; consent is only valid for the exact manifest bytes.
      await this.check();
      target = pick();
    }
    if (
      !target ||
      target.offer.version !== args.targetVersion ||
      target.offer.requirementsSha256 !== args.requirementsSha256
    ) {
      throw new UpdateCommandError(
        "stale-target",
        "The offered update changed; review what it needs again",
      );
    }
    this.assertNoActiveJob();
    const diff = diffReleaseRequirements(
      this.options.readOwnRequirements(),
      target.manifest,
      await this.diffContext(args.client?.version ?? null),
    );
    const consent = checkConsent(diff, args.approvedConsentIds);
    if (!consent.ok) {
      if (consent.reason === "blocked") {
        const blocker = diff.items.find((item) => item.blocking);
        throw new UpdateCommandError("blocked", blocker?.title ?? consent.blockers.join(", "));
      }
      throw new UpdateCommandError(
        "consent-missing",
        `Not approved: ${consent.missing.join(", ")}`,
      );
    }
    const at = this.at();
    this.job = {
      id: this.randomId(),
      fromVersion: this.options.currentVersion,
      target: {
        version: target.offer.version,
        tag: target.offer.tag,
        channel: target.offer.channel,
        requirementsSha256: target.offer.requirementsSha256,
      },
      approvedConsentIds: [...new Set(args.approvedConsentIds)].sort(),
      restartPolicy: args.restartPolicy,
      downgrade,
      phase: "approved",
      createdAt: at,
      updatedAt: at,
      requester,
      progress: null,
      error: null,
      rollbackFailed: false,
      actionsOnHost: actionsOnHost(diff),
      storageSchemaVersion: this.options.storageSchemaVersion(),
      installWhen: null,
    };
    this.jobManifest = target.manifest;
    this.audit("start", requester, {
      approvedConsentIds: this.job.approvedConsentIds,
      requirementsSha256: this.job.target.requirementsSha256,
      detail: downgrade ? "downgrade" : undefined,
    });
    this.changed(true);
    void this.runJob(this.job.id);
    return this.snapshot();
  }

  private apply(jobId: string, event: UpdateJobEvent, persist = true): boolean {
    if (!this.job || this.job.id !== jobId) return false;
    this.job = transitionUpdateJob(this.job, event, this.at());
    this.changed(persist && event.type !== "progress");
    return true;
  }

  private progress(
    jobId: string,
    step: UpdateJobStep,
    percent: number | null,
    message: string | null,
  ): void {
    if (!this.job || this.job.id !== jobId || isTerminalUpdatePhase(this.job.phase)) return;
    this.apply(jobId, { type: "progress", step, percent, message }, false);
  }

  /**
   * Whether this process may still move the job. A stopping backend never
   * does: shutting down is what an install does to it, and the outcome is the
   * next process's to record (`recoverJob`, `hostOutcome`).
   */
  private isCurrent(jobId: string): boolean {
    return !this.stopped && this.job?.id === jobId && !isTerminalUpdatePhase(this.job.phase);
  }

  private async runJob(jobId: string): Promise<void> {
    const manifest = this.jobManifest;
    try {
      if (!manifest) throw new Error("The target manifest is missing");
      this.apply(jobId, { type: "fetch-dependencies" });
      await this.options.dependencies?.prefetch?.(manifest, this.job!, (percent, message) =>
        this.progress(jobId, "dependencies", percent, message),
      );
      if (!this.isCurrent(jobId)) return;
      this.apply(jobId, { type: "download" });
      await this.sendToHost(
        {
          kind: "prepare",
          requestId: this.randomId(),
          jobId,
          target: this.job!.target,
          feedBaseUrl: this.options.feed.baseUrl,
          allowDowngrade: this.job!.downgrade,
        },
        PREPARE_STALL_MS,
        "download",
      );
      if (!this.isCurrent(jobId)) return;
      this.apply(jobId, { type: "ready" });
      if (this.job!.restartPolicy === "immediate") await this.install(jobId, "now", null);
    } catch (error) {
      // From `installing` on, `install` settles the job itself.
      if (!this.isCurrent(jobId) || !isCancellableUpdatePhase(this.job!.phase)) return;
      const step = this.job!.phase === "fetching-dependencies" ? "dependencies" : "download";
      this.fail(jobId, { step, ...describe(error) });
    }
  }

  private sendToHost(
    request: UpdateHostRequest,
    stallMs: number,
    step: "download" | "install",
  ): Promise<void> {
    return this.host.send(request, {
      stallMs,
      onProgress: (report: UpdateHostReport) => {
        if (request.kind === "install" && report.progress?.message === "restarting") {
          if (this.job?.id === request.jobId && this.job.phase === "installing") {
            this.apply(request.jobId, { type: "restarting" });
          }
          return;
        }
        this.progress(
          request.jobId,
          step,
          report.progress?.percent ?? null,
          report.progress?.message ?? null,
        );
      },
    });
  }

  private fail(jobId: string, error: UpdateJobError): void {
    if (!this.isCurrent(jobId)) return;
    this.host.abandonJob(jobId, new UpdateHostError("cancelled", "The update failed"));
    this.apply(jobId, { type: "fail", error });
    this.finish("failed", error.message);
  }

  private finish(action: "succeeded" | "failed" | "rolled-back" | "cancelled", detail?: string) {
    const job = this.job!;
    this.audit(action, null, { detail });
    if (action === "cancelled") return;
    const notice = (
      kind: UpdateNotice["kind"],
      message: string,
      items = [] as UpdateNotice["items"],
    ) => ({
      id: this.randomId(),
      kind,
      jobId: job.id,
      version: job.target.version,
      createdAt: this.at(),
      message,
      items,
    });
    if (action === "succeeded") {
      this.notices.push(notice("update-succeeded", `Updated to ${job.target.version}.`));
      if (job.actionsOnHost.length > 0) {
        this.notices.push(
          notice(
            "action-needed-on-host",
            `${job.target.version} needs someone at this machine to finish setting it up.`,
            job.actionsOnHost,
          ),
        );
      }
    } else if (action === "rolled-back") {
      this.notices.push(
        notice(
          "update-rolled-back",
          `The update to ${job.target.version} failed and ${job.fromVersion} was restored: ${job.error?.message ?? "unknown error"}`,
        ),
      );
    } else {
      this.notices.push(
        notice(
          "update-failed",
          job.rollbackFailed
            ? `The update to ${job.target.version} failed and the previous version could not be restored: ${job.error?.message ?? ""}`
            : `The update to ${job.target.version} failed; nothing was changed: ${job.error?.message ?? ""}`,
        ),
      );
    }
    this.notices = this.notices.slice(-MAX_NOTICES);
    this.changed(true);
  }

  async installNow(jobId: unknown, requester: UpdateRequester): Promise<UpdateStatusSnapshot> {
    if (typeof jobId !== "string" || !this.job || this.job.id !== jobId) {
      throw new UpdateCommandError("no-job", "No such update job");
    }
    if (this.job.phase !== "ready") {
      throw new UpdateCommandError("not-ready", "The update is not ready to install");
    }
    await this.install(jobId, "now", requester);
    return this.snapshot();
  }

  /** Arms install-on-quit (desktop "Later"): the job stays ready until the app quits. */
  async installOnQuit(jobId: unknown, requester: UpdateRequester): Promise<UpdateStatusSnapshot> {
    if (typeof jobId !== "string" || !this.job || this.job.id !== jobId) {
      throw new UpdateCommandError("no-job", "No such update job");
    }
    if (this.job.phase !== "ready") {
      throw new UpdateCommandError("not-ready", "The update is not ready to install");
    }
    if (!this.host.currentRegistration()?.capabilities.restart.includes("on-quit")) {
      throw new UpdateCommandError("invalid-request", "This installation cannot install on quit");
    }
    await this.install(jobId, "on-quit", requester);
    return this.snapshot();
  }

  private async install(
    jobId: string,
    when: "now" | "on-quit",
    requester: UpdateRequester | null,
  ): Promise<void> {
    const manifest = this.jobManifest;
    if (!this.job || this.job.id !== jobId || !manifest) return;
    try {
      await this.options.dependencies?.beforeInstall?.(manifest, this.job);
    } catch (error) {
      this.fail(jobId, { step: "install", ...describe(error) });
      return;
    }
    const request: UpdateHostRequest = {
      kind: "install",
      requestId: this.randomId(),
      jobId,
      target: this.job.target,
      fromVersion: this.job.fromVersion,
      restart: when,
      storageSchemaVersion: this.job.storageSchemaVersion,
    };
    this.audit("install", requester, { detail: when === "on-quit" ? "on quit" : undefined });
    if (when === "on-quit") {
      this.job = { ...this.job, installWhen: "on-quit", updatedAt: this.at() };
      this.changed(true);
      try {
        await this.sendToHost(request, INSTALL_START_MS, "install");
      } catch (error) {
        this.fail(jobId, { step: "install", ...describe(error) });
      }
      return;
    }
    this.job = { ...this.job, installWhen: "now" };
    this.apply(jobId, { type: "install" });
    try {
      // The host answers once the restart is under way; this process may be
      // gone before the promise settles, which is why the state is persisted.
      await this.sendToHost(request, INSTALL_START_MS, "install");
    } catch (error) {
      // Once the host said it is restarting, only the next process can tell
      // how that went.
      if (!this.isCurrent(jobId) || this.job!.phase !== "installing") return;
      // Nothing was replaced: the host failed before restarting, so the old
      // version is what is running. That is a rollback with nothing to undo.
      this.apply(jobId, { type: "roll-back", error: { step: "install", ...describe(error) } });
      this.finish("rolled-back", describe(error).message);
    }
  }

  async cancel(jobId: unknown, requester: UpdateRequester): Promise<UpdateStatusSnapshot> {
    if (typeof jobId !== "string" || !this.job || this.job.id !== jobId) {
      throw new UpdateCommandError("no-job", "No such update job");
    }
    if (!isCancellableUpdatePhase(this.job.phase)) {
      throw new UpdateCommandError("not-cancellable", "The update is already installing");
    }
    const job = this.job;
    const pending = this.host.pending().some((request) => request.jobId === job.id);
    this.host.abandonJob(job.id, new UpdateHostError("cancelled", "Cancelled"));
    if (pending) {
      void this.host
        .send({ kind: "cancel", requestId: this.randomId(), jobId: job.id }, { stallMs: 60_000 })
        .catch(() => undefined);
    }
    this.apply(job.id, { type: "cancel" });
    this.audit("cancel", requester);
    this.finish("cancelled");
    return this.snapshot();
  }

  acknowledgeNotice(noticeId: unknown): UpdateStatusSnapshot {
    if (typeof noticeId !== "string") {
      throw new UpdateCommandError("invalid-request", "noticeId must be a string");
    }
    const before = this.notices.length;
    this.notices = this.notices.filter((notice) => notice.id !== noticeId);
    if (this.notices.length !== before) this.changed(true);
    return this.snapshot();
  }

  // ---- Host protocol --------------------------------------------------------

  registerHost(registration: UpdateHostRegistration) {
    const reply = this.host.register(registration);
    this.changed(false);
    return reply;
  }

  hostReport(report: UpdateHostReport): void {
    this.host.report(report);
  }

  /** The outcome of the restart an install caused, reported by the new (or restored) host. */
  hostOutcome(outcome: UpdateHostOutcome): UpdateStatusSnapshot {
    this.host.assertSession(outcome.hostSessionId);
    const job = this.job;
    if (!job || job.id !== outcome.jobId) {
      throw new UpdateCommandError("no-job", "No such update job");
    }
    if (isTerminalUpdatePhase(job.phase)) return this.snapshot();
    if (
      outcome.outcome === "failed" &&
      !outcome.rollbackFailed &&
      isCancellableUpdatePhase(job.phase)
    ) {
      // An install-on-quit that never applied: nothing changed.
      this.fail(job.id, {
        step: "install",
        code: outcome.error?.code ?? "install-not-applied",
        message: outcome.error?.message ?? "The update was not installed",
      });
      return this.snapshot();
    }
    this.clearOutcomeTimer();
    const at = this.at();
    this.job = advanceUpdateJobTo(job, "verifying", at);
    const error: UpdateJobError = {
      step: "health",
      code: outcome.error?.code ?? "unhealthy",
      message: outcome.error?.message ?? "The new version did not start correctly",
    };
    if (outcome.outcome === "succeeded") {
      this.apply(job.id, { type: "succeed" });
      this.finish("succeeded");
    } else if (outcome.outcome === "rolled-back" || !outcome.rollbackFailed) {
      // A failure that left the old version running is a rollback with
      // nothing to undo (the install never applied).
      this.apply(job.id, { type: "roll-back", error });
      this.finish("rolled-back", error.message);
    } else {
      this.apply(job.id, { type: "fail", error, rollbackFailed: true });
      this.finish("failed", error.message);
    }
    return this.snapshot();
  }

  private clearOutcomeTimer(): void {
    if (this.outcomeTimer) this.timers.clearTimeout(this.outcomeTimer);
    this.outcomeTimer = null;
  }

  /**
   * A restart interrupted the job. Before installing nothing changed, so the
   * job failed; an armed install-on-quit and every phase from `installing`
   * wait for the host's outcome, and decide from the running version if it
   * never arrives.
   */
  private recoverJob(): void {
    const job = this.job;
    if (!job || isTerminalUpdatePhase(job.phase)) return;
    const waiting =
      !isCancellableUpdatePhase(job.phase) ||
      (job.phase === "ready" && job.installWhen === "on-quit");
    if (!waiting) {
      this.apply(job.id, {
        type: "fail",
        error: {
          step: "download",
          code: "interrupted",
          message: "The backend restarted before the update was ready",
        },
      });
      this.finish("failed", "interrupted");
      return;
    }
    this.outcomeTimer = this.timers.setTimeout(() => {
      this.outcomeTimer = null;
      if (
        this.stopped ||
        !this.job ||
        this.job.id !== job.id ||
        isTerminalUpdatePhase(this.job.phase)
      ) {
        return;
      }
      const running = this.options.currentVersion;
      if (running === job.target.version) {
        this.job = advanceUpdateJobTo(this.job, "verifying", this.at());
        this.apply(job.id, { type: "succeed" });
        this.finish("succeeded", "confirmed by the running version; the installer did not report");
      } else if (this.job.phase === "ready") {
        this.fail(job.id, {
          step: "install",
          code: "install-not-applied",
          message: "The update was not installed when the app quit",
        });
      } else {
        this.job = advanceUpdateJobTo(this.job, "verifying", this.at());
        const error = {
          step: "restart" as const,
          code: "install-not-applied",
          message: `${running} is still running; the installer did not report`,
        };
        this.apply(job.id, { type: "roll-back", error });
        this.finish("rolled-back", error.message);
      }
    }, OUTCOME_WAIT_MS);
    (this.outcomeTimer as { unref?(): void }).unref?.();
  }
}
