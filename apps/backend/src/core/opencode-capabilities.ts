import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  NativeAgentAuthStatus,
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
} from "@orkestrator/protocol/native-agent";
import {
  isSelectableOpenCodeProvider,
  OPENCODE_MCP_SIGN_IN_GUIDANCE,
} from "@orkestrator/protocol/native-agent";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";
import { asRecord, assertSdkResponse, nonEmptyString } from "./agent-provider-runtime.js";
import { readOpenCodeCommandInventory } from "./opencode-commands.js";

const MAX_OPENCODE_AUTH_PROVIDERS = 128;
const MAX_OPENCODE_HINT_PROVIDERS = 8;

/**
 * OpenCode signs a provider in through Settings → OpenCode, which drives the
 * bundled server's own auth routes (`opencode-provider-login.ts`). The `opencode`
 * on a user's PATH may be another major version that keeps its logins
 * elsewhere, so the hints point at Settings rather than the CLI.
 */
export const OPENCODE_SIGN_IN_REQUIRED_MESSAGE =
  "OpenCode has no connected model provider. Sign one in from Settings → OpenCode.";
export const OPENCODE_SIGN_IN_COMMAND_HINT = "Sign a provider in from Settings → OpenCode.";

/** Names the allowlisted providers to connect, when the allowlist is narrow enough to list. */
function openCodeSignInHint(
  allowedProviders: readonly string[],
  known: ReadonlyArray<{ id: string; label: string }>,
): string {
  const fallback = "Sign a provider in from Settings → OpenCode.";
  if (allowedProviders.length === 0 || allowedProviders.length > MAX_OPENCODE_HINT_PROVIDERS) {
    return fallback;
  }
  const labels = allowedProviders.map(
    (id) => known.find((provider) => provider.id.trim().toLowerCase() === id)?.label ?? id,
  );
  return `Sign ${labels.length === 1 ? labels[0] : `one of ${labels.join(", ")}`} in from Settings → OpenCode.`;
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
            // No in-app sign-in: OpenCode completes MCP OAuth only for a
            // request that waits for the callback (see the guidance's notes).
            actions:
              normalized === "connected"
                ? ["disable"]
                : normalized === "needs-auth"
                  ? ["reconnect"]
                  : ["enable", "reconnect"],
            ...(normalized === "needs-auth"
              ? { hint: OPENCODE_MCP_SIGN_IN_GUIDANCE.replace("<server>", name.slice(0, 256)) }
              : {}),
            // A server's error can echo a URL or header with a token in it.
            ...(typeof status.error === "string"
              ? { error: redactSecrets(status.error).slice(0, 2_000) }
              : {}),
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
      // `mcp.auth.start` returns a URL whose callback OpenCode then refuses,
      // because nothing waits for it; a renderer that still offers the
      // action gets the route that does complete.
      throw new Error(OPENCODE_MCP_SIGN_IN_GUIDANCE.replace("<server>", serverId.slice(0, 256)));
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
            ? nonEmptyString(candidate)?.trim()
            : nonEmptyString(asRecord(candidate)?.id)?.trim();
        return id ? [id] : [];
      }),
    );
    // Derived from `connected` itself, never from the capped list below:
    // OpenCode's `all` names every provider it knows about, so a connected one
    // can sit past the cap. Signed-in means a picker-selectable provider is
    // connected; the allowlist does not restrict dispatch of stored models.
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
      signIn: { kind: "terminal", hint: openCodeSignInHint(allowedProviders, known) },
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
