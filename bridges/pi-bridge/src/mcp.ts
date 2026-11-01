/**
 * Bridge-owned MCP client for Pi.
 *
 * Pi's SDK sessions load no MCP client (only its CLI loads the built-in `mcp`
 * extension). This module connects the servers a
 * session is allowed to launch, registers their tools through the same
 * `extensionFactories` path as the approval gate, and forgets every client
 * on detach. Agent MCP down is a notice, not a failed attach.
 */
import { COORDINATOR_CONTROL_TOOL_NAMES } from "@orkestrator/protocol/coordinator";
import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { AGENT_GOAL_TOOL_NAMES } from "@orkestrator/protocol/native-agent-goal";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import {
  workflowResultTurnAllows,
  workflowResultTurnToolNames,
} from "@orkestrator/protocol/workflow-results";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  nativeAgentUserMcpGrant,
  nativeAgentWithholdsGitHubCredential,
  type NativeAgentMcpServer,
} from "@orkestrator/protocol/native-agent";
import { agentDirectory, workingDirectory } from "./config.js";
import {
  piWithheldGitHubCredential,
  withheldEnvironment,
  type WithheldGitHubCredential,
} from "./github-credential.js";
import {
  BRIDGE_SECRET_ENV,
  piUserMcpServerFilter,
  resolvePiMcpServers,
  sanitizeMcpName,
  type ResolvedMcpServer,
} from "./mcp-config.js";
import { getAgentDir } from "./pi-sdk.js";
import { isObject, type JsonObject, type SessionState } from "./state.js";
import { withTimeout } from "./timeout.js";

const CONNECT_TIMEOUT_MS = 3_000;
/**
 * Longest a detach waits for its MCP connections to close. A stdio server that
 * ignores its transport closing must not hold a rebuild, a session delete or
 * bridge shutdown hostage; after the deadline the close keeps running
 * unobserved (its rejection is still handled) and the caller moves on.
 */
const CLOSE_TIMEOUT_MS = 2_000;
/**
 * Connects in flight at once. Up to 64 servers may be configured, and each
 * stdio server is a child process: starting them all together turns one
 * attach into a fork storm and makes every connect race the same deadline.
 */
export const MAX_CONCURRENT_MCP_CONNECTS = 4;
const TOOL_CALL_TIMEOUT_MS = 120_000;
const MAX_MCP_TOOLS = 128;
const MAX_MCP_RESULT_BYTES = 50_000;
const MAX_MCP_DESCRIPTION_BYTES = 4_000;
const MAX_MCP_INSTRUCTIONS_BYTES = 8_000;
const MAX_MCP_SCHEMA_BYTES = 20_000;

/**
 * The Orkestrator MCP tools the coordinator read-only gate may exempt.
 *
 * Keyed on the *name the tool is registered under*, which a server chooses.
 * Exempting the whole Orkestrator scope let a server that advertised a tool
 * named after a Pi built-in place that name in the exempt set and unblock it
 * under `coordinator-read-only`. Namespacing is not an option here: the model
 * is told these tools by name, so the allowlist is the boundary.
 *
 * A coordinator holds a Control MCP credential, so the list is the Control MCP
 * coordinator tool set (shared with the backend, which tests it against what
 * it serves). The Agent Tools mail names stay for a tab-scoped credential.
 */
const COORDINATOR_MAIL_TOOLS = new Set<string>([
  ...COORDINATOR_CONTROL_TOOL_NAMES,
  "check_inbox",
  "read_message",
  "reply_message",
]);

/** Per-process timing budgets, overridable so a test need not wait them out. */
let connectTimeoutMs = CONNECT_TIMEOUT_MS;
let toolCallTimeoutMs = TOOL_CALL_TIMEOUT_MS;
let closeTimeoutMs = CLOSE_TIMEOUT_MS;

export function setPiMcpTimeoutsForTests(options?: {
  connectMs?: number;
  toolCallMs?: number;
  closeMs?: number;
}): void {
  connectTimeoutMs = options?.connectMs ?? CONNECT_TIMEOUT_MS;
  toolCallTimeoutMs = options?.toolCallMs ?? TOOL_CALL_TIMEOUT_MS;
  closeTimeoutMs = options?.closeMs ?? CLOSE_TIMEOUT_MS;
}

export interface PiMcpListedTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: unknown;
}

export interface PiMcpConnection {
  tools: PiMcpListedTool[];
  /** What the server's `initialize` result asks the model to know. */
  instructions?: string;
  call(name: string, args: JsonObject): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

/** How the bridge starts one server for one session. */
export interface PiMcpConnectContext {
  /** Set when the session withholds the GitHub credential (item 209). */
  withheldGitHubCredential?: WithheldGitHubCredential;
}

export interface PiMcpTransport {
  connect(server: ResolvedMcpServer, context?: PiMcpConnectContext): Promise<PiMcpConnection>;
}

interface RegisteredMcpTool {
  name: string;
  label: string;
  description: string;
  parameters: JsonObject;
  scope: ResolvedMcpServer["scope"];
  call(args: JsonObject): Promise<{ content?: unknown; isError?: boolean }>;
}

interface PiMcpRuntime {
  inventory: NativeAgentMcpServer[];
  orkestratorToolNames: Set<string>;
  /** Registered names of the coordinator's research server tools. */
  researchToolNames: Set<string>;
  /**
   * Registered names of tools from user servers a graph node was granted
   * (item 404). The read-only gate admits these like research tools.
   */
  grantedToolNames: Set<string>;
  /** Whether this generation's servers were selected by an explicit grant. */
  granted: boolean;
  tools: RegisteredMcpTool[];
  /** Each connected server's bounded instructions, in connection order. */
  instructions: Array<{ serverId: string; text: string }>;
  connections: PiMcpConnection[];
  /** The tab credential these connections were prepared with; "" for the env. */
  connectionKey: string;
  /** Fingerprint of the MCP files this generation was built from. */
  configKey: string;
  /** Per-file digests behind `configKey`, and when they were read. */
  configRevision?: PiMcpConfigRevision & { builtAt: string };
  /** Where those files were read, so a refresh check reads the same ones. */
  configPaths: { agentDir?: string; cwd?: string };
  /** Set once `closePiMcp` runs, so an in-flight connect closes on arrival. */
  closed: boolean;
  /** What this generation's servers are started without (item 209). */
  connectContext: PiMcpConnectContext;
}

const runtimes = new WeakMap<SessionState, PiMcpRuntime>();
let testTransport: PiMcpTransport | undefined;

export function setPiMcpTransportForTests(transport?: PiMcpTransport): void {
  testTransport = transport;
}

export function publicPiMcpServers(state: SessionState): NativeAgentMcpServer[] {
  return runtimes.get(state)?.inventory ?? [];
}

/**
 * A worker's Orkestrator mail or transcript-artifact tool. Always allowed,
 * whatever the session's approval policy: mail writes only to Orkestrator's
 * own message store and is how a worker reports back; artifact tools write
 * only to Orkestrator's bounded artifact store, never the workspace. Matched
 * by exact registered name from the Orkestrator server, never by prefix.
 */
export function isOrkestratorMailTool(state: SessionState, toolName: string): boolean {
  return (
    runtimes.get(state)?.orkestratorToolNames.has(toolName) === true &&
    ((AGENT_MAIL_TOOL_NAMES as readonly string[]).includes(toolName) ||
      (ARTIFACT_TOOL_NAMES as readonly string[]).includes(toolName) ||
      (AGENT_GOAL_TOOL_NAMES as readonly string[]).includes(toolName))
  );
}

/**
 * A call to the current turn's own workflow-result attempt: each result
 * slot's submission and validation tool, status, for a reviewer
 * `report_finding`, and a graph activation's listed extra tools. The turn
 * must have declared the attempt on its prompt, the tool must come from the
 * Orkestrator server, and the call must name the turn's own result key for
 * that tool (`workflowResultTurnAllows`).
 * These tools exist only on that attempt's capability and write nothing in the
 * workspace, so a read-only turn may call them under any approval policy, like
 * a worker's mail. An explicit `toolPolicy` deny still wins.
 */
export function isOwnWorkflowResultCall(
  state: SessionState,
  toolName: string,
  input: unknown,
): boolean {
  const turn = state.workflowResultTurn;
  return (
    turn !== undefined &&
    workflowResultTurnToolNames(turn).includes(toolName) &&
    runtimes.get(state)?.orkestratorToolNames.has(toolName) === true &&
    !state.policy?.toolPolicy?.deny?.includes(toolName) &&
    workflowResultTurnAllows(turn, toolName, input)
  );
}

/**
 * A transcript-artifact tool from an Orkestrator server. It writes only to
 * Orkestrator's bounded artifact store, never the workspace, so a read-only
 * review turn may call it like its own result tools. An explicit
 * `toolPolicy` deny still wins.
 */
export function isOrkestratorArtifactTool(state: SessionState, toolName: string): boolean {
  return (
    runtimes.get(state)?.orkestratorToolNames.has(toolName) === true &&
    (ARTIFACT_TOOL_NAMES as readonly string[]).includes(toolName) &&
    !state.policy?.toolPolicy?.deny?.includes(toolName)
  );
}

/**
 * A tool from one of the coordinator's research servers, by the exact name it
 * was registered under. Those servers are remote HTTPS endpoints the launcher
 * named; their tools read documentation and cannot reach the checkout.
 */
export function isResearchMcpTool(state: SessionState, toolName: string): boolean {
  return runtimes.get(state)?.researchToolNames.has(toolName) === true;
}

/**
 * A tool from a user MCP server the session's policy grants by name (graphs
 * item 404), by the exact name it was registered under. Only granted servers
 * were started for such a session, so every user or project tool is one.
 */
export function isGrantedUserMcpTool(state: SessionState, toolName: string): boolean {
  return runtimes.get(state)?.grantedToolNames.has(toolName) === true;
}

export function isOrkestratorMcpTool(state: SessionState, toolName: string): boolean {
  const runtime = runtimes.get(state);
  return (
    runtime?.orkestratorToolNames.has(toolName) === true && COORDINATOR_MAIL_TOOLS.has(toolName)
  );
}

/**
 * Whether the live connections were prepared with a different tab credential
 * than the one currently on the session.
 *
 * A rotated token updates `state.agentMcp` but leaves the attached Pi session's
 * MCP extension pointed at the old connection, so the caller has to rebuild the
 * session. A session with no live runtime needs no refresh: the next attach
 * prepares from whatever `state.agentMcp` holds.
 */
export function mcpConnectionNeedsRefresh(state: SessionState): boolean {
  const runtime = runtimes.get(state);
  return runtime !== undefined && runtime.connectionKey !== mcpConnectionKey(state);
}

/** One MCP file's identity: `sha256:<base64url>` of its bytes, `absent`, or `excluded` by policy. */
export type PiMcpSourceDigest = string;

/**
 * Content-free identity of the MCP files a generation was built from.
 *
 * Digests are sha256 (base64url) of the exact bytes, so the backend — which
 * knows what it wrote — can tell whether a live generation picked a save up.
 * Never a path, never a server body: these files hold env values and headers.
 */
export interface PiMcpConfigRevision {
  /** One opaque value over both sources; changes when either does. */
  fingerprint: string;
  sources: {
    /** `<agentDir>/mcp.json`. */
    user: PiMcpSourceDigest;
    /** `<cwd>/.pi/mcp.json`; `excluded` unless the session loads project resources. */
    project: PiMcpSourceDigest;
  };
}

async function fileDigest(file: string): Promise<PiMcpSourceDigest> {
  try {
    return `sha256:${createHash("sha256")
      .update(await readFile(file))
      .digest("base64url")}`;
  } catch {
    return "absent";
  }
}

/** Per-file digests of the MCP configuration a session reads. */
export async function piMcpConfigRevision(
  state: SessionState,
  options: { agentDir?: string; cwd?: string } = {},
): Promise<PiMcpConfigRevision> {
  const agentDir = options.agentDir ?? agentDirectory() ?? getAgentDir();
  const [user, project] = await Promise.all([
    fileDigest(join(agentDir, "mcp.json")),
    state.policy?.projectResources === true
      ? fileDigest(join(options.cwd ?? workingDirectory, ".pi", "mcp.json"))
      : Promise.resolve("excluded"),
  ]);
  return {
    fingerprint: createHash("sha256")
      .update(`user=${user}\u0000project=${project}`)
      .digest("base64url"),
    sources: { user, project },
  };
}

/**
 * Fingerprint of the MCP configuration files a session reads. Orkestrator's
 * settings (or the user's editor) can change them while a session is attached,
 * and Pi fixes tool registrations when the session is created, so a changed
 * fingerprint means the next safe boundary has to rebuild the session.
 */
export async function piMcpConfigFingerprint(
  state: SessionState,
  options: { agentDir?: string; cwd?: string } = {},
): Promise<string> {
  return (await piMcpConfigRevision(state, options)).fingerprint;
}

/**
 * Which saved MCP configuration the attached generation was built from, for
 * `/session/:id/runtime-health`. Absent while no generation is attached — a
 * detached session has loaded nothing, which is how the backend tells "not
 * yet applied" from "applied". Content-free digests only.
 */
export function publicPiMcpConfig(
  state: SessionState,
): (PiMcpConfigRevision & { builtAt: string }) | undefined {
  if (!state.session) return undefined;
  const runtime = runtimes.get(state);
  if (!runtime || runtime.closed || !runtime.configRevision) return undefined;
  return structuredClone(runtime.configRevision);
}

/** Whether the saved MCP files changed since the live connections were built. */
export async function mcpConfigNeedsRefresh(state: SessionState): Promise<boolean> {
  const runtime = runtimes.get(state);
  if (!runtime) return false;
  return runtime.configKey !== (await piMcpConfigFingerprint(state, runtime.configPaths));
}

/** Any change, the artifact grant included, rebuilds the connections. */
function mcpConnectionKey(state: SessionState): string {
  const key = state.agentMcp
    ? JSON.stringify([
        state.agentMcp.url,
        state.agentMcp.token,
        state.agentMcp.artifacts?.token ?? null,
      ])
    : "";
  // A policy that starts or stops withholding the GitHub credential (item
  // 209) needs a new generation: the shell tools and the servers' environment
  // are fixed when a session is built.
  return nativeAgentWithholdsGitHubCredential(state.policy) ? `${key}|withhold-github` : key;
}

export async function preparePiMcp(
  state: SessionState,
  options: { agentDir?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const previous = runtimes.get(state);
  if (previous) previous.closed = true;
  const runtime: PiMcpRuntime = {
    inventory: [],
    orkestratorToolNames: new Set(),
    researchToolNames: new Set(),
    grantedToolNames: new Set(),
    granted: nativeAgentUserMcpGrant(state.policy) !== undefined,
    tools: [],
    instructions: [],
    connections: [],
    connectionKey: mcpConnectionKey(state),
    configKey: "",
    configPaths: { agentDir: options.agentDir, cwd: options.cwd },
    closed: false,
    connectContext: {},
  };
  // Registered synchronously, before the first await. A detach that races this
  // call then finds the new runtime and can mark it closed, so a connection
  // that lands afterwards closes rather than leaking. Closing the previous
  // generation here, rather than through `closePiMcp`, is what keeps that from
  // closing the runtime this call just installed.
  runtimes.set(state, runtime);
  if (previous) await closeConnections(state, previous.connections);
  // Fingerprint before reading, so an edit racing this read is seen as a
  // change at the next boundary rather than missed. `builtAt` is taken before
  // the read too: it is a lower bound on when these bytes were read.
  const builtAt = new Date().toISOString();
  const revision = await piMcpConfigRevision(state, options);
  runtime.configKey = revision.fingerprint;
  runtime.configRevision = { ...revision, builtAt };
  // A session that withholds the GitHub credential (item 209) resolves its
  // servers' `$NAME` references against the withheld environment, so an entry
  // that names a credential variable is skipped, and starts stdio servers
  // with it.
  const withheld = await piWithheldGitHubCredential(state.policy);
  if (withheld) runtime.connectContext = { withheldGitHubCredential: withheld };
  const env = options.env ?? process.env;
  const servers = await resolvePiMcpServers({
    agentDir: options.agentDir ?? agentDirectory() ?? getAgentDir(),
    cwd: options.cwd ?? workingDirectory,
    projectResources: state.policy?.projectResources === true,
    agentMcp: state.agentMcp,
    env: withheld ? withheldEnvironment(env, withheld) : options.env,
    allowServer: piUserMcpServerFilter(state.policy),
  });
  // Every failure settles into that server's inventory row, so one malformed
  // server cannot fail the attach or strand the servers queued behind it.
  const connected = await mapWithConcurrency(servers, MAX_CONCURRENT_MCP_CONNECTS, (server) =>
    connectAndRegister(state, runtime, server).catch((error: unknown) =>
      recordConnectFailure(state, server, error),
    ),
  );
  if (!runtime.closed) runtime.inventory = connected;
}

export function piMcpExtension(state: SessionState): (pi: ExtensionAPI) => void {
  return (pi) => {
    for (const tool of runtimes.get(state)?.tools ?? []) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_toolCallId, params) => {
          // A hung Orkestrator or user MCP tool must not stall the whole turn
          // behind it. The real transport also aborts its own request; this
          // bounds every transport, including a test double.
          const result = await withTimeout(
            tool.call(isObject(params) ? params : {}),
            toolCallTimeoutMs,
            `MCP tool ${tool.name} timed out`,
          );
          const text = formatMcpContent(result);
          if (result.isError) throw new Error(text);
          return { content: [{ type: "text" as const, text }], details: {} };
        },
      });
    }
  };
}

/**
 * The instructions this session's connected MCP servers returned on
 * `initialize`, as one system prompt block, or undefined when none did. Pi's
 * SDK loads no MCP client, so without this the model would get each server's
 * tools but never what the server says about using them (the Orkestrator
 * server's mailbox address and artifact flow among them). Claude, Codex and
 * the other providers' own MCP clients deliver the same text.
 */
export function piMcpInstructions(state: SessionState): string | undefined {
  const entries = runtimes.get(state)?.instructions ?? [];
  if (entries.length === 0) return undefined;
  return [
    "# MCP Server Instructions",
    "The following MCP servers have provided instructions for how to use their tools and resources:",
    ...entries.map((entry) => `## ${entry.serverId}\n${entry.text}`),
  ].join("\n\n");
}

export async function closePiMcp(state: SessionState): Promise<void> {
  const runtime = runtimes.get(state);
  if (runtime) runtime.closed = true;
  runtimes.delete(state);
  if (!runtime) return;
  await closeConnections(state, runtime.connections);
}

/**
 * Run `work` over `items` with at most `limit` in flight, keeping input order.
 *
 * A rejected item fails the whole call like `Promise.all`; the only caller
 * passes a function that already settles every failure into an inventory row.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()),
  );
  return results;
}

/**
 * Close every connection, waiting at most `closeTimeoutMs` for all of them.
 *
 * `allSettled` attaches a handler to every close before the race, so a close
 * that rejects after the deadline is still observed rather than becoming an
 * unhandled rejection; a close that throws synchronously is caught the same
 * way. Returns without waiting for stragglers, and says so in health.
 */
async function closeConnections(
  state: SessionState,
  connections: readonly PiMcpConnection[],
): Promise<void> {
  if (connections.length === 0) return;
  const settled = Promise.allSettled(
    connections.map(async (connection) => {
      await connection.close();
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), closeTimeoutMs);
    timer.unref();
  });
  const outcome = await Promise.race([settled.then(() => "closed" as const), deadline]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") {
    state.health.recordNotice({
      message: "An MCP server did not close in time; the bridge moved on without waiting",
      method: "mcp/close",
      severity: "warning",
      source: "bridge",
    });
  }
}

async function connectAndRegister(
  state: SessionState,
  runtime: PiMcpRuntime,
  server: ResolvedMcpServer,
): Promise<NativeAgentMcpServer> {
  // Detached while this server waited for a connect slot: never start it.
  if (runtime.closed) return detachedServer(server);
  let connection: PiMcpConnection | undefined;
  try {
    connection = await connectWithTimeout(
      testTransport ?? defaultTransport,
      server,
      runtime.connectContext,
    );
  } catch (error) {
    return recordConnectFailure(state, server, error);
  }
  // Detached while connecting. Closing here is what keeps a slow first launch
  // from leaking a child process that nothing owns any more.
  if (runtime.closed) {
    await closeConnections(state, [connection]);
    return detachedServer(server);
  }
  runtime.connections.push(connection);
  const instructions = connection.instructions?.trim();
  if (instructions) {
    runtime.instructions.push({
      serverId: server.id,
      text:
        instructions.length > MAX_MCP_INSTRUCTIONS_BYTES
          ? instructions.slice(0, MAX_MCP_INSTRUCTIONS_BYTES)
          : instructions,
    });
  }
  const tools = connection.tools.slice(0, MAX_MCP_TOOLS);
  const names: string[] = [];
  for (const listed of tools) {
    const registered = registerListedTool(server, listed, connection);
    if (!registered) continue;
    runtime.tools.push(registered);
    names.push(registered.name);
    if (server.scope === "orkestrator") runtime.orkestratorToolNames.add(registered.name);
    if (server.scope === "research") runtime.researchToolNames.add(registered.name);
    if (runtime.granted && (server.scope === "user" || server.scope === "project")) {
      runtime.grantedToolNames.add(registered.name);
    }
  }
  return {
    id: server.id,
    name: server.id,
    status: "connected",
    scope: publicMcpScope(server.scope),
    transport: server.transport,
    toolCount: names.length,
    tools: names,
    actions: [],
  };
}

/**
 * The scope an inventory row reports. Research servers are configured in
 * Orkestrator's own settings, not in a Pi file, so they are reported as
 * Orkestrator's.
 */
function publicMcpScope(scope: ResolvedMcpServer["scope"]): NativeAgentMcpServer["scope"] {
  return scope === "research" ? "orkestrator" : scope;
}

function detachedServer(server: ResolvedMcpServer): NativeAgentMcpServer {
  return {
    id: server.id,
    name: server.id,
    status: "failed",
    scope: publicMcpScope(server.scope),
    transport: server.transport,
    error: "MCP connection was detached before it completed",
    actions: [],
  };
}

function recordConnectFailure(
  state: SessionState,
  server: ResolvedMcpServer,
  error: unknown,
): NativeAgentMcpServer {
  state.health.recordNotice({
    message: `MCP server ${server.id} failed to connect; the session will continue without it`,
    method: "mcp/connect",
    severity: "warning",
    source: "bridge",
    detail: publicMcpError(error),
  });
  return {
    id: server.id,
    name: server.id,
    status: "failed",
    scope: publicMcpScope(server.scope),
    transport: server.transport,
    error: publicMcpError(error),
    actions: [],
  };
}

/**
 * Connect one server, and close the connection if it arrives after the
 * deadline.
 *
 * `withTimeout` alone discards a late success, which leaves an unowned child
 * process and an open transport. Racing a rejecting deadline and closing the
 * loser on arrival is what makes the fail-open path leak nothing.
 */
async function connectWithTimeout(
  transport: PiMcpTransport,
  server: ResolvedMcpServer,
  context: PiMcpConnectContext,
): Promise<PiMcpConnection> {
  const attempt = transport.connect(server, context);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`MCP server ${server.id} timed out`));
    }, connectTimeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([attempt, deadline]);
  } catch (error) {
    if (timedOut) {
      void attempt.then(
        (late) => late.close().catch(() => undefined),
        () => undefined,
      );
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function registerListedTool(
  server: ResolvedMcpServer,
  listed: PiMcpListedTool,
  connection: PiMcpConnection,
): RegisteredMcpTool | undefined {
  const remoteName = listed.name.trim();
  if (!remoteName) return undefined;
  const name =
    server.scope === "orkestrator"
      ? sanitizeMcpName(remoteName)
      : prefixedToolName(server.id, remoteName);
  if (!name) return undefined;
  return {
    name,
    label: listed.title?.trim() || remoteName,
    description: boundedDescription(listed.description, `MCP tool ${remoteName} from ${server.id}`),
    parameters: toolParameters(listed.inputSchema),
    scope: server.scope,
    call: (args) => connection.call(remoteName, args),
  };
}

function prefixedToolName(serverId: string, toolName: string): string | undefined {
  const tool = sanitizeMcpName(toolName);
  return tool ? `mcp_${serverId}_${tool}` : undefined;
}

/**
 * A description a remote server sends goes straight into every model request,
 * so it is bounded like every other untrusted field in this module.
 */
function boundedDescription(value: string | undefined, fallback: string): string {
  const text = value?.trim() || fallback;
  return text.length > MAX_MCP_DESCRIPTION_BYTES ? text.slice(0, MAX_MCP_DESCRIPTION_BYTES) : text;
}

function toolParameters(schema: unknown): JsonObject {
  if (!isObject(schema) || schema.type !== "object") {
    return { type: "object", properties: {} };
  }
  try {
    if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_MCP_SCHEMA_BYTES) {
      return { type: "object", properties: {} };
    }
  } catch {
    return { type: "object", properties: {} };
  }
  return schema;
}

const defaultTransport: PiMcpTransport = {
  async connect(server, context) {
    const client = new McpClient(
      { name: "orkestrator-pi-bridge", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport =
      server.transport === "http" && server.url
        ? new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: server.headers ? { headers: server.headers } : undefined,
          })
        : new StdioClientTransport({
            command: server.command ?? "",
            ...(server.args ? { args: server.args } : {}),
            env: stdioEnvironment(server.env, context),
            stderr: "ignore",
            cwd: server.cwd ? resolvePath(workingDirectory, server.cwd) : workingDirectory,
          });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const instructions = client.getInstructions();
      return {
        ...(instructions ? { instructions } : {}),
        tools: (listed.tools ?? []).map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(typeof tool.title === "string" ? { title: tool.title } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        })),
        call: async (name, args) => {
          // Abort the wire request if it outlives the tool budget; the extension
          // wrapper bounds every transport, but only the real client can cancel
          // the in-flight request itself.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), toolCallTimeoutMs);
          timer.unref();
          try {
            const result = await client.callTool(
              { name, arguments: args },
              { signal: controller.signal },
            );
            return {
              content: result.content,
              ...(result.isError === true ? { isError: true } : {}),
            };
          } finally {
            clearTimeout(timer);
          }
        },
        close: () => client.close(),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  },
};

/**
 * A stdio server's environment: the bridge's own without its secrets, then
 * without the GitHub credential when the session withholds it (item 209),
 * then the entry's own `env`, which the user wrote and which wins.
 */
export function stdioEnvironment(
  overlay?: Record<string, string>,
  context: PiMcpConnectContext = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || BRIDGE_SECRET_ENV.has(key)) continue;
    env[key] = value;
  }
  const base = context.withheldGitHubCredential
    ? withheldEnvironment(env, context.withheldGitHubCredential)
    : env;
  return { ...base, ...overlay };
}

function formatMcpContent(result: { content?: unknown }): string {
  if (Array.isArray(result.content)) {
    const parts = result.content.flatMap((item) =>
      isObject(item) && typeof item.text === "string" ? [item.text] : [],
    );
    if (parts.length > 0) return parts.join("\n").slice(0, MAX_MCP_RESULT_BYTES);
  }
  try {
    return JSON.stringify(result).slice(0, MAX_MCP_RESULT_BYTES);
  } catch {
    return "(empty MCP result)";
  }
}

function publicMcpError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // The shared rules cover bearer tokens and the other credential shapes an
  // MCP server's error can echo (keys in URLs, headers, provider tokens).
  return redactSecrets(text).slice(0, 500);
}
