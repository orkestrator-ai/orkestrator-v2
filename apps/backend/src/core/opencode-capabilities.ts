import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  NativeAgentAuthStatus,
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
} from "@orkestrator/protocol/native-agent";
import { isSelectableOpenCodeProvider } from "@orkestrator/protocol/native-agent";
import { asRecord, assertSdkResponse, nonEmptyString } from "./agent-provider-runtime.js";
import { readOpenCodeCommandInventory } from "./opencode-commands.js";

const MAX_OPENCODE_AUTH_PROVIDERS = 128;
const MAX_OPENCODE_HINT_PROVIDERS = 8;

/** Names the allowlisted providers to connect, when the allowlist is narrow enough to list. */
function openCodeSignInHint(
  allowedProviders: readonly string[],
  known: ReadonlyArray<{ id: string; label: string }>,
): string {
  const fallback = "Connect a provider from OpenCode settings.";
  if (allowedProviders.length === 0 || allowedProviders.length > MAX_OPENCODE_HINT_PROVIDERS) {
    return fallback;
  }
  const labels = allowedProviders.map(
    (id) => known.find((provider) => provider.id.trim().toLowerCase() === id)?.label ?? id,
  );
  return `Connect ${labels.length === 1 ? labels[0] : `one of ${labels.join(", ")}`} from OpenCode settings.`;
}

/** SDK-backed discovery and account operations that are independent of session rendering. */
export class OpenCodeCapabilities {
  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string | undefined,
    private readonly requestOptions: () => { signal: AbortSignal },
    private readonly allowedProviders: () => Promise<readonly string[]>,
  ) {}

  /** The effective, directory-scoped command inventory. Throws when unreadable. */
  readCommands() {
    return readOpenCodeCommandInventory(this.client, this.directory, this.requestOptions);
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
    const [response, allowedProviders] = await Promise.all([
      this.client.provider.list({ directory: this.directory }, this.requestOptions()),
      this.allowedProviders(),
    ]);
    assertSdkResponse(response, "OpenCode provider status");
    const data = asRecord(response.data);
    const connected = new Set(
      (Array.isArray(data?.connected) ? data.connected : []).flatMap((candidate) => {
        const id =
          typeof candidate === "string"
            ? nonEmptyString(candidate)
            : nonEmptyString(asRecord(candidate)?.id);
        return id ? [id] : [];
      }),
    );
    // Derived from `connected` itself, never from the capped list below:
    // OpenCode's `all` names every provider it knows about, so a connected one
    // can sit past the cap. Only an allowlisted provider can serve a turn.
    const signedIn = [...connected].some((id) =>
      isSelectableOpenCodeProvider(id, allowedProviders),
    );
    const known = (Array.isArray(data?.all) ? data.all : []).flatMap((candidate) => {
      const provider = asRecord(candidate);
      const id = nonEmptyString(provider?.id);
      if (!id) return [];
      return [
        {
          id,
          label: nonEmptyString(provider?.name) ?? id,
          state: connected.has(id) ? ("signed-in" as const) : ("signed-out" as const),
          selectable: isSelectableOpenCodeProvider(id, allowedProviders),
        },
      ];
    });
    // Connected providers first, then allowlisted ones, so the providers that
    // matter survive the cap. A stable sort keeps OpenCode's order within each.
    const rank = (provider: (typeof known)[number]) =>
      (provider.state === "signed-in" ? 0 : 2) + (provider.selectable ? 0 : 1);
    const providers = known
      .map((provider, index) => ({ provider, index }))
      .sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
      .slice(0, MAX_OPENCODE_AUTH_PROVIDERS)
      .map(({ provider: { selectable: _selectable, ...provider } }) => provider);
    return {
      state: signedIn ? "signed-in" : "needs-auth",
      providers,
      signIn: { kind: "none", hint: openCodeSignInHint(allowedProviders, known) },
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
