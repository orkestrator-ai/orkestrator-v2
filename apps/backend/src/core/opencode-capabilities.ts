import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  NativeAgentAuthStatus,
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
} from "@orkestrator/protocol/native-agent";
import { asRecord, assertSdkResponse, nonEmptyString } from "./agent-provider-runtime.js";
import { listOpenCodeSlashCommands } from "./opencode-commands.js";

/** SDK-backed discovery and account operations that are independent of session rendering. */
export class OpenCodeCapabilities {
  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string | undefined,
    private readonly requestOptions: () => { signal: AbortSignal },
  ) {}

  slashCommands() {
    return listOpenCodeSlashCommands(this.client, this.directory, this.requestOptions);
  }

  async mcpServers(): Promise<NativeAgentMcpServer[]> {
    const response = await this.client.mcp.status(
      { directory: this.directory },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode MCP status");
    const statuses = asRecord(response.data) ?? {};
    return Object.entries(statuses)
      .slice(0, 128)
      .flatMap(([name, value]) => {
        const status = asRecord(value);
        if (!status) return [];
        const normalized: NativeAgentMcpServer["status"] =
          status.status === "connected"
            ? "connected"
            : status.status === "disabled"
              ? "disabled"
              : status.status === "needs_auth" || status.status === "needs_client_registration"
                ? "needs-auth"
                : status.status === "failed"
                  ? "failed"
                  : "unknown";
        return [
          {
            id: name.slice(0, 256),
            name: name.slice(0, 256),
            status: normalized,
            actions:
              normalized === "connected"
                ? ["disable"]
                : normalized === "needs-auth"
                  ? ["sign-in", "reconnect"]
                  : ["enable", "reconnect"],
            ...(typeof status.error === "string" ? { error: status.error.slice(0, 2_000) } : {}),
          },
        ];
      });
  }

  async mcpServerAction(
    serverId: string,
    action: NativeAgentMcpServerAction,
  ): Promise<{ url?: string }> {
    if (action === "disable") {
      const response = await this.client.mcp.disconnect(
        { name: serverId, directory: this.directory },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode MCP disconnect");
      return {};
    }
    if (action === "sign-in") {
      const response = await this.client.mcp.auth.start(
        { name: serverId, directory: this.directory },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode MCP sign in");
      const data = asRecord(response.data);
      const url = nonEmptyString(data?.authorizationUrl) ?? nonEmptyString(data?.url);
      return url ? { url } : {};
    }
    const response = await this.client.mcp.connect(
      { name: serverId, directory: this.directory },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode MCP connect");
    return {};
  }

  async authStatus(): Promise<NativeAgentAuthStatus> {
    const response = await this.client.provider.list(
      { directory: this.directory },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode provider status");
    const data = asRecord(response.data);
    const connected = Array.isArray(data?.connected) ? data.connected : [];
    const providers = Array.isArray(data?.all) ? data.all : [];
    const normalized = providers.slice(0, 128).flatMap((candidate) => {
      const provider = asRecord(candidate);
      const id = nonEmptyString(provider?.id);
      if (!id) return [];
      return [
        {
          id,
          label: nonEmptyString(provider?.name) ?? id,
          state: connected.includes(id) ? ("signed-in" as const) : ("signed-out" as const),
        },
      ];
    });
    return {
      state: normalized.some((provider) => provider.state === "signed-in")
        ? "signed-in"
        : "needs-auth",
      providers: normalized,
      signIn: { kind: "none", hint: "Connect a provider from OpenCode settings." },
      signOut: false,
    };
  }

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    const response = await this.client.session.update(
      { sessionID: sessionId, directory: this.directory, title },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode session title update");
  }
}
