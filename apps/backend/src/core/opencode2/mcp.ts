/**
 * Orkestrator's MCP servers on an OpenCode 2.x server
 * (docs/todo/agent-engines/0008-opencode-v2.md, owner decision 2 of 2026-11-09).
 *
 * 2.x adds a runtime server with `PUT /api/experimental/mcp/:server` and
 * reports its status through `GET /api/mcp`. Both are scoped to the server's
 * location (the worktree), not to a session, and a runtime server lives in
 * the process only: nothing reaches OpenCode's database or config, so a
 * bearer token never outlives the server process.
 *
 * Two kinds are registered, both with `codemode: false` so their tools are
 * offered directly under `<server>_<tool>`, which is what the session rules in
 * `permissions.ts` name:
 *
 * - **A tab's own connection** (`orkestrator_tab_<id>`, one per session). Its
 *   token rotates; a changed token re-registers the server. Other sessions'
 *   rules deny it, so the credential reaches only its own session.
 * - **The workflow-result broker** (`orkestrator_workflow_result`), the
 *   environment-wide broker credential 1.x uses too. Every session's rules
 *   deny its tools; a result turn is granted its own for the turn only.
 *
 * These routes are experimental upstream. The exact pin and
 * `opencode2-mcp.live.test.ts` guard them on every bump.
 */
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { WORKFLOW_RESULT_MCP_SERVER_NAME } from "@orkestrator/protocol/workflow-results";
import type {
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
} from "@orkestrator/protocol/native-agent";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";
import { ProviderDispatchPreparationError } from "../agent-provider-contract.js";
import type { OpenCode2Client } from "./client.js";
import { isOrkestratorOpenCode2McpServer, openCode2TabMcpServer } from "./permissions.js";
import type { OpenCode2McpServer } from "./types.js";

const log = createLogger("native-agent.opencode2");

/** How long a registration waits for `connected` before the turn is refused. */
export const OPENCODE2_MCP_CONNECT_TIMEOUT_MS = 10_000;
/** A connected registration is trusted this long before its status is read again. */
const STATUS_TRUST_MS = 5_000;
/** Most servers shown in the session's MCP list (as on 1.x). */
const MAX_LISTED_SERVERS = 128;
/** Most per-tab servers one 2.x server holds; the oldest registration is removed past it. */
export const MAX_OPENCODE2_TAB_SERVERS = 256;

export interface OpenCode2McpConnection {
  url: string;
  token: string;
}

export interface OpenCode2McpDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  connectTimeoutMs?: number;
}

type Registration = { key: string; checkedAt: number };

export class OpenCode2McpServers {
  private readonly registered = new Map<string, Registration>();
  private readonly pending = new Map<string, { key: string; promise: Promise<void> }>();

  constructor(
    private readonly client: OpenCode2Client,
    private readonly deps: OpenCode2McpDependencies = {},
  ) {}

  /** Register (or re-register on a new token) one session's tab connection. */
  ensureTab(sessionId: string, connection: OpenCode2McpConnection): Promise<void> {
    return this.ensure(openCode2TabMcpServer(sessionId), connection);
  }

  /** Register the environment's workflow-result broker connection. */
  ensureWorkflowBroker(connection: OpenCode2McpConnection): Promise<void> {
    return this.ensure(WORKFLOW_RESULT_MCP_SERVER_NAME, connection);
  }

  /** Remove a closed session's tab server, so its credential stops being presented. */
  async removeTab(sessionId: string): Promise<void> {
    const name = openCode2TabMcpServer(sessionId);
    if (!this.registered.has(name)) return;
    this.registered.delete(name);
    await this.client.removeMcpServer(name).catch((error: unknown) => {
      log.debug("mcp.remove-failed", { error: formatLogError(error, { message: false }) });
    });
  }

  /** The user's servers on this location, in the shared shape; Orkestrator's are left out. */
  async userServers(): Promise<NativeAgentMcpServer[]> {
    const servers = await this.client.listMcpServers();
    return servers
      .filter((server) => !isOrkestratorOpenCode2McpServer(server.name))
      .slice(0, MAX_LISTED_SERVERS)
      .map(sharedServer);
  }

  async userServerAction(
    serverId: string,
    action: NativeAgentMcpServerAction,
  ): Promise<{ url?: string }> {
    if (isOrkestratorOpenCode2McpServer(serverId)) {
      throw new Error("Orkestrator's own MCP servers are managed by Orkestrator");
    }
    if (action === "sign-in") {
      throw new Error(
        `Sign in to ${serverId.slice(0, 256)} from an OpenCode terminal; OpenCode 2 sessions have no in-app MCP sign-in yet.`,
      );
    }
    if (action === "disable") await this.client.disconnectMcpServer(serverId);
    else await this.client.connectMcpServer(serverId);
    return {};
  }

  private ensure(name: string, connection: OpenCode2McpConnection): Promise<void> {
    const key = `${connection.url}\0${connection.token}`;
    const pending = this.pending.get(name);
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
      if (pending) await pending.promise.catch(() => undefined);
      const known = this.registered.get(name);
      if (known?.key === key && this.now() - known.checkedAt < STATUS_TRUST_MS) return;
      if (known?.key === key && (await this.status(name)) === "connected") {
        known.checkedAt = this.now();
        return;
      }
      this.registered.delete(name);
      await this.client.putMcpServer(name, {
        type: "remote",
        url: connection.url,
        headers: { Authorization: `Bearer ${connection.token}` },
        oauth: false,
        codemode: false,
        // Orkestrator's endpoint is on this host; never wait OpenCode's default.
        timeout: { startup: 5_000, catalog: 5_000 },
      });
      await this.waitConnected(name);
      this.registered.set(name, { key, checkedAt: this.now() });
      this.evictOldTabs();
    })();
    const entry = { key, promise };
    this.pending.set(name, entry);
    return promise
      .catch((error: unknown) => {
        throw new ProviderDispatchPreparationError(
          "OpenCode 2 could not connect Orkestrator's MCP server",
          { cause: error },
        );
      })
      .finally(() => {
        if (this.pending.get(name) === entry) this.pending.delete(name);
      });
  }

  private async waitConnected(name: string): Promise<void> {
    const deadline = this.now() + (this.deps.connectTimeoutMs ?? OPENCODE2_MCP_CONNECT_TIMEOUT_MS);
    for (;;) {
      const status = await this.status(name);
      if (status === "connected") return;
      // A failure is final for this registration; its message may echo the URL.
      if (status === "failed" || status === "needs_auth" || status === "disabled") {
        throw new Error(`MCP server ${name} is ${status}`);
      }
      if (this.now() >= deadline) throw new Error(`MCP server ${name} did not connect`);
      await (this.deps.sleep ?? Bun.sleep)(100);
    }
  }

  private async status(name: string): Promise<string | undefined> {
    const servers = await this.client.listMcpServers();
    return servers.find((server) => server.name === name)?.status.status;
  }

  /** Tab servers of sessions long gone: bounded, never the broker. */
  private evictOldTabs(): void {
    const tabs = [...this.registered.keys()].filter(
      (name) => name !== WORKFLOW_RESULT_MCP_SERVER_NAME,
    );
    for (const name of tabs.slice(0, Math.max(0, tabs.length - MAX_OPENCODE2_TAB_SERVERS))) {
      this.registered.delete(name);
      void this.client.removeMcpServer(name).catch(() => undefined);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function sharedServer(server: OpenCode2McpServer): NativeAgentMcpServer {
  const raw = server.status.status;
  const status: NativeAgentMcpServer["status"] =
    raw === "connected"
      ? "connected"
      : raw === "disabled"
        ? "disabled"
        : raw === "needs_auth"
          ? "needs-auth"
          : raw === "failed"
            ? "failed"
            : "unknown";
  const name = server.name.slice(0, 256);
  return {
    id: name,
    name,
    status,
    actions:
      status === "connected"
        ? ["disable"]
        : status === "needs-auth"
          ? ["reconnect"]
          : ["enable", "reconnect"],
    // A server's error can echo a URL or header with a token in it.
    ...(typeof server.status.error === "string"
      ? { error: redactSecrets(server.status.error).slice(0, 2_000) }
      : {}),
  };
}
