import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type {
  ControlMcpCredentialPolicy,
  ControlMcpCredentialSummary,
} from "@orkestrator/protocol/control-mcp";
import { COORDINATOR_ASYNC_CONTRACT } from "@orkestrator/protocol/coordinator";
import { ConfirmTokens } from "./control-mcp-confirm.js";
import {
  ControlMcpCredentialStore,
  DEFAULT_CONTROL_MCP_CREDENTIAL_ID,
  writeControlMcpDescriptor,
  type CreateControlMcpCredentialInput,
  type StoredControlMcpCredential,
} from "./control-mcp-credentials.js";
import type { ControlMcpCaller } from "./control-mcp-caller.js";
import { createNodeTargets } from "./control-mcp-nodes.js";
import { controlMcpAuthority } from "./public-api/operation-ledger.js";
import {
  COORDINATOR_CAPABILITIES,
  coordinatorToolGranted,
  createControlMcp,
  type CoordinatorControlScope,
  type CoordinatorPollGuard,
} from "./control-mcp-tools.js";
import { isRecord, type JsonRecord } from "./control-mcp-tool-support.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";
import {
  callToolInProcess,
  listToolsInProcess,
  type InProcessToolInfo,
  type InProcessToolResult,
} from "./mcp-in-process.js";

const CONTROL_MCP_PATH = "/mcp";
const CONTROL_MCP_DESCRIPTOR = "control-mcp.json";
export const DEFAULT_CONTROL_MCP_PORT = 34_122;
const MAX_REQUEST_BYTES = 1024 * 1024;
const COORDINATOR_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_COORDINATOR_CREDENTIALS = 512;
/**
 * How many identical answers a conversation may collect before it is told to
 * stop asking, and how long that judgement stands.
 */
const COORDINATOR_POLL_BUDGET = 3;
const COORDINATOR_POLL_WINDOW_MS = 120_000;
const MAX_COORDINATOR_POLL_ENTRIES = 256;

export type ControlMcpInfo = {
  url: string;
  descriptorFile: string;
};

export type ControlMcpSettings = {
  enabled: boolean;
  running: boolean;
  url: string;
  /** The `default` credential's token, for clients set up before named credentials. */
  token: string;
  error: string | null;
  /** Every operator credential, with its token so Copy setup works. */
  credentials: ControlMcpCredentialSummary[];
};

export type ControlMcpServerOptions = {
  bindAddress?: string;
  port?: number;
};

export type CoordinatorControlConnection = {
  url: string;
  token: string;
};

export type { ControlMcpInvoker } from "./control-shared-actions.js";
export type { CoordinatorControlScope } from "./control-mcp-tools.js";
export { readControlMcpDescriptor } from "./control-mcp-credentials.js";

function configuredControlMcpPort(): number {
  const configured = process.env.ORKESTRATOR_CONTROL_MCP_PORT?.trim();
  if (!configured) return DEFAULT_CONTROL_MCP_PORT;
  if (!/^\d+$/.test(configured)) throw new Error("ORKESTRATOR_CONTROL_MCP_PORT is invalid");
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ORKESTRATOR_CONTROL_MCP_PORT is invalid");
  }
  return port;
}

/**
 * The port a backend asks for instead of the configured one, or undefined.
 *
 * The installed app owns the fixed port. The test runner and every agent-test
 * backend (fixtures, dev profiles, qualification services, headless backends an
 * agent starts) take an ephemeral one, so none of them can hold the user's port:
 * a forgotten qualification service once kept it for hours and the desktop came
 * up without a control MCP. An explicit ORKESTRATOR_CONTROL_MCP_PORT still wins
 * outside the test runner.
 */
export function controlMcpPortOverride(
  runtimeFlavor: "production" | "development" | "agent-test" | undefined,
  env: NodeJS.ProcessEnv,
): 0 | undefined {
  if (env.NODE_ENV === "test") return 0;
  if (runtimeFlavor === "agent-test" && !env.ORKESTRATOR_CONTROL_MCP_PORT?.trim()) return 0;
  return undefined;
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization || Array.isArray(authorization)) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
  return match?.[1] ?? null;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      request.resume();
      throw new Error("Control MCP request body is too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error("Control MCP request body must be valid JSON");
  }
}

function jsonResponse(response: ServerResponse, status: number, body: JsonRecord): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export class ControlMcpServer {
  private server: Server | null = null;
  private readonly credentials = new ControlMcpCredentialStore(() => this.persistCredentials());
  private credentialsLoaded = false;
  /** Per process: a restart invalidates outstanding confirm tokens. */
  private readonly confirmTokens = new ConfirmTokens();
  private info: ControlMcpInfo | null = null;
  private startError: string | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly bindAddress: string;
  private readonly port: number;
  private readonly coordinatorCredentials = new Map<
    string,
    { scope: CoordinatorControlScope; expiresAt: number }
  >();
  /**
   * Repeated-unchanged-read counters, per conversation and read.
   *
   * Lives here rather than on the MCP server because that one is rebuilt for
   * every request — a counter kept there would reset on each call and never
   * observe a loop at all.
   */
  private readonly coordinatorPolls = new Map<
    string,
    { fingerprint: string; unchanged: number; windowStartedAt: number }
  >();

  constructor(
    private readonly dataDir: string,
    private readonly invoke: ControlMcpInvoker,
    options: ControlMcpServerOptions = {},
  ) {
    this.bindAddress = options.bindAddress ?? "127.0.0.1";
    this.port = options.port ?? configuredControlMcpPort();
  }

  getInfo(): ControlMcpInfo | null {
    return this.info;
  }

  getSettings(): ControlMcpSettings {
    const enabled = process.env.ORKESTRATOR_CONTROL_MCP_DISABLED !== "1";
    return {
      enabled,
      running: Boolean(this.server),
      url: this.info?.url ?? this.configuredUrl(),
      token: enabled ? (this.credentials.get(DEFAULT_CONTROL_MCP_CREDENTIAL_ID)?.token ?? "") : "",
      error: this.startError,
      credentials: enabled ? this.credentials.summaries() : [],
    };
  }

  /** Create a named operator credential; its token is returned once here and in settings. */
  async createCredential(input: CreateControlMcpCredentialInput): Promise<ControlMcpSettings> {
    await this.mutateCredentials(() => this.credentials.create(input));
    return this.getSettings();
  }

  /** Replace one credential's token; every other client keeps working. */
  async rotateCredential(credentialId: string): Promise<ControlMcpSettings> {
    await this.mutateCredentials(() => this.credentials.rotate(credentialId));
    return this.getSettings();
  }

  /** Remove one credential; its client is refused from the next request. */
  async revokeCredential(credentialId: string): Promise<ControlMcpSettings> {
    await this.mutateCredentials(() => this.credentials.revoke(credentialId));
    return this.getSettings();
  }

  private async mutateCredentials(change: () => Promise<unknown>): Promise<void> {
    const run = this.lifecycle.then(async () => {
      if (process.env.ORKESTRATOR_CONTROL_MCP_DISABLED === "1") {
        throw new Error("Orkestrator control MCP is disabled");
      }
      // Never write a list that was not read first: that would drop every
      // stored credential.
      if (!this.credentialsLoaded) {
        await this.credentials.load(path.join(this.dataDir, CONTROL_MCP_DESCRIPTOR));
        this.credentialsLoaded = true;
      }
      await change();
    });
    this.lifecycle = run.catch(() => undefined);
    await run;
  }

  /**
   * The per-conversation poll guard handed to one request's MCP server.
   *
   * Bounded on both axes: one entry per conversation and exact read input, and
   * the whole table is dropped when a credential is revoked. The budget is small
   * on purpose — a turn legitimately reads its inbox once on entry and once
   * before it finishes, so the fourth identical answer in two minutes is a wait
   * loop, not work.
   */
  private coordinatorPollGuard(scope: CoordinatorControlScope): CoordinatorPollGuard {
    return (read, fingerprint) => {
      const key = `${scope.coordinatorId}:${scope.conversationId}:${read}`;
      const now = Date.now();
      const previous = this.coordinatorPolls.get(key);
      if (
        !previous ||
        previous.fingerprint !== fingerprint ||
        now - previous.windowStartedAt > COORDINATOR_POLL_WINDOW_MS
      ) {
        this.coordinatorPolls.set(key, { fingerprint, unchanged: 1, windowStartedAt: now });
        if (this.coordinatorPolls.size > MAX_COORDINATOR_POLL_ENTRIES) {
          const oldest = Array.from(this.coordinatorPolls.entries()).sort(
            (a, b) => a[1].windowStartedAt - b[1].windowStartedAt,
          )[0];
          if (oldest) this.coordinatorPolls.delete(oldest[0]);
        }
        return null;
      }
      previous.unchanged += 1;
      if (previous.unchanged <= COORDINATOR_POLL_BUDGET) return null;
      return {
        repeatedRead: true,
        instruction: COORDINATOR_ASYNC_CONTRACT,
      };
    };
  }

  issueCoordinatorCredential(scope: CoordinatorControlScope): CoordinatorControlConnection {
    if (!this.server || !this.info || process.env.ORKESTRATOR_CONTROL_MCP_DISABLED === "1") {
      throw new Error("Orkestrator control MCP is disabled or unavailable");
    }
    if (
      scope.capabilities.length === 0 ||
      scope.capabilities.some((capability) => !COORDINATOR_CAPABILITIES.has(capability))
    ) {
      throw new Error("Coordinator capabilities are invalid");
    }
    this.revokeCoordinatorCredentials(scope.coordinatorId, scope.conversationId);
    while (this.coordinatorCredentials.size >= MAX_COORDINATOR_CREDENTIALS) {
      const oldest = this.coordinatorCredentials.keys().next().value;
      if (!oldest) break;
      this.coordinatorCredentials.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.coordinatorCredentials.set(token, {
      scope: Object.freeze({ ...scope }),
      expiresAt: Date.now() + COORDINATOR_CREDENTIAL_TTL_MS,
    });
    return { url: this.info.url, token };
  }

  revokeCoordinatorCredentials(coordinatorId: string, conversationId?: string): void {
    for (const [token, credential] of this.coordinatorCredentials) {
      const scope = credential.scope;
      if (
        scope.coordinatorId === coordinatorId &&
        (conversationId === undefined || scope.conversationId === conversationId)
      ) {
        this.coordinatorCredentials.delete(token);
      }
    }
    // A conversation that lost its credential is starting over. Carrying its
    // poll history forward would refuse the first read of the next one.
    for (const key of this.coordinatorPolls.keys()) {
      if (
        key.startsWith(
          conversationId === undefined
            ? `${coordinatorId}:`
            : `${coordinatorId}:${conversationId}:`,
        )
      ) {
        this.coordinatorPolls.delete(key);
      }
    }
  }

  async start(): Promise<void> {
    const start = this.lifecycle.then(async () => {
      if (this.server) return;
      const descriptorFile = path.join(this.dataDir, CONTROL_MCP_DESCRIPTOR);
      if (process.env.ORKESTRATOR_CONTROL_MCP_DISABLED === "1") {
        this.startError = null;
        return;
      }
      await this.credentials.load(descriptorFile);
      this.credentialsLoaded = true;
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            jsonResponse(response, 500, {
              error: error instanceof Error ? error.message : "Control MCP request failed",
            });
          } else {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, this.bindAddress, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error("Control MCP server did not receive a TCP port");
      }
      this.server = server;
      server.unref();
      this.startError = null;
      this.info = {
        url: `http://${this.bindAddress}:${address.port}${CONTROL_MCP_PATH}`,
        descriptorFile,
      };
      try {
        await this.credentials.flush(true);
      } catch (error) {
        this.server = null;
        this.info = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      }
    });
    this.lifecycle = start.catch(() => undefined);
    try {
      await start;
    } catch (error) {
      this.startError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const stop = this.lifecycle.then(async () => {
      const server = this.server;
      this.server = null;
      this.coordinatorCredentials.clear();
      try {
        if (server) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections?.();
          });
        }
        await this.credentials.dispose();
      } finally {
        this.info = null;
      }
    });
    this.lifecycle = stop.catch(() => undefined);
    await stop;
  }

  /** Rotate the `default` credential (the original single token). */
  async rotateToken(): Promise<ControlMcpSettings> {
    return this.rotateCredential(DEFAULT_CONTROL_MCP_CREDENTIAL_ID);
  }

  private configuredUrl(): string {
    const port = this.port === 0 ? "<dynamic>" : String(this.port);
    return `http://${this.bindAddress}:${port}${CONTROL_MCP_PATH}`;
  }

  private async persistCredentials(): Promise<void> {
    await writeControlMcpDescriptor(
      this.info?.descriptorFile ?? path.join(this.dataDir, CONTROL_MCP_DESCRIPTOR),
      {
        version: 2,
        url: this.info?.url ?? this.configuredUrl(),
        pid: process.pid,
        credentials: [...this.credentials.list()],
      },
    );
  }

  private operatorCaller(
    credential: StoredControlMcpCredential,
    messagingEnabled: boolean,
  ): ControlMcpCaller {
    return {
      credential,
      profile: credential.profile,
      authority: controlMcpAuthority(credential.id),
      invoke: this.invoke,
      confirmTokens: this.confirmTokens,
      messagingEnabled,
    };
  }

  /**
   * Revalidates a coordinator scope against the stored workspace and returns
   * the command invoker its tools run through: every project, environment
   * and command it names is checked at this boundary.
   */
  private async coordinatorInvoker(
    coordinatorScope: CoordinatorControlScope,
  ): Promise<
    { ok: true; invoke: ControlMcpInvoker } | { ok: false; status: 401 | 409; error: string }
  > {
    const snapshot = await this.invoke<unknown>("get_project_coordinator", {
      projectId: coordinatorScope.projectId,
    });
    const workspace =
      isRecord(snapshot) && isRecord(snapshot.workspace) ? snapshot.workspace : null;
    const conversations =
      workspace && Array.isArray(workspace.conversations) ? workspace.conversations : [];
    const conversation = conversations.find(
      (item) => isRecord(item) && item.id === coordinatorScope.conversationId,
    );
    if (
      !workspace ||
      workspace.id !== coordinatorScope.coordinatorId ||
      !isRecord(conversation) ||
      conversation.closedAt !== undefined ||
      conversation.mailboxIncarnationId !== coordinatorScope.mailboxIncarnationId
    ) {
      return { ok: false, status: 401, error: "Coordinator credential is no longer valid" };
    }
    if (workspace.lifecycleState !== "ready") {
      return { ok: false, status: 409, error: "Coordinator is paused or unavailable" };
    }
    const invoke: ControlMcpInvoker = async <T>(
      command: string,
      args: Record<string, unknown> = {},
    ) => {
      const projectId = typeof args.projectId === "string" ? args.projectId : undefined;
      if (projectId && projectId !== coordinatorScope.projectId) {
        throw new Error("Coordinator credential cannot access another project");
      }
      if (typeof args.environmentId === "string") {
        const ownRuntime = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
        if (args.environmentId !== ownRuntime) {
          const target =
            typeof args.nodeId === "string"
              ? await createNodeTargets(this.invoke, coordinatorScope).targetOrSelf(args.nodeId)
              : null;
          const environment = target
            ? await target.environment(args.environmentId)
            : await this.invoke<unknown>("get_environment", {
                environmentId: args.environmentId,
              });
          if (
            !isRecord(environment) ||
            environment.projectId !== (target?.projectId ?? coordinatorScope.projectId)
          ) {
            throw new Error("Coordinator credential cannot access that environment");
          }
          // The project home runs writable sessions in the checkout the
          // coordinator may only read. Delegating to it would bypass that
          // boundary, so it is never a worker.
          if (environment.projectHome === true) {
            throw new Error("Coordinator credential cannot act on the project checkout");
          }
        }
      }
      const denied = new Set([
        "update_config",
        "remove_project",
        "merge_environment",
        "delete_environment",
        "write_file",
        "move_file",
        // Only the user approves a request; a coordinator only creates one.
        "resolve_node_action_request",
      ]);
      if (denied.has(command)) throw new Error("Coordinator capability denied");
      return this.invoke<T>(command, args);
    };
    return { ok: true, invoke };
  }

  private coordinatorServer(coordinatorScope: CoordinatorControlScope, invoke: ControlMcpInvoker) {
    return () => createControlMcp(invoke, coordinatorScope, undefined, undefined);
  }

  /**
   * Runs one coordinator tool in-process for a scheduled job, through the
   * same scope revalidation, capability check and command boundary as an
   * HTTP request with that coordinator's credential.
   */
  async callCoordinatorTool(
    coordinatorScope: CoordinatorControlScope,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<InProcessToolResult> {
    if (!coordinatorToolGranted(coordinatorScope, tool)) {
      return { isError: true, text: "capability-denied: Coordinator capability denied" };
    }
    const checked = await this.coordinatorInvoker(coordinatorScope);
    if (!checked.ok)
      return {
        isError: true,
        text: `${checked.status === 409 ? "owner-unavailable" : "capability-denied"}: ${checked.error}`,
      };
    return callToolInProcess(this.coordinatorServer(coordinatorScope, checked.invoke), tool, args);
  }

  /** The tools a coordinator scope lists, as its own `tools/list` would. */
  async listCoordinatorTools(
    coordinatorScope: CoordinatorControlScope,
  ): Promise<InProcessToolInfo[]> {
    const checked = await this.coordinatorInvoker(coordinatorScope);
    if (!checked.ok) throw new Error(checked.error);
    return listToolsInProcess(this.coordinatorServer(coordinatorScope, checked.invoke));
  }

  /** The policy of one operator credential, or null once it is revoked. */
  credentialPolicy(credentialId: string): ControlMcpCredentialPolicy | null {
    const credential = this.credentials.get(credentialId);
    return credential
      ? {
          id: credential.id,
          profile: credential.profile,
          capabilities: credential.capabilities,
          deniedActions: credential.deniedActions,
        }
      : null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://control-mcp.invalid");
    if (url.pathname !== CONTROL_MCP_PATH) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      response.end();
      return;
    }
    const presentedToken = bearerToken(request);
    const coordinatorCredential = presentedToken
      ? this.coordinatorCredentials.get(presentedToken)
      : undefined;
    if (presentedToken && coordinatorCredential && coordinatorCredential.expiresAt <= Date.now()) {
      this.coordinatorCredentials.delete(presentedToken);
    }
    const coordinatorScope =
      coordinatorCredential && coordinatorCredential.expiresAt > Date.now()
        ? coordinatorCredential.scope
        : undefined;
    const operatorCredential = coordinatorScope
      ? null
      : this.credentials.authenticate(presentedToken);
    if (!operatorCredential && !coordinatorScope) {
      response.setHeader("www-authenticate", 'Bearer realm="orkestrator-control"');
      jsonResponse(response, 401, { error: "Invalid control MCP credential" });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      jsonResponse(response, 400, {
        error: error instanceof Error ? error.message : "Invalid request body",
      });
      return;
    }
    let scopedInvoke: ControlMcpInvoker = this.invoke;
    if (coordinatorScope) {
      const checked = await this.coordinatorInvoker(coordinatorScope);
      if (!checked.ok) {
        if (checked.status === 401) this.coordinatorCredentials.delete(presentedToken!);
        jsonResponse(response, checked.status, { error: checked.error });
        return;
      }
      // Expire abandoned credentials without interrupting a healthy,
      // long-lived coordinator bridge that continues to revalidate normally.
      if (coordinatorCredential) {
        coordinatorCredential.expiresAt = Date.now() + COORDINATOR_CREDENTIAL_TTL_MS;
      }
      const messages = Array.isArray(body) ? body : [body];
      for (const message of messages) {
        if (!isRecord(message) || message.method !== "tools/call") continue;
        const requestedTool = isRecord(message.params) ? message.params.name : undefined;
        if (
          typeof requestedTool !== "string" ||
          !coordinatorToolGranted(coordinatorScope, requestedTool)
        ) {
          jsonResponse(response, 403, { error: "Coordinator capability denied" });
          return;
        }
      }
      scopedInvoke = checked.invoke;
    }
    const pollGuard = coordinatorScope ? this.coordinatorPollGuard(coordinatorScope) : undefined;
    if (operatorCredential) this.credentials.markUsed(operatorCredential.id);
    const handler = createMcpHandler(
      () =>
        createControlMcp(
          scopedInvoke,
          coordinatorScope,
          pollGuard,
          operatorCredential
            ? (messagingEnabled) => this.operatorCaller(operatorCredential, messagingEnabled)
            : undefined,
        ),
      { legacy: "stateless" },
    );
    try {
      await toNodeHandler(handler)(request, response, body);
    } finally {
      await handler.close().catch(() => undefined);
    }
  }
}
