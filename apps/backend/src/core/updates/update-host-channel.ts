/**
 * The backend side of the host protocol: the process that installs this
 * backend (Electron main or the headless supervisor) registers over the
 * loopback control listener, receives `update-host-request` events, and
 * reports progress and outcomes back.
 *
 * Requests stay outstanding until the host answers, independent of the host
 * session, so a host that reconnects (and re-registers) receives them again
 * from the registration reply: a missed event is never fatal.
 */
import {
  UPDATE_HOST_PROTOCOL_VERSION,
  UPDATE_HOST_REQUEST_EVENT,
  type UpdateHostInfo,
  type UpdateHostRegistration,
  type UpdateHostReport,
  type UpdateHostRequest,
} from "@orkestrator/protocol/updates";

export class UpdateHostError extends Error {
  constructor(
    readonly code:
      | "no-host"
      | "host-session-expired"
      | "unknown-request"
      | "host-failed"
      | "host-timeout"
      | "host-replaced"
      | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "UpdateHostError";
  }
}

type Outstanding = {
  request: UpdateHostRequest;
  /** Reset on every progress report; a stalled host fails the request. */
  stallMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve(): void;
  reject(error: UpdateHostError): void;
  onProgress?(report: UpdateHostReport): void;
};

export type UpdateHostChannelOptions = {
  emit(event: string, payload: unknown): void;
  randomId(): string;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  /** What status says when no host has registered. */
  unregisteredReason: string;
};

export class UpdateHostChannel {
  private registration: (UpdateHostRegistration & { hostSessionId: string }) | null = null;
  private readonly outstanding = new Map<string, Outstanding>();

  constructor(private readonly options: UpdateHostChannelOptions) {}

  info(): UpdateHostInfo {
    const registration = this.registration;
    if (!registration) {
      return {
        kind: "none",
        installKind: null,
        canInstall: false,
        unavailableReason: this.options.unregisteredReason,
        hostVersion: null,
        protocolVersion: null,
      };
    }
    const unavailableReason =
      registration.unavailableReason ??
      (registration.capabilities.install ? null : "This installation cannot update itself.");
    return {
      kind: registration.hostKind,
      installKind: registration.installKind,
      canInstall: unavailableReason === null,
      unavailableReason,
      hostVersion: registration.hostVersion,
      protocolVersion: registration.protocolVersion,
    };
  }

  currentRegistration(): (UpdateHostRegistration & { hostSessionId: string }) | null {
    return this.registration;
  }

  /** Registers (or re-registers) the host and hands it every outstanding request. */
  register(registration: UpdateHostRegistration): {
    hostSessionId: string;
    protocolVersion: number;
    pending: UpdateHostRequest[];
  } {
    if (registration.protocolVersion < 1) throw new Error("Unsupported host protocol version");
    const hostSessionId = this.options.randomId();
    this.registration = { ...registration, hostSessionId };
    return {
      hostSessionId,
      protocolVersion: Math.min(registration.protocolVersion, UPDATE_HOST_PROTOCOL_VERSION),
      pending: this.pending(),
    };
  }

  pending(): UpdateHostRequest[] {
    return [...this.outstanding.values()].map((entry) => entry.request);
  }

  assertSession(hostSessionId: string): void {
    if (!this.registration || this.registration.hostSessionId !== hostSessionId) {
      throw new UpdateHostError(
        "host-session-expired",
        "This host session is no longer current; register again",
      );
    }
  }

  /**
   * Sends a request and resolves when the host reports success. A failure
   * report, a stall longer than `stallMs` without progress, or a cancellation
   * rejects it.
   */
  send(
    request: UpdateHostRequest,
    options: { stallMs: number; onProgress?(report: UpdateHostReport): void },
  ): Promise<void> {
    if (!this.registration) {
      return Promise.reject(new UpdateHostError("no-host", this.options.unregisteredReason));
    }
    return new Promise<void>((resolve, reject) => {
      const entry: Outstanding = {
        request,
        stallMs: options.stallMs,
        timer: null,
        resolve,
        reject,
        onProgress: options.onProgress,
      };
      this.outstanding.set(request.requestId, entry);
      this.arm(entry);
      this.options.emit(UPDATE_HOST_REQUEST_EVENT, {
        hostSessionId: this.registration!.hostSessionId,
        request,
      });
    });
  }

  private arm(entry: Outstanding): void {
    if (entry.timer) this.options.clearTimeout(entry.timer);
    entry.timer = this.options.setTimeout(() => {
      this.settle(entry.request.requestId, () =>
        entry.reject(
          new UpdateHostError(
            "host-timeout",
            `The installer did not report on ${entry.request.kind} in time`,
          ),
        ),
      );
    }, entry.stallMs);
  }

  private settle(requestId: string, action: () => void): void {
    const entry = this.outstanding.get(requestId);
    if (!entry) return;
    this.outstanding.delete(requestId);
    if (entry.timer) this.options.clearTimeout(entry.timer);
    action();
  }

  report(report: UpdateHostReport): void {
    this.assertSession(report.hostSessionId);
    const entry = this.outstanding.get(report.requestId);
    if (!entry || entry.request.jobId !== report.jobId) {
      throw new UpdateHostError("unknown-request", "No such outstanding update request");
    }
    if (report.status === "progress") {
      this.arm(entry);
      entry.onProgress?.(report);
      return;
    }
    if (report.status === "succeeded") {
      this.settle(report.requestId, () => entry.resolve());
      return;
    }
    this.settle(report.requestId, () =>
      entry.reject(
        new UpdateHostError(
          "host-failed",
          `${report.error?.code ?? "failed"}: ${report.error?.message ?? "The installer reported a failure"}`,
        ),
      ),
    );
  }

  /** Rejects every outstanding request of a job (cancel, or the job failed elsewhere). */
  abandonJob(jobId: string, error: UpdateHostError): void {
    for (const [requestId, entry] of Array.from(this.outstanding)) {
      if (entry.request.jobId !== jobId) continue;
      this.settle(requestId, () => entry.reject(error));
    }
  }

  dispose(): void {
    for (const [requestId, entry] of Array.from(this.outstanding)) {
      this.settle(requestId, () =>
        entry.reject(new UpdateHostError("cancelled", "The backend is shutting down")),
      );
    }
  }
}
