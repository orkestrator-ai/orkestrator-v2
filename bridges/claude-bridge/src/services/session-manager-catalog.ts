import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AccountInfo,
  McpServerStatus,
  Query,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  NativeAgentAuthStatus,
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import { claudeExecutableOptions, sessions } from "./session-manager-core.js";
import type { PermissionMode, SessionState } from "../types/index.js";

const CATALOG_LIMIT = 512;
const AUTH_CACHE_TTL_MS = 30_000;
let authCache: { expiresAt: number; value: NativeAgentAuthStatus } | undefined;
const steerDispatches = new Map<string, "dispatched" | "absent" | "unknown">();

export function resetClaudeCatalogCachesForTesting(): void {
  authCache = undefined;
}

function steerKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

function rememberSteer(
  sessionId: string,
  requestId: string,
  state: "dispatched" | "absent" | "unknown",
) {
  const key = steerKey(sessionId, requestId);
  steerDispatches.delete(key);
  steerDispatches.set(key, state);
  while (steerDispatches.size > 512) {
    const oldest = steerDispatches.keys().next().value;
    if (oldest === undefined) break;
    steerDispatches.delete(oldest);
  }
}

export function readClaudeSteerDispatch(
  sessionId: string,
  requestId: string,
): "dispatched" | "absent" | "unknown" {
  return steerDispatches.get(steerKey(sessionId, requestId)) ?? "unknown";
}

function createProbe(): Query {
  return query({
    prompt: "",
    options: {
      maxTurns: 0,
      cwd: process.env.CWD || process.cwd(),
      ...claudeExecutableOptions(),
    },
  });
}

function commandSource(command: SlashCommand): NativeAgentSlashCommand["source"] {
  const metadata = command as SlashCommand & { source?: unknown; scope?: unknown };
  const raw = typeof metadata.source === "string" ? metadata.source.toLowerCase() : "";
  if (raw.includes("project") || raw.includes("local")) return "project";
  if (raw.includes("user")) return "user";
  if (raw.includes("plugin")) return "plugin";
  if (raw.includes("skill")) return "skill";
  return "builtin";
}

function normalizeCommands(
  commands: readonly SlashCommand[],
  skills: readonly string[] = [],
): NativeAgentSlashCommand[] {
  const result = new Map<string, NativeAgentSlashCommand>();
  for (const command of commands.slice(0, CATALOG_LIMIT)) {
    const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
    result.set(name, {
      name,
      source: commandSource(command),
      ...(command.description ? { description: command.description.slice(0, 1_000) } : {}),
      ...(command.argumentHint ? { argumentHint: command.argumentHint.slice(0, 512) } : {}),
      ...(command.aliases?.length
        ? {
            aliases: command.aliases
              .slice(0, 16)
              .map((alias) => (alias.startsWith("/") ? alias : `/${alias}`)),
          }
        : {}),
      scope: commandSource(command) === "project" ? "session" : "global",
    });
  }
  for (const skill of skills.slice(0, CATALOG_LIMIT)) {
    if (typeof skill !== "string" || !skill.trim()) continue;
    const name = skill.startsWith("/") ? skill : `/skill:${skill}`;
    result.set(name, { name, source: "skill", scope: "session" });
  }
  return [...result.values()].slice(0, CATALOG_LIMIT);
}

export async function readSessionCommands(
  sessionId: string,
  refresh = false,
): Promise<NativeAgentSlashCommand[]> {
  const session = sessions.get(sessionId);
  const control = session?.queryControl;
  if (control?.supportedCommands) {
    if (refresh) {
      await Promise.allSettled([control.reloadSkills?.(), control.reloadPlugins?.()]);
    }
    return normalizeCommands(await control.supportedCommands(), session?.initData?.skills);
  }
  let probe: Query | undefined;
  try {
    probe = createProbe();
    return normalizeCommands(await probe.supportedCommands(), session?.initData?.skills);
  } catch {
    return [];
  } finally {
    await Promise.resolve(probe?.close()).catch(() => undefined);
  }
}

export async function refreshClaudeCatalogs(): Promise<void> {
  const sessionIds = [...sessions.keys()].slice(0, 128);
  let next = 0;
  await Promise.allSettled(
    Array.from({ length: Math.min(8, sessionIds.length) }, async () => {
      while (next < sessionIds.length) {
        const sessionId = sessionIds[next++];
        if (sessionId) await readSessionCommands(sessionId, true);
      }
    }),
  );
}

function mcpScope(scope: string | undefined, name: string): NativeAgentMcpServer["scope"] {
  if (name === "orkestrator") return "orkestrator";
  if (scope?.includes("plugin")) return "plugin";
  if (scope === "project" || scope === "local") return "project";
  return "user";
}

function mcpTransport(status: McpServerStatus): NativeAgentMcpServer["transport"] | undefined {
  const type = (status.config as { type?: unknown } | undefined)?.type;
  if (type === "stdio" || type === "sse" || type === "http") return type;
  if ((status.config as { command?: unknown } | undefined)?.command) return "stdio";
  if ((status.config as { url?: unknown } | undefined)?.url) return "http";
  return undefined;
}

function normalizeMcp(status: McpServerStatus): NativeAgentMcpServer {
  const mappedStatus = status.status === "pending" ? "connecting" : status.status;
  const tools = (status.tools ?? [])
    .map((tool) => tool.name)
    .filter(Boolean)
    .slice(0, 256);
  const actions: NativeAgentMcpServerAction[] =
    status.status === "disabled"
      ? ["enable"]
      : status.status === "needs-auth"
        ? ["sign-in", "reconnect", "disable"]
        : ["reconnect", "disable"];
  const transport = mcpTransport(status);
  return {
    id: status.name,
    name: status.serverInfo?.name || status.name,
    status: mappedStatus,
    scope: mcpScope(status.scope, status.name),
    ...(transport ? { transport } : {}),
    toolCount: tools.length,
    ...(tools.length ? { tools } : {}),
    ...(status.error ? { error: status.error.slice(0, 2_000) } : {}),
    actions,
  };
}

export async function readSessionMcpServers(sessionId: string): Promise<NativeAgentMcpServer[]> {
  const session = sessions.get(sessionId);
  if (!session) return [];
  const control = session.queryControl;
  if (control?.mcpServerStatus) {
    session.mcpInventory = (await control.mcpServerStatus()).slice(0, 128).map(normalizeMcp);
  } else if (!session.mcpInventory && session.initData?.mcpServers) {
    session.mcpInventory = session.initData.mcpServers.slice(0, 128).map((server) => ({
      id: server.name,
      name: server.name,
      status: server.status,
      actions:
        server.status === "disabled"
          ? ["enable"]
          : server.status === "needs-auth"
            ? ["sign-in", "reconnect", "disable"]
            : ["reconnect", "disable"],
      ...(server.scope ? { scope: server.scope } : {}),
      ...(server.transport ? { transport: server.transport } : {}),
      ...(server.tools
        ? { tools: server.tools.slice(0, 256), toolCount: server.tools.length }
        : {}),
      ...(server.error ? { error: server.error.slice(0, 2_000) } : {}),
    }));
  }
  return session.mcpInventory ?? [];
}

export async function performSessionMcpAction(
  sessionId: string,
  serverId: string,
  action: NativeAgentMcpServerAction,
): Promise<{ url?: string }> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  let probe: Query | undefined;
  const control = session.queryControl ?? (probe = createProbe());
  try {
    if (action === "reconnect") await control.reconnectMcpServer?.(serverId);
    else if (action === "enable") await control.toggleMcpServer?.(serverId, true);
    else if (action === "disable") await control.toggleMcpServer?.(serverId, false);
    else {
      // Claude's OAuth URL is delivered by onElicitation; reconnecting a
      // needs-auth server is what asks the server to emit that request.
      await control.reconnectMcpServer?.(serverId);
    }
    if (control.mcpServerStatus) {
      session.mcpInventory = (await control.mcpServerStatus()).slice(0, 128).map(normalizeMcp);
    }
    return {};
  } finally {
    await Promise.resolve(probe?.close()).catch(() => undefined);
  }
}

function normalizeAccount(account: AccountInfo): NativeAgentAuthStatus {
  const source = account.apiKeySource ?? account.tokenSource;
  const signedIn = Boolean(
    source || account.subscriptionType || account.organization || account.apiProvider,
  );
  const label = account.organization || account.subscriptionType || account.apiProvider;
  return {
    state: signedIn ? "signed-in" : "needs-auth",
    ...(label
      ? {
          account: {
            label,
            ...(account.subscriptionType ? { plan: account.subscriptionType } : {}),
          },
        }
      : {}),
    signIn: {
      kind: "terminal",
      hint: "Open a Claude terminal tab and run /login.",
    },
    signOut: false,
  };
}

export async function readClaudeAuthStatus(): Promise<NativeAgentAuthStatus> {
  if (authCache && authCache.expiresAt > Date.now()) return authCache.value;
  let probe: Query | undefined;
  try {
    probe = createProbe();
    const value = normalizeAccount(await probe.accountInfo());
    authCache = { expiresAt: Date.now() + AUTH_CACHE_TTL_MS, value };
    return value;
  } catch {
    const value: NativeAgentAuthStatus = {
      state: "unknown",
      signIn: { kind: "terminal", hint: "Open a Claude terminal tab and run /login." },
      signOut: false,
    };
    authCache = { expiresAt: Date.now() + 5_000, value };
    return value;
  } finally {
    await Promise.resolve(probe?.close()).catch(() => undefined);
  }
}

export function steerClaudeSession(
  sessionId: string,
  text: string,
  requestId: string,
  expectedRunId: string,
): "applied" | "idle" | "mismatch" | "unknown" {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "running" || !session.queryControl?.pushInput) {
    rememberSteer(sessionId, requestId, "absent");
    return "idle";
  }
  if (String(session.latestTurnGeneration ?? "") !== expectedRunId) return "mismatch";
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    priority: "now",
    uuid: requestId as SDKUserMessage["uuid"],
    session_id: session.sdkSessionId,
  };
  const state = session.queryControl.pushInput(message) ? "dispatched" : "unknown";
  rememberSteer(sessionId, requestId, state);
  return state === "dispatched" ? "applied" : "unknown";
}

export async function configureClaudeSession(
  session: SessionState,
  input: {
    model?: string;
    effort?: string;
    fastMode?: boolean;
    permissionMode?: PermissionMode;
    parameterValues?: Record<string, string | boolean>;
  },
): Promise<void> {
  const control = session.queryControl;
  if (!control) return;
  if (input.model !== undefined) await control.setModel?.(input.model);
  if (input.permissionMode !== undefined) await control.setPermissionMode?.(input.permissionMode);
  const settings: Record<string, unknown> = {};
  if (input.effort !== undefined) settings.effortLevel = input.effort;
  if (input.fastMode !== undefined) settings.fastMode = input.fastMode;
  if (Object.keys(settings).length > 0) await control.applyFlagSettings?.(settings);
  const thinking = input.parameterValues?.thinking;
  if (thinking === "disabled") await control.setMaxThinkingTokens?.(0, "omitted");
  else if (thinking === "adaptive") await control.setMaxThinkingTokens?.(null, "summarized");
  else if (typeof thinking === "string" && thinking.startsWith("budget-")) {
    const tokens = Number(thinking.slice("budget-".length));
    if (Number.isSafeInteger(tokens) && tokens > 0) {
      await control.setMaxThinkingTokens?.(tokens, "summarized");
    }
  }
}

export async function gracefulInterruptClaudeSession(
  sessionId: string,
): Promise<{ interrupted: boolean; stillQueued: string[] }> {
  const control = sessions.get(sessionId)?.queryControl;
  if (!control?.interrupt) return { interrupted: false, stillQueued: [] };
  const receipt = await control.interrupt();
  return { interrupted: true, stillQueued: receipt?.still_queued ?? [] };
}
