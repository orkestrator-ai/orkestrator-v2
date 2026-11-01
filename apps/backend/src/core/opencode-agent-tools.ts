import { readBoundedOpenCodeResponse } from "./opencode-bounded-response.js";
import { OpenCodeCoordinatorResearch } from "./opencode-coordinator-research.js";
import { createHash } from "node:crypto";
import { ORKESTRATOR_AGENT_MCP_SERVER_NAME, type AgentToolConnection } from "./agent-tools.js";
import { conciseError } from "./commands-error-text.js";
import { agentToolConnectionFingerprint, openCodeHealthHeaders } from "./commands-server-health.js";

/**
 * Reconciliation of the optional Orkestrator MCP entry on OpenCode servers.
 * The pure request helpers are free functions; the per-backend bookkeeping
 * lives in `OpenCodeAgentToolsReconciler`, owned by `LocalServerRuntime`.
 */

export async function configureOpenCodeAgentTools(
  port: number,
  password: string,
  connection: AgentToolConnection,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  url.searchParams.set("directory", directory);
  const headers = openCodeHealthHeaders(password);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: ORKESTRATOR_AGENT_MCP_SERVER_NAME,
      config: {
        type: "remote",
        url: connection.url,
        enabled: true,
        oauth: false,
        // Orkestrator's endpoint is on the same host. Do not inherit
        // OpenCode's 30-second connect/catalog default for this optional tool.
        timeout: 3_000,
        headers: {
          Authorization: `Bearer ${connection.token}`,
        },
      },
    }),
    signal: openCodeAgentToolsAbortSignal(5_000, signal),
  });
  if (!response.ok) {
    // Never include the response body: OpenCode may echo the submitted MCP
    // config, which contains the project-scoped bearer credential.
    throw new Error(
      `OpenCode rejected the Orkestrator agent tools configuration (${response.status})`,
    );
  }

  const payload = await readBoundedOpenCodeResponse(response);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("OpenCode returned an invalid MCP status response");
  }
  const status = readOpenCodeAgentToolsStatus(payload);
  if (status === null) {
    throw new Error("OpenCode omitted the Orkestrator MCP status");
  }
  if (status !== "connected") {
    // Treat transitional states as unsuccessful too: startup must not advertise
    // a server whose ticket tools are not usable yet. Do not include the remote
    // error field because it may echo connection configuration or credentials.
    const safeStatus =
      typeof status === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(status) ? status : "invalid";
    throw new Error(`OpenCode did not connect the Orkestrator agent tools (${safeStatus})`);
  }
}

export function openCodeAgentToolsAbortSignal(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function readOpenCodeAgentToolsStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const entry = (payload as Record<string, unknown>)[ORKESTRATOR_AGENT_MCP_SERVER_NAME];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const status = (entry as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

export {
  MAX_OPENCODE_MCP_STATUS_BYTES,
  readBoundedOpenCodeResponse,
} from "./opencode-bounded-response.js";

export function openCodeAgentToolsFingerprint(
  port: number,
  password: string,
  connection: AgentToolConnection,
  directory: string,
): string {
  return createHash("sha256")
    .update(String(port))
    .update("\0")
    .update(password)
    .update("\0")
    .update(directory)
    .update("\0")
    .update(agentToolConnectionFingerprint(connection))
    .digest("hex");
}

export function waitForOpenCodeAgentToolsRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

export const OPENCODE_AGENT_TOOLS_RETRY_DELAYS_MS: readonly number[] = [
  250, 500, 1_000, 2_000, 4_000,
];

/**
 * How long a recorded outcome suppresses another POST.
 *
 * A `connected` memo must expire: OpenCode can drop, disable or fail the entry
 * while the server keeps running on the same port and password, so the
 * fingerprint alone can never notice. Re-POSTing periodically is the only
 * re-verification left now that a status GET is known to be unable to identify
 * the configured URL or credential. An `unavailable` outcome gets a shorter
 * cooldown so a repeated status read cannot restart the retry cycle back to
 * back.
 */
export const OPENCODE_AGENT_TOOLS_CONNECTED_TTL_MS = 5 * 60_000;
export const OPENCODE_AGENT_TOOLS_UNAVAILABLE_COOLDOWN_MS = 30_000;

/** Reported by the local and container OpenCode status commands. */
export type OpenCodeAgentToolsState = "pending" | "connected" | "unavailable";

type OpenCodeAgentToolsConfiguration = {
  fingerprint: string;
  controller: AbortController;
  task: Promise<void>;
};

/**
 * What reconciliation last established about a server generation, and when.
 *
 * `connected` memoizes a successful POST so ordinary status reads do no I/O;
 * `unavailable` records an exhausted retry cycle so status can report degraded
 * ticket tools instead of failing silently. Both entries expire — see
 * `memoWindowMs`.
 */
type OpenCodeAgentToolsOutcome = {
  fingerprint: string;
  state: "connected" | "unavailable";
  /** `Date.now()` when this outcome was recorded. */
  at: number;
};

export type OpenCodeAgentToolsTuning = {
  retryDelaysMs?: readonly number[];
  connectedTtlMs?: number;
  unavailableCooldownMs?: number;
};

/**
 * Backend-owned reconciliation, keyed by `local:<environmentId>` or
 * `container:<containerId>`; native tabs must not be its lifecycle owner.
 */
export class OpenCodeAgentToolsReconciler {
  private readonly configurations = new Map<string, OpenCodeAgentToolsConfiguration>();
  private readonly outcomes = new Map<string, OpenCodeAgentToolsOutcome>();
  /**
   * The Orkestrator MCP connection each live local OpenCode server was started
   * with, by `local:<environmentId>`. Later reconciliation re-verifies exactly
   * this one: a coordinator's server carries its scoped Control MCP credential,
   * which a tab's Agent Tools connection must never replace.
   */
  private readonly launchConnections = new Map<string, AgentToolConnection>();
  /** Coordinator research registrations, keyed the same way and forgotten with them. */
  readonly research = new OpenCodeCoordinatorResearch();
  private readonly retryDelaysMs: readonly number[];
  private readonly connectedTtlMs: number;
  private readonly unavailableCooldownMs: number;

  constructor(tuning: OpenCodeAgentToolsTuning = {}) {
    this.retryDelaysMs = tuning.retryDelaysMs ?? OPENCODE_AGENT_TOOLS_RETRY_DELAYS_MS;
    this.connectedTtlMs = tuning.connectedTtlMs ?? OPENCODE_AGENT_TOOLS_CONNECTED_TTL_MS;
    this.unavailableCooldownMs =
      tuning.unavailableCooldownMs ?? OPENCODE_AGENT_TOOLS_UNAVAILABLE_COOLDOWN_MS;
  }

  private memoWindowMs(state: OpenCodeAgentToolsOutcome["state"]): number {
    return state === "connected" ? this.connectedTtlMs : this.unavailableCooldownMs;
  }

  /**
   * What the backend last observed about a generation's ticket tools.
   *
   * An in-flight generation reads `pending` rather than the previous cycle's
   * failure, but a live `connected` memo keeps reading `connected` while a TTL
   * re-verification runs — a periodic re-POST must not flap the indicator.
   */
  state(key: string): OpenCodeAgentToolsState {
    const recorded = this.outcomes.get(key);
    if (recorded?.state === "connected") return "connected";
    if (this.configurations.has(key)) return "pending";
    return recorded ? "unavailable" : "pending";
  }

  /**
   * Reconcile the optional Orkestrator MCP entry without extending native chat
   * startup. One task per server generation retries transient connect/catalog
   * failures; the terminal outcome is recorded so ordinary status reads do no I/O
   * and can report degraded ticket tools. Recorded outcomes expire, so a
   * long-lived server that later drops the entry is re-reconciled.
   */
  schedule(
    key: string,
    port: number,
    password: string,
    connection: AgentToolConnection,
    directory: string,
  ): Promise<OpenCodeAgentToolsState> {
    const fingerprint = openCodeAgentToolsFingerprint(port, password, connection, directory);
    const outcome = () => this.state(key);
    const recorded = this.outcomes.get(key);
    if (recorded?.fingerprint === fingerprint) {
      if (Date.now() - recorded.at < this.memoWindowMs(recorded.state)) {
        return Promise.resolve(outcome());
      }
    } else if (recorded) {
      // The outcome map always describes the current generation, so a status read
      // never reports the previous port/credential's verdict.
      this.outcomes.delete(key);
    }

    const current = this.configurations.get(key);
    if (current?.fingerprint === fingerprint) return current.task.then(outcome);
    current?.controller.abort();

    const controller = new AbortController();
    const delays = this.retryDelaysMs;
    const task = (async () => {
      for (let attempt = 0; attempt <= delays.length; attempt += 1) {
        try {
          await configureOpenCodeAgentTools(
            port,
            password,
            connection,
            directory,
            controller.signal,
          );
          if (!controller.signal.aborted) {
            this.outcomes.set(key, {
              fingerprint,
              state: "connected",
              at: Date.now(),
            });
          }
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (attempt === delays.length) {
            // Record the failure rather than only logging it: the status commands
            // report this so a session does not silently run without the ticket
            // tools it was told it would have.
            this.outcomes.set(key, {
              fingerprint,
              state: "unavailable",
              at: Date.now(),
            });
            console.warn(
              `[backend] OpenCode agent tools remain unavailable for ${key}:`,
              conciseError(error),
            );
            return;
          }
          await waitForOpenCodeAgentToolsRetry(delays[attempt]!, controller.signal);
          // An abort during the backoff resolves rather than throwing, so the
          // cancellation has to be observed here instead of via the next fetch.
          if (controller.signal.aborted) return;
        }
      }
    })();
    const configuration = { fingerprint, controller, task };
    this.configurations.set(key, configuration);
    void task.finally(() => {
      if (this.configurations.get(key) === configuration) {
        this.configurations.delete(key);
      }
    });
    return task.then(outcome);
  }

  /**
   * Forget the recorded outcome for `key`, so the next {@link schedule} posts
   * the entry again. For an instance disposal, which drops runtime-added
   * servers while the server process (and its fingerprint) stays the same.
   */
  forget(key: string): void {
    // A POST started before disposal cannot establish the rebuilt instance's
    // connection, even when its fingerprint is unchanged.
    this.configurations.get(key)?.controller.abort();
    this.configurations.delete(key);
    this.outcomes.delete(key);
  }

  /** The connection a live local OpenCode server was launched with, if recorded. */
  launchConnection(key: string): AgentToolConnection | undefined {
    return this.launchConnections.get(key);
  }

  recordLaunchConnection(key: string, connection: AgentToolConnection): void {
    this.launchConnections.set(key, connection);
  }

  cancel(key: string): void {
    this.configurations.get(key)?.controller.abort();
    this.configurations.delete(key);
    this.outcomes.delete(key);
    this.launchConnections.delete(key);
    this.research.forget(key);
  }

  cancelAll(): void {
    for (const key of this.launchConnections.keys()) this.research.forget(key);
    for (const configuration of this.configurations.values()) {
      configuration.controller.abort();
    }
    this.configurations.clear();
    this.outcomes.clear();
    this.launchConnections.clear();
  }

  /** In-flight reconciliations; for tests and diagnostics. */
  configurationCount(): number {
    return this.configurations.size;
  }

  /** Recorded outcomes; for tests and diagnostics. */
  outcomeCount(): number {
    return this.outcomes.size;
  }

  /** Settles with the key's in-flight reconcile, which a status read starts without waiting. */
  async settled(key: string): Promise<void> {
    await this.configurations.get(key)?.task;
  }
}
