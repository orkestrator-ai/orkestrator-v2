import type {
  NativeAgentAuthStatus,
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import type { BridgeConnection } from "./agent-provider-contract.js";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";
import {
  assertOk,
  assertOkWithErrorDetail,
  boundedJson,
  bridgeFetch,
} from "./http-bridge-transport.js";

export type HttpBridgeAgent = "claude" | "codex" | "cursor" | "grok" | "pi";

const CLAUDE_BUILT_IN_SLASH_COMMANDS: readonly NativeAgentSlashCommand[] = [
  ["/clear", "Clear conversation history"],
  ["/compact", "Compact conversation to reduce tokens"],
  ["/context", "Show current context"],
  ["/cost", "Show token usage and cost"],
  ["/doctor", "Check system health"],
  ["/goal", "Set, view, or clear a completion goal"],
  ["/help", "Show available commands"],
  ["/init", "Re-initialize the session"],
  ["/logout", "Log out of Claude"],
  ["/memory", "Show memory usage"],
  ["/model", "Show or change model"],
  ["/permissions", "Manage permissions"],
  ["/review", "Review recent changes"],
  ["/status", "Show session status"],
  ["/vim", "Toggle vim mode"],
].map(([name, description]) => ({ name: name!, description, source: "builtin" }));

/** Optional discovery and account surfaces shared by the HTTP-backed agents. */
export class HttpBridgeCatalogAdapter {
  constructor(
    private readonly agent: HttpBridgeAgent,
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async slashCommands(sessionId?: string): Promise<NativeAgentSlashCommand[]> {
    let response = sessionId
      ? await bridgeFetch(
          this.connection,
          `/session/${encodeURIComponent(sessionId)}/commands`,
          {},
          this.fetchImpl,
        )
      : new Response(null, { status: 404 });
    if (response.status === 404) {
      response = await bridgeFetch(
        this.connection,
        this.agent === "codex" || this.agent === "cursor"
          ? "/global/slash-commands"
          : "/plugins/commands",
        {},
        this.fetchImpl,
      );
    }
    assertOk(response, `${this.agent} slash command list`);
    const payload = asRecord(
      await boundedJson(response, `${this.agent} slash command list`, { remaining: 512 * 1024 }),
    );
    const commands = new Map<string, NativeAgentSlashCommand>(
      this.agent === "claude"
        ? CLAUDE_BUILT_IN_SLASH_COMMANDS.map((command) => [command.name, command])
        : [],
    );
    if (!payload || !Array.isArray(payload.commands)) return [...commands.values()];
    for (const candidate of payload.commands.slice(0, 512)) {
      const command = typeof candidate === "string" ? { name: candidate } : asRecord(candidate);
      const rawName = nonEmptyString(command?.name);
      if (!rawName) continue;
      const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
      commands.set(name, {
        name: name.slice(0, 256),
        source:
          command?.source === "builtin" ||
          command?.source === "project" ||
          command?.source === "user" ||
          command?.source === "plugin" ||
          command?.source === "skill" ||
          command?.source === "template" ||
          command?.source === "extension" ||
          command?.source === "orkestrator"
            ? command.source
            : "unknown",
        ...(typeof command?.description === "string"
          ? { description: command.description.slice(0, 1_000) }
          : {}),
        ...(typeof command?.argumentHint === "string"
          ? { argumentHint: command.argumentHint.slice(0, 512) }
          : {}),
        ...(Array.isArray(command?.aliases)
          ? {
              aliases: command.aliases
                .filter((alias): alias is string => typeof alias === "string")
                .slice(0, 16)
                .map((alias) => alias.slice(0, 256)),
            }
          : {}),
        ...(command?.scope === "global" || command?.scope === "session"
          ? { scope: command.scope }
          : {}),
      });
    }
    return [...commands.values()].slice(0, 512);
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
