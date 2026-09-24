import {
  COMMAND_CATALOGUE_LIMITS,
  normalizeCommandCataloguePayload,
} from "@orkestrator/protocol/agent-command-catalogue";
import {
  NATIVE_AGENT_COMMAND_REFRESH_OUTCOMES,
  type NativeAgentAuthStatus,
  type NativeAgentMcpServer,
  type NativeAgentMcpServerAction,
  type NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import type {
  BridgeConnection,
  ProviderCommandCatalogue,
  ProviderCommandRefreshResult,
} from "./agent-provider-contract.js";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";
import {
  assertOk,
  assertOkWithErrorDetail,
  boundedJson,
  bridgeFetch,
} from "./http-bridge-transport.js";

export type HttpBridgeAgent = "claude" | "codex" | "cursor" | "grok" | "pi";

/** Optional discovery and account surfaces shared by the HTTP-backed agents. */
export class HttpBridgeCatalogAdapter {
  constructor(
    private readonly agent: HttpBridgeAgent,
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * Read the command catalogue, preferring the session route.
   *
   * An enhanced bridge answers an unknown session in band (`status:
   * "missing"`), so a 404 here can only mean the session route predates the
   * contract; only then does this fall back to the legacy global list. Rows
   * are normalized and bounded by the shared protocol normalizer; nothing is
   * seeded — a successful empty list stays empty.
   */
  async commandCatalogue(sessionId?: string): Promise<ProviderCommandCatalogue> {
    const globalRoute =
      this.agent === "codex" || this.agent === "cursor"
        ? "/global/slash-commands"
        : "/plugins/commands";
    let response = await bridgeFetch(
      this.connection,
      sessionId ? `/session/${encodeURIComponent(sessionId)}/commands` : globalRoute,
      {},
      this.fetchImpl,
    );
    if (sessionId && response.status === 404) {
      response = await bridgeFetch(this.connection, globalRoute, {}, this.fetchImpl);
    }
    assertOk(response, `${this.agent} slash command list`);
    const payload = asRecord(
      await boundedJson(response, `${this.agent} slash command list`, {
        remaining: COMMAND_CATALOGUE_LIMITS.maxWireBytes,
      }),
    );
    if (!payload || !Array.isArray(payload.commands)) {
      throw Object.assign(new Error(`${this.agent} returned a malformed command list`), {
        catalogueErrorCode: "malformed",
      });
    }
    const normalized = normalizeCommandCataloguePayload(payload);
    return {
      enhanced: normalized.enhanced,
      commands: normalized.commands,
      status: normalized.status ?? "ready",
      ...(normalized.truncated ? { truncated: true } : {}),
      ...(normalized.revision !== undefined ? { revision: normalized.revision } : {}),
      ...(normalized.generation ? { generation: normalized.generation } : {}),
      ...(normalized.freshness ? { freshness: normalized.freshness } : {}),
    };
  }

  async slashCommands(sessionId?: string): Promise<NativeAgentSlashCommand[]> {
    return (await this.commandCatalogue(sessionId)).commands;
  }

  /**
   * Ask the bridge to reload its command sources. A bridge that predates the
   * route (404) gets a plain re-read, reported as exactly that.
   */
  async refreshCommands(sessionId?: string): Promise<ProviderCommandRefreshResult> {
    if (!sessionId) return { outcome: "reread" };
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/commands/refresh`,
      { method: "POST" },
      this.fetchImpl,
    );
    if (response.status === 404) return { outcome: "reread" };
    await assertOkWithErrorDetail(response, `${this.agent} command refresh`);
    const body = asRecord(
      await boundedJson(response, `${this.agent} command refresh`, { remaining: 64 * 1024 }),
    );
    const outcome = NATIVE_AGENT_COMMAND_REFRESH_OUTCOMES.find(
      (candidate) => candidate === body?.outcome,
    );
    const message = nonEmptyString(body?.message)?.slice(0, 512);
    return { outcome: outcome ?? "failed", ...(message ? { message } : {}) };
  }

  async mcpServers(sessionId: string): Promise<NativeAgentMcpServer[]> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/mcp`,
      {},
      this.fetchImpl,
    );
    if (response.status === 404) return [];
    await assertOkWithErrorDetail(response, `${this.agent} MCP inventory`);
    const body = asRecord(
      await boundedJson(response, `${this.agent} MCP inventory`, { remaining: 1024 * 1024 }),
    );
    if (!Array.isArray(body?.servers)) return [];
    return body.servers.slice(0, 128).flatMap((candidate) => {
      const server = asRecord(candidate);
      const id = nonEmptyString(server?.id);
      const name = nonEmptyString(server?.name);
      const status = server?.status;
      if (
        !id ||
        !name ||
        !["connected", "connecting", "failed", "needs-auth", "disabled", "unknown"].includes(
          String(status),
        )
      ) {
        return [];
      }
      const actions = Array.isArray(server?.actions)
        ? server.actions.filter(
            (action): action is NativeAgentMcpServerAction =>
              action === "reconnect" ||
              action === "enable" ||
              action === "disable" ||
              action === "sign-in",
          )
        : [];
      return [
        {
          id: id.slice(0, 256),
          name: name.slice(0, 256),
          status: status as NativeAgentMcpServer["status"],
          actions,
          ...(server?.scope === "user" ||
          server?.scope === "project" ||
          server?.scope === "orkestrator" ||
          server?.scope === "plugin"
            ? { scope: server.scope }
            : {}),
          ...(server?.transport === "stdio" ||
          server?.transport === "sse" ||
          server?.transport === "http"
            ? { transport: server.transport }
            : {}),
          ...(Number.isSafeInteger(server?.toolCount)
            ? { toolCount: Math.max(0, server!.toolCount as number) }
            : {}),
          ...(Array.isArray(server?.tools)
            ? {
                tools: server.tools
                  .filter((tool): tool is string => typeof tool === "string")
                  .slice(0, 256)
                  .map((tool) => tool.slice(0, 256)),
              }
            : {}),
          ...(typeof server?.error === "string" ? { error: server.error.slice(0, 2_000) } : {}),
        },
      ];
    });
  }

  async mcpServerAction(
    sessionId: string,
    serverId: string,
    action: NativeAgentMcpServerAction,
  ): Promise<{ url?: string }> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(serverId)}/${action}`,
      { method: "POST" },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} MCP ${action}`);
    const body = asRecord(await boundedJson(response, `${this.agent} MCP ${action}`));
    const url = nonEmptyString(body?.url);
    return url ? { url: url.slice(0, 4096) } : {};
  }

  /**
   * `POST /global/mcp/reload`: reload MCP configuration in an already-running
   * agent process only. A 404 is a bridge that predates the route.
   */
  async reloadMcpConfiguration(): Promise<"reloaded" | "not-running" | "unsupported"> {
    const response = await bridgeFetch(
      this.connection,
      "/global/mcp/reload",
      { method: "POST" },
      this.fetchImpl,
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return "unsupported";
    }
    await assertOkWithErrorDetail(response, `${this.agent} MCP reload`);
    const body = asRecord(
      await boundedJson(response, `${this.agent} MCP reload`, { remaining: 16 * 1024 }),
    );
    return body?.reloaded === true ? "reloaded" : "not-running";
  }

  async authStatus(): Promise<NativeAgentAuthStatus> {
    const response = await bridgeFetch(this.connection, "/global/auth", {}, this.fetchImpl);
    if (response.status === 404) return { state: "unknown", signIn: { kind: "none" } };
    await assertOkWithErrorDetail(response, `${this.agent} authentication status`);
    const body = asRecord(
      await boundedJson(response, `${this.agent} authentication status`, {
        remaining: 256 * 1024,
      }),
    );
    const states = ["signed-in", "signed-out", "needs-auth", "expired", "unknown"] as const;
    const state = states.includes(body?.state as (typeof states)[number])
      ? (body!.state as NativeAgentAuthStatus["state"])
      : "unknown";
    const account = asRecord(body?.account);
    const accountLabel = nonEmptyString(account?.label);
    const signIn = asRecord(body?.signIn);
    const signInKind = ["browser-url", "device-code", "terminal", "none"].includes(
      String(signIn?.kind),
    )
      ? (signIn!.kind as NonNullable<NativeAgentAuthStatus["signIn"]>["kind"])
      : undefined;
    const providers = Array.isArray(body?.providers)
      ? body.providers.slice(0, 128).flatMap((candidate) => {
          const provider = asRecord(candidate);
          const id = nonEmptyString(provider?.id);
          const label = nonEmptyString(provider?.label);
          const providerState = states.includes(provider?.state as (typeof states)[number])
            ? (provider!.state as NativeAgentAuthStatus["state"])
            : "unknown";
          if (!id || !label) return [];
          const method = ["api-key", "oauth", "subscription"].includes(String(provider?.method))
            ? (provider!.method as "api-key" | "oauth" | "subscription")
            : undefined;
          return [
            {
              id: id.slice(0, 256),
              label: label.slice(0, 256),
              state: providerState,
              ...(method ? { method } : {}),
            },
          ];
        })
      : undefined;
    return {
      state,
      ...(accountLabel
        ? {
            account: {
              label: accountLabel.slice(0, 256),
              ...(nonEmptyString(account?.plan)
                ? { plan: nonEmptyString(account?.plan)!.slice(0, 256) }
                : {}),
              ...(nonEmptyString(account?.expiresAt)
                ? { expiresAt: nonEmptyString(account?.expiresAt)!.slice(0, 128) }
                : {}),
            },
          }
        : {}),
      ...(providers ? { providers } : {}),
      ...(signInKind
        ? {
            signIn: {
              kind: signInKind,
              ...(nonEmptyString(signIn?.hint)
                ? { hint: nonEmptyString(signIn?.hint)!.slice(0, 2_000) }
                : {}),
            },
          }
        : {}),
      ...(typeof body?.signOut === "boolean" ? { signOut: body.signOut } : {}),
    };
  }

  async beginSignIn(): Promise<{ url?: string; code?: string }> {
    const response = await bridgeFetch(
      this.connection,
      "/global/auth/login",
      { method: "POST" },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} sign in`);
    const body = asRecord(await boundedJson(response, `${this.agent} sign in`));
    return {
      ...(nonEmptyString(body?.url) ? { url: nonEmptyString(body?.url)!.slice(0, 4096) } : {}),
      ...(nonEmptyString(body?.code) ? { code: nonEmptyString(body?.code)!.slice(0, 512) } : {}),
    };
  }

  async signOut(): Promise<void> {
    const response = await bridgeFetch(
      this.connection,
      "/global/auth/logout",
      { method: "POST" },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} sign out`);
  }

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/title`,
      { method: "POST", body: JSON.stringify({ title }) },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} session title`);
  }
}
