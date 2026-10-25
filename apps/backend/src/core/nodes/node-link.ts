import {
  BACKEND_CAPABILITIES,
  hasBackendCapability,
  type BackendHello,
} from "@orkestrator/protocol/backend-profile";
import {
  CONTROLLER_HEADER,
  NodeRefusalError,
  orderedNodeRoutes,
  parseNodeRefusal,
  type AttachControllerResult,
  type NodeAttachmentState,
  type NodeConnectionState,
  type NodeConnectionView,
  type NodeMode,
  type NodeRecord,
  type NodeRoute,
} from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  checkBackendRoute,
  isConnectionCheckError,
} from "@orkestrator/protocol/node/node-link/backend-hello";
import {
  classifyRouteFailure,
  openRoute,
  sanitizeDiagnostic,
  type OpenedRoute,
  type SshTunnelProvider,
} from "@orkestrator/protocol/node/node-link/routes";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";

/**
 * The command node's connection to one registered node.
 *
 * Routes are tried in the user's order. Each is verified with the
 * authenticated hello before anything else uses it:
 * - the node must prove the registered identity (a mismatch quarantines the
 *   link: another route is never tried to get around it);
 * - SSH host-key and TLS certificate failures quarantine the same way;
 * - a rejected gateway token stops the link (every route shares it);
 * - ordinary network failures fall through to the next route.
 * After the hello the link (re)asserts the attachment on the node, which is
 * idempotent and refreshes the controller's name and portal origins.
 */

export const NODE_HELLO_TIMEOUT_MS = 10_000;
export const NODE_INVOKE_TIMEOUT_MS = 60_000;
export const NODE_HEARTBEAT_MS = 30_000;
const MAX_INVOKE_RESPONSE_BYTES = 64 * 1024 * 1024;

export class NodeUnavailableError extends Error {
  readonly code = "node-unavailable";
  constructor(message: string) {
    super(message);
    this.name = "NodeUnavailableError";
  }
}

/** The request reached the network but its outcome is not known. */
export class NodeOutcomeUnknownError extends Error {
  readonly code = "outcome-unknown";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NodeOutcomeUnknownError";
  }
}

export interface NodeLinkTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface NodeLinkDeps {
  selfId: BackendId;
  /** Name and client origins the command node registers on its leaves. */
  attachInfo(): Promise<{ displayName: string; portalOrigins: string[] }>;
  fetchImpl?: typeof fetch;
  ssh: SshTunnelProvider | null;
  timers?: NodeLinkTimers;
  heartbeatMs?: number;
  /** Connection state changed; the service republishes `nodes-changed`. */
  onChange(): void;
  /** Durable facts learned from a hello or an attachment, persisted by the service. */
  onVerified(update: {
    hello: BackendHello;
    attachment: NodeAttachmentState;
    connectedAt: string;
  }): void;
  /** A provisional (never verified) record proved its real identity. */
  onIdentity?(installationId: BackendId): Promise<"adopted" | "refused">;
}

interface ActiveRoute {
  route: NodeRoute;
  opened: OpenedRoute;
  hello: BackendHello;
  unsubscribeClosed?: () => void;
  retained?: number;
  detached?: boolean;
}

const defaultTimers: NodeLinkTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class NodeLink {
  private record: NodeRecord;
  private readonly deps: NodeLinkDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly timers: NodeLinkTimers;
  private readonly backoff = new ReconnectBackoff({
    initialDelayMs: 2_000,
    maxDelayMs: 60_000,
    healthyAfterMs: 30_000,
  });
  private state: NodeConnectionState = "connecting";
  private epoch = 0;
  private attempt = 0;
  private active: ActiveRoute | null = null;
  private lastError: { code: string; message: string } | undefined;
  private remoteMode: NodeMode | undefined;
  private retryTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private running = false;
  private connecting: Promise<void> | null = null;
  private connectingAttempt = 0;

  constructor(record: NodeRecord, deps: NodeLinkDeps) {
    this.record = record;
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timers = deps.timers ?? defaultTimers;
    this.state = this.idleState();
  }

  adoptIdentity(nodeId: BackendId): void {
    this.record = { ...this.record, nodeId };
  }

  get nodeId(): BackendId {
    return this.record.nodeId;
  }

  get view(): NodeConnectionView {
    const view: NodeConnectionView = { state: this.state, epoch: this.epoch };
    if (this.active) {
      view.activeRouteId = this.active.route.id;
      view.activeRouteKind = this.active.route.kind;
    }
    if (this.remoteMode) view.remoteMode = this.remoteMode;
    if (this.lastError) view.lastError = { ...this.lastError };
    return view;
  }

  get connected(): boolean {
    return this.state === "connected" && this.active !== null;
  }

  /** The hello of the active route, when connected. */
  get hello(): BackendHello | null {
    return this.active?.hello ?? null;
  }

  /** Start connecting. `interactive` lets SSH prompt the user (a user-initiated connect). */
  start(options: { interactive?: boolean } = {}): Promise<void> {
    this.running = true;
    if (!this.record.enabled || !this.record.credential) {
      this.setState(this.idleState());
      return Promise.resolve();
    }
    return this.connect(options.interactive === true);
  }

  /** Stop and release every transport. Never touches anything on the node. */
  stop(state: NodeConnectionState = "disabled"): void {
    this.running = false;
    this.attempt += 1;
    this.clearTimers();
    this.dropActive();
    this.setState(state);
  }

  /** Routes, credential or enablement changed: reconnect from scratch. */
  update(record: NodeRecord): void {
    const reconnect =
      this.running &&
      (JSON.stringify(record.routes) !== JSON.stringify(this.record.routes) ||
        JSON.stringify(record.routeOrder) !== JSON.stringify(this.record.routeOrder) ||
        record.credential?.token !== this.record.credential?.token ||
        record.enabled !== this.record.enabled ||
        record.nodeId !== this.record.nodeId);
    this.record = record;
    if (!reconnect) return;
    this.attempt += 1;
    this.clearTimers();
    this.dropActive();
    this.lastError = undefined;
    void this.start();
  }

  /** Run one command on the node over the active route. */
  async invoke<T>(
    command: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const active = this.active;
    const token = this.record.credential?.token;
    if (!active || !token || this.state !== "connected") {
      throw new NodeUnavailableError(`${this.label()} is not connected.`);
    }
    return this.request<T>(active.opened.baseUrl, token, command, args, options);
  }

  /**
   * For a forgotten node: verify its identity over the first working route
   * and run one command without attaching (used to confirm a detach).
   */
  async invokeWithoutAttaching<T>(
    command: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const token = this.record.credential?.token;
    if (!token) throw new NodeUnavailableError(`${this.label()} has no credential.`);
    let lastError: unknown = new NodeUnavailableError("No route is enabled.");
    for (const route of orderedNodeRoutes(this.record)) {
      let opened: OpenedRoute | null = null;
      try {
        opened = await openRoute(route, { interactive: false, ssh: this.deps.ssh });
        const outcome = await checkBackendRoute(opened.baseUrl, token, {
          timeoutMs: NODE_HELLO_TIMEOUT_MS,
          fetchImpl: this.fetchImpl,
        });
        if (outcome.kind !== "hello" || outcome.hello.installationId !== this.record.nodeId) {
          throw new NodeUnavailableError("The route reached a different machine.");
        }
        return await this.request<T>(opened.baseUrl, token, command, args, options);
      } catch (error) {
        lastError = error;
        if (
          error instanceof NodeOutcomeUnknownError ||
          classifyRouteFailure(error).quarantine ||
          isCertificateFailure(error)
        )
          break;
      } finally {
        opened?.release();
      }
    }
    throw lastError;
  }

  /** Base URL and headers for a relayed request (M2). Never sent to clients. */
  transport(): { baseUrl: string; headers: Record<string, string> } | null {
    const token = this.record.credential?.token;
    if (!this.active || !token || this.state !== "connected") return null;
    return {
      baseUrl: this.active.opened.baseUrl,
      headers: { authorization: `Bearer ${token}`, [CONTROLLER_HEADER]: this.deps.selfId },
    };
  }

  private label(): string {
    return this.record.profileCache?.displayName ?? this.record.fallbackName;
  }

  private idleState(): NodeConnectionState {
    if (!this.record.enabled) return "disabled";
    if (!this.record.credential) return "needs-credential";
    return "connecting";
  }

  private connect(interactive: boolean): Promise<void> {
    if (this.connecting) {
      if (this.connectingAttempt === this.attempt) return this.connecting;
      return this.connecting.then(() => {
        if (this.running) return this.connect(interactive);
      });
    }
    const run = this.connectOnce(interactive).finally(() => {
      if (this.connecting === run) this.connecting = null;
    });
    this.connecting = run;
    this.connectingAttempt = this.attempt;
    return run;
  }

  private async connectOnce(interactive: boolean): Promise<void> {
    const attempt = ++this.attempt;
    const token = this.record.credential?.token;
    if (!token) {
      this.setState("needs-credential");
      return;
    }
    this.clearTimers();
    this.dropActive();
    this.setState("connecting");
    const routes = orderedNodeRoutes(this.record);
    if (routes.length === 0) {
      this.fail("unavailable", { code: "no-route", message: "No route is enabled." }, false);
      return;
    }
    let lastFailure: { code: string; message: string } | undefined;
    for (const route of routes) {
      if (attempt !== this.attempt) return;
      let opened: OpenedRoute | null = null;
      try {
        opened = await openRoute(route, { interactive, ssh: this.deps.ssh });
        const outcome = await checkBackendRoute(opened.baseUrl, token, {
          timeoutMs: NODE_HELLO_TIMEOUT_MS,
          fetchImpl: this.fetchImpl,
        });
        if (attempt !== this.attempt) {
          opened.release();
          return;
        }
        if (outcome.kind !== "hello") {
          opened.release();
          this.fail("needs-update", needsUpdate(), false);
          return;
        }
        const hello = outcome.hello;
        if (hello.endpointRole !== "client") {
          opened.release();
          this.fail(
            "quarantined",
            {
              code: "control-endpoint",
              message:
                "The route reaches the node's control listener. Point it at a client endpoint.",
            },
            false,
          );
          return;
        }
        if (hello.installationId !== this.record.nodeId) {
          const adopted =
            this.record.nodeId.startsWith("provisional:") && this.deps.onIdentity
              ? await this.deps.onIdentity(hello.installationId)
              : "refused";
          if (adopted !== "adopted") {
            opened.release();
            this.fail(
              "quarantined",
              {
                code: "identity-mismatch",
                message: "The route reached a different machine than the one registered.",
              },
              false,
            );
            return;
          }
          // The service re-keys this live link; keep the interactive SSH lease.
          if (attempt !== this.attempt) {
            opened.release();
            return;
          }
        }
        if (!hasBackendCapability(hello, BACKEND_CAPABILITIES.nodeAttachment)) {
          opened.release();
          this.fail("needs-update", needsUpdate(), false);
          return;
        }
        const attachment = await this.attach(opened.baseUrl, token);
        if (attempt !== this.attempt) {
          opened.release();
          return;
        }
        const connectedAt = new Date().toISOString();
        this.deps.onVerified({ hello, attachment: attachment.state, connectedAt });
        if (attachment.state.status !== "attached") {
          opened.release();
          this.fail(
            "unavailable",
            {
              code: attachment.state.reason ?? "attachment-refused",
              message: attachment.message ?? "The node refused the attachment.",
            },
            false,
          );
          return;
        }
        this.remoteMode = attachment.mode;
        this.active = { route, opened, hello };
        if (opened.onClosed) {
          this.active.unsubscribeClosed = opened.onClosed((failure) => {
            if (this.active?.opened !== opened) return;
            this.lostConnection({
              code: failure.code,
              message: sanitizeDiagnostic(failure.message),
            });
          });
        }
        this.lastError = undefined;
        this.backoff.connected();
        this.epoch += 1;
        this.setState("connected");
        this.scheduleHeartbeat();
        return;
      } catch (error) {
        opened?.release();
        if (attempt !== this.attempt) return;
        if (isCertificateFailure(error)) {
          this.fail(
            "quarantined",
            {
              code: "certificate-failed",
              message:
                "The node's TLS certificate was not trusted. Orkestrator did not try another route.",
            },
            false,
          );
          return;
        }
        const classified = classifyRouteFailure(error);
        const failure = { code: classified.code, message: classified.message };
        if (classified.quarantine) {
          this.fail("quarantined", failure, false);
          return;
        }
        if (isConnectionCheckError(error) && error.code === "authentication-required") {
          this.fail(
            "needs-credential",
            { code: "authentication-required", message: "The node rejected its gateway token." },
            false,
          );
          return;
        }
        if (isConnectionCheckError(error) && error.code === "incompatible") {
          this.fail("needs-update", failure, false);
          return;
        }
        lastFailure = failure;
      }
    }
    this.fail(
      "unavailable",
      lastFailure ?? { code: "unreachable", message: "No route reached the node." },
      true,
    );
  }

  private async attach(
    baseUrl: string,
    token: string,
  ): Promise<{ state: NodeAttachmentState; mode?: NodeMode; message?: string }> {
    const info = await this.deps.attachInfo();
    try {
      const result = await this.request<AttachControllerResult>(
        baseUrl,
        token,
        "attach_controller",
        {
          controllerId: this.deps.selfId,
          displayName: info.displayName,
          portalOrigins: info.portalOrigins,
        },
      );
      return {
        state: {
          status: "attached",
          attachedAt: this.record.attachment.attachedAt ?? new Date().toISOString(),
        },
        mode: result.mode,
      };
    } catch (error) {
      const refusal = parseNodeRefusal(error instanceof Error ? error.message : String(error));
      if (refusal) {
        return { state: { status: "refused", reason: refusal.code }, message: refusal.message };
      }
      throw error;
    }
  }

  private async request<T>(
    baseUrl: string,
    token: string,
    command: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? NODE_INVOKE_TIMEOUT_MS,
    );
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/__orkestrator/invoke", baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [CONTROLLER_HEADER]: this.deps.selfId,
        },
        body: JSON.stringify({ command, args }),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      // Nothing was answered: the command may or may not have run.
      throw new NodeOutcomeUnknownError(
        `The connection to ${this.label()} was lost before it answered.`,
        { cause: error },
      );
    }
    try {
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        if (reader)
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_INVOKE_RESPONSE_BYTES)
              throw new Error("The node's response was too large.");
            chunks.push(value);
          }
      } finally {
        await reader?.cancel().catch(() => undefined);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let payload: { result?: T; error?: unknown } = {};
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        if (response.ok) throw new Error("The node returned malformed JSON.");
      }
      if (response.status === 401) {
        throw new NodeUnavailableError(`${this.label()} rejected its gateway token.`);
      }
      if (!response.ok) {
        const message =
          typeof payload.error === "string"
            ? payload.error
            : `The node answered HTTP ${response.status}.`;
        const refusal = parseNodeRefusal(message);
        if (refusal) throw new NodeRefusalError(refusal.code, refusal.message);
        throw new Error(message);
      }
      if (!payload || typeof payload !== "object" || !("result" in payload)) {
        throw new Error("The node returned an incomplete response.");
      }
      return payload.result as T;
    } catch (error) {
      if (
        (response.ok || response.status >= 500 || controller.signal.aborted) &&
        !(error instanceof NodeRefusalError)
      ) {
        throw new NodeOutcomeUnknownError(`${this.label()} did not finish answering in time.`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private scheduleHeartbeat(): void {
    const ms = this.deps.heartbeatMs ?? NODE_HEARTBEAT_MS;
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = null;
      void this.heartbeat();
    }, ms);
  }

  private async heartbeat(): Promise<void> {
    const active = this.active;
    const token = this.record.credential?.token;
    if (!active || !token || !this.running) return;
    const attempt = this.attempt;
    try {
      const outcome = await checkBackendRoute(active.opened.baseUrl, token, {
        timeoutMs: NODE_HELLO_TIMEOUT_MS,
        fetchImpl: this.fetchImpl,
      });
      if (attempt !== this.attempt || this.active !== active) return;
      if (outcome.kind !== "hello" || outcome.hello.installationId !== this.record.nodeId) {
        this.lostConnection({
          code: "identity-mismatch",
          message: "The route now reaches a different machine.",
        });
        return;
      }
      if (outcome.hello.generation !== active.hello.generation) {
        // The node restarted: re-assert the attachment on a fresh connect.
        this.lostConnection({ code: "restarted", message: "The node restarted." });
        return;
      }
      active.hello = outcome.hello;
      // A user on the node may have detached this command node there.
      const controllers = await this.request<Array<{ controllerId: string }>>(
        active.opened.baseUrl,
        token,
        "list_controllers",
        {},
      );
      if (attempt !== this.attempt || this.active !== active) return;
      if (!controllers.some((entry) => entry.controllerId === this.deps.selfId)) {
        this.lostConnection({
          code: "detached-on-node",
          message: "The node was detached on that machine.",
        });
        return;
      }
      this.scheduleHeartbeat();
    } catch (error) {
      if (attempt !== this.attempt || this.active !== active) return;
      const classified = classifyRouteFailure(error);
      this.lostConnection({ code: classified.code, message: classified.message });
    }
  }

  private lostConnection(failure: { code: string; message: string }): void {
    if (!this.running) return;
    this.attempt += 1;
    this.clearTimers();
    this.dropActive();
    this.backoff.disconnected();
    this.lastError = failure;
    this.setState("connecting");
    void this.connect(false);
  }

  private fail(
    state: NodeConnectionState,
    failure: { code: string; message: string },
    retry: boolean,
  ): void {
    this.dropActive();
    this.lastError = failure;
    this.setState(state);
    if (retry && this.running) {
      const delay = this.backoff.nextDelayMs();
      this.retryTimer = this.timers.setTimeout(() => {
        this.retryTimer = null;
        if (this.running) void this.connect(false);
      }, delay);
    }
  }

  /** Keep the authenticated transport alive even when the registry link stops. */
  retainTransport(): {
    invoke<T>(
      command: string,
      args: Record<string, unknown>,
      options?: { timeoutMs?: number },
    ): Promise<T>;
    release(): void;
  } {
    const active = this.active;
    const token = this.record.credential?.token;
    if (!active || !token || this.state !== "connected")
      throw new NodeUnavailableError(`${this.label()} is not connected. Connect to it first.`);
    active.retained = (active.retained ?? 0) + 1;
    let released = false;
    return {
      invoke: <T>(command: string, args: Record<string, unknown>, options = {}) =>
        this.request<T>(active.opened.baseUrl, token, command, args, options),
      release: () => {
        if (released) return;
        released = true;
        active.retained = (active.retained ?? 1) - 1;
        if (active.detached && active.retained === 0) active.opened.release();
      },
    };
  }

  private dropActive(): void {
    const active = this.active;
    this.active = null;
    if (!active) return;
    active.unsubscribeClosed?.();
    active.detached = true;
    if (!active.retained) active.opened.release();
    this.epoch += 1;
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    if (this.heartbeatTimer !== null) this.timers.clearTimeout(this.heartbeatTimer);
    this.retryTimer = null;
    this.heartbeatTimer = null;
  }

  private setState(state: NodeConnectionState): void {
    this.state = state;
    this.deps.onChange();
  }
}

function needsUpdate(): { code: string; message: string } {
  return {
    code: "needs-update",
    message: "This node runs an Orkestrator version without command nodes. Update it to attach it.",
  };
}

const CERTIFICATE_ERROR =
  /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL|ALTNAME|UNABLE_TO_GET_ISSUER/i;

/** A TLS verification failure anywhere in the cause chain. */
export function isCertificateFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CERTIFICATE_ERROR.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
