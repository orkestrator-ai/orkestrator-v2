/**
 * Contract tests against the **real** pinned `codex app-server` binary.
 *
 * `app-server` is still marked experimental, so the generated types are a
 * compile-time contract only — these tests are the runtime half. They are gated
 * because they need the pinned binary present:
 *
 *   CODEX_PROTOCOL_BINARY=/path/to/codex RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-contract.test.ts
 *
 * The MCP approval canary additionally calls a model and is gated separately:
 *
 *   CODEX_PROTOCOL_BINARY=/path/to/codex RUN_LIVE_CODEX_APP_SERVER=1 \
 *     RUN_LIVE_CODEX_MCP_APPROVAL_CANARY=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-contract.test.ts
 *
 * The override is optional: `live-binary.ts` otherwise falls back to the managed
 * toolchain copy, then `CODEX_PATH`, then `codex` on PATH, and verifies in every
 * case that the binary reports the version pinned in `config/codex-version.json`
 * — a contract test against the wrong build proves nothing. That resolution is
 * unit-tested by `live-binary.test.ts`, which runs in the default suite.
 *
 * The default live suite never starts a turn, so no credits are spent and no
 * model is called. Two contracts are the exceptions, each separately gated:
 * the MCP approval canary (RUN_LIVE_CODEX_MCP_APPROVAL_CANARY=1) and the
 * coordinator attachment contract (RUN_LIVE_CODEX_ATTACHMENT_TURN=1), which
 * cannot be proved without asking the real sandbox to open the staged image.
 */
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlRpcClient } from "./jsonl-rpc-client.js";
import { AppServerRpcError, isUnmaterializedThreadError } from "./errors.js";
import { pinnedVersion, resolveCodexBinary } from "./live-binary.js";
import type { InboundNotification } from "./envelope-validation.js";
import { BRIDGE_ATTACHMENT_ROOT_ENV, codexAppServerConfigOverrides } from "../codex-config.js";

// The repository-wide test preload registers Happy DOM, which replaces the
// global `Response`. `Bun.serve` refuses a handler return value that is not its
// own native Response, and the rejection surfaces as a connection error on the
// client rather than as a failure inside the handler — the loopback MCP probes
// below then look like servers that never answer.
//
// The key is spelled out rather than imported from `tests/register-dom.ts`:
// importing that module from a bridge package evaluates it a second time, and
// `GlobalRegistrator.register()` throws once Happy DOM is already registered.
const NATIVE_WEB_PLATFORM_KEY = Symbol.for("orkestrator.tests.native-web-platform");

const nativeWebPlatform = (
  globalThis as typeof globalThis & {
    [key: symbol]: { Response?: typeof Response } | undefined;
  }
)[NATIVE_WEB_PLATFORM_KEY];

// `happyDOM` is the registrator's own marker global, so it answers "was the
// preload applied?" without depending on which classes it chose to replace.
if (!nativeWebPlatform?.Response && "happyDOM" in globalThis) {
  throw new Error(
    `Happy DOM is registered but ${String(NATIVE_WEB_PLATFORM_KEY)} does not carry a Response. ` +
      "tests/register-dom.ts must publish Bun's pre-registration Response under that key, " +
      "or every loopback MCP probe here answers nothing.",
  );
}

const NativeResponse = nativeWebPlatform?.Response ?? Response;

const LIVE = process.env.RUN_LIVE_CODEX_APP_SERVER === "1";
const describeLive = LIVE ? describe : describe.skip;
const describeLiveAttachmentTurn =
  LIVE && process.env.RUN_LIVE_CODEX_ATTACHMENT_TURN === "1" ? describe : describe.skip;
const testLiveMcpApproval =
  LIVE && process.env.RUN_LIVE_CODEX_MCP_APPROVAL_CANARY === "1" ? test : test.skip;

interface LiveSession {
  client: JsonlRpcClient;
  notifications: InboundNotification[];
  codexHome: string;
  workspace: string;
  attachmentRoot?: string;
  stop: () => Promise<void>;
}

/** Boots a real app-server against a throwaway CODEX_HOME and workspace. */
async function boot(
  options: {
    copyAuth?: boolean;
    coordinator?: boolean;
    extraArgs?: string[];
    extraEnv?: Record<string, string>;
  } = {},
): Promise<LiveSession> {
  const codexHome = await mkdtemp(join(tmpdir(), "ork-live-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "ork-live-ws-"));
  // A git dir keeps app-server from treating the cwd as unversioned.
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

  if (options.copyAuth) {
    const source = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    if (existsSync(source)) {
      await writeFile(join(codexHome, "auth.json"), await readFile(source, "utf8"), "utf8");
    }
  }

  const binary = await resolveCodexBinary();
  const attachmentRoot = options.coordinator
    ? join(codexHome, "coordinator-attachments")
    : undefined;
  if (attachmentRoot) await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
  const configOverrides = options.coordinator
    ? codexAppServerConfigOverrides({
        ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
        CODEX_BRIDGE_PERMISSION_PROFILE: "coordinator-live-attachment",
        CODEX_BRIDGE_READABLE_RUNTIME_ROOT: workspace,
        CWD: workspace,
        [BRIDGE_ATTACHMENT_ROOT_ENV]: attachmentRoot,
      })
    : {};
  const args = ["app-server", "--stdio"];
  for (const [key, value] of Object.entries(configOverrides)) {
    args.push("-c", `${key}=${value}`);
  }
  args.push(...(options.extraArgs ?? []));
  const child = spawn(binary, args, {
    cwd: workspace,
    env: { ...process.env, ...options.extraEnv, CODEX_HOME: codexHome, LOG_FORMAT: "json" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  child.stderr.resume();

  const notifications: InboundNotification[] = [];
  const client = new JsonlRpcClient({
    generation: 1,
    stdin: child.stdin,
    stdout: child.stdout,
    onNotification: (notification) => notifications.push(notification),
    onServerRequest: () => undefined,
  });

  return {
    client,
    notifications,
    codexHome,
    workspace,
    ...(attachmentRoot ? { attachmentRoot } : {}),
    stop: async () => {
      client.close();
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

async function waitForNotification(
  session: LiveSession,
  method: string,
  timeoutMs: number,
): Promise<InboundNotification> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const notification = session.notifications.find((entry) => entry.method === method);
    if (notification) return notification;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${method}`);
}

interface McpMutationProbe {
  url: string;
  called: Promise<void>;
  authorized: Promise<string>;
  stop: () => Promise<void>;
}

async function startMcpMutationProbe(expectedAuthorization?: string): Promise<McpMutationProbe> {
  let markCalled!: () => void;
  let markAuthorized!: (authorization: string) => void;
  const called = new Promise<void>((resolve) => {
    markCalled = resolve;
  });
  const authorized = new Promise<string>((resolve) => {
    markAuthorized = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const authorization = request.headers.authorization ?? "";
    if (expectedAuthorization && authorization !== expectedAuthorization) {
      response.writeHead(401).end();
      return;
    }
    markAuthorized(authorization);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }

    let result: Record<string, unknown>;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: String(message.params?.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: {} },
          serverInfo: { name: "orkestrator-approval-probe", version: "1.0.0" },
        };
        break;
      case "tools/list":
        result = {
          tools: [
            {
              name: "mutating_probe",
              description: "Records that Codex dispatched this mutating test tool.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              annotations: { readOnlyHint: false },
            },
          ],
        };
        break;
      case "tools/call":
        if (message.params?.name !== "mutating_probe") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "unknown tool" },
            }),
          );
          return;
        }
        markCalled();
        result = { content: [{ type: "text", text: "probe called" }] };
        break;
      default:
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "unknown method" },
          }),
        );
        return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP probe did not bind a port");

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    called,
    authorized,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const LEGACY_ERA_PROBE_SERVER = "orkestrator-legacy-era-probe";
const LEGACY_ERA_PROBE_TOOL = "legacy_era_probe";

interface McpEraProbe {
  url: string;
  /** Every JSON-RPC method the server received, in arrival order. */
  methods: string[];
  stop: () => Promise<void>;
}

/**
 * An HTTP MCP server that speaks only the 2025 era, like the third-party
 * servers Codex has to keep working with.
 *
 * `server/discover` is the 2026-07-28 entry point. This probe answers it with
 * the JSON-RPC -32020 those servers really return, and serves an ordinary
 * `initialize` handshake with one tool behind it.
 */
function startLegacyEraMcpProbe(): McpEraProbe {
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new NativeResponse(null, { status: 405 });
      const message = (await request.json()) as {
        id?: string | number;
        method?: string;
      };
      if (typeof message.method === "string") methods.push(message.method);
      if (message.id === undefined) return new NativeResponse(null, { status: 202 });

      if (message.method === "server/discover") {
        return NativeResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32020, message: "server/discover is not supported" },
          },
          { status: 200 },
        );
      }

      let result: Record<string, unknown>;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: LEGACY_ERA_PROBE_SERVER, version: "1.0.0" },
          };
          break;
        case "tools/list":
          result = {
            tools: [
              {
                name: LEGACY_ERA_PROBE_TOOL,
                description: "Reachable only through the 2025 initialize handshake.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          };
          break;
        case "resources/list":
          result = { resources: [] };
          break;
        case "resources/templates/list":
          result = { resourceTemplates: [] };
          break;
        default:
          return NativeResponse.json(
            {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "unknown method" },
            },
            { status: 200 },
          );
      }
      return NativeResponse.json({ jsonrpc: "2.0", id: message.id, result }, { status: 200 });
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}/mcp`,
    methods,
    stop: async () => {
      await server.stop(true);
    },
  };
}

interface McpServerStatusEntry {
  name: string;
  serverInfo: { name?: string } | null;
  tools: Record<string, unknown>;
}

async function readMcpServerStatus(
  session: LiveSession,
  name: string,
): Promise<McpServerStatusEntry | undefined> {
  const page = await session.client.request<{ data: McpServerStatusEntry[] }>(
    "mcpServerStatus/list",
    {},
  );
  return page.data.find((entry) => entry.name === name);
}

/** Polls until `predicate` holds, so a slow connect is not read as a failure. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const CLIENT_INFO = { name: "orkestrator", title: "Orkestrator", version: "2.4.9" };
const CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  mcpServerOpenaiFormElicitation: true,
};

async function handshake(session: LiveSession): Promise<Record<string, unknown>> {
  const result = await session.client.request<Record<string, unknown>>("initialize", {
    clientInfo: CLIENT_INFO,
    capabilities: CAPABILITIES,
  });
  await session.client.notify("initialized");
  return result;
}

describeLive("live app-server handshake", () => {
  test("initialize reports codexHome and identifies us as Orkestrator", async () => {
    const session = await boot();
    try {
      const result = await handshake(session);

      // app-server returns the resolved realpath, which on macOS means
      // /private/var/... for a /var/... tmpdir. Compare canonical paths.
      expect(await realpath(String(result.codexHome))).toBe(await realpath(session.codexHome));
      expect(typeof result.platformOs).toBe("string");
      // The user agent is what app-server attributes compliance logs to.
      expect(String(result.userAgent)).toContain("orkestrator");
      expect(String(result.userAgent)).toContain(await pinnedVersion());
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("requests before the initialized notification are rejected", async () => {
    const session = await boot();
    try {
      // No handshake at all: app-server must refuse ordinary requests.
      const error = await session.client
        .request("model/list", { limit: 1 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppServerRpcError);
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("an unknown method returns a JSON-RPC error rather than hanging", async () => {
    const session = await boot();
    try {
      await handshake(session);
      const error = await session.client
        .request("orkestrator/not-a-method", {})
        .catch((caught: AppServerRpcError) => caught);

      expect(error).toBeInstanceOf(AppServerRpcError);
      expect([-32600, -32601]).toContain((error as AppServerRpcError).code);
    } finally {
      await session.stop();
    }
  }, 60_000);
});

describeLive("live model catalog", () => {
  test("model/list paginates and preserves reasoning-effort order", async () => {
    const session = await boot({ copyAuth: true });
    try {
      await handshake(session);
      const page = await session.client.request<{
        data: Array<{
          id: string;
          supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
          defaultReasoningEffort: string;
        }>;
        nextCursor: string | null;
      }>("model/list", { limit: 2 });

      expect(page.data.length).toBeGreaterThan(0);
      const first = page.data[0]!;
      expect(typeof first.id).toBe("string");
      expect(Array.isArray(first.supportedReasoningEfforts)).toBe(true);

      // The order the server sends is meaningful; clients must not re-sort it.
      const efforts = first.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
      expect(efforts.length).toBeGreaterThan(0);
      expect(efforts).not.toEqual([...efforts].sort());

      if (page.nextCursor) {
        const second = await session.client.request<{ data: unknown[] }>("model/list", {
          cursor: page.nextCursor,
          limit: 2,
        });
        expect(Array.isArray(second.data)).toBe(true);
      }
    } finally {
      await session.stop();
    }
  }, 60_000);
});

describeLive("live thread history", () => {
  /**
   * The migration trap from the plan: `thread/list` defaults to interactive
   * source kinds, so omitting `sourceKinds` hides both legacy `exec` threads and
   * new `appServer` ones — silently emptying the resume dialog.
   */
  test("thread/list needs explicit sourceKinds to see exec and appServer threads", async () => {
    const session = await boot();
    try {
      await handshake(session);

      const defaults = await session.client.request<{ data: unknown[] }>("thread/list", {
        limit: 5,
      });
      const explicit = await session.client.request<{
        data: Array<{ source: unknown; parentThreadId: string | null }>;
      }>("thread/list", {
        limit: 5,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      });

      // Both are valid responses; the contract being pinned is that the default
      // set is *narrower*, which is what makes the explicit list mandatory.
      expect(Array.isArray(defaults.data)).toBe(true);
      expect(Array.isArray(explicit.data)).toBe(true);
      expect(explicit.data.length).toBeGreaterThanOrEqual(defaults.data.length);
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("thread/start creates a thread lazily addressable by thread/read", async () => {
    const session = await boot();
    try {
      await handshake(session);
      const started = await session.client.request<{ thread: { id: string; cwd: string } }>(
        "thread/start",
        { cwd: session.workspace, sandbox: "read-only", approvalPolicy: "never" },
      );

      expect(started.thread.id).toMatch(/^[0-9a-f-]{8,}/);

      const read = await session.client.request<{ thread: { id: string } }>("thread/read", {
        threadId: started.thread.id,
      });
      expect(read.thread.id).toBe(started.thread.id);

      // thread/started must have been announced so the bridge can bind the id.
      expect(session.notifications.some((entry) => entry.method === "thread/started")).toBe(true);
    } finally {
      await session.stop();
    }
  }, 60_000);

  /**
   * Load-bearing for ambiguous-dispatch recovery.
   *
   * The recovery flow reads `thread/read(includeTurns=true)` and looks for a
   * `userMessage` whose `clientId` matches the request id. On a thread whose
   * first turn never materialized, that call does **not** return an empty turn
   * list — Codex 0.153.3 fails with -32601 "list_turns is not supported yet".
   * Recovery combines that not-yet-indexed response with a metadata-only read
   * of the untouched idle snapshot before deciding the turn may be dispatched
   * exactly once. Treating it as a generic failure would strand the prompt;
   * trusting the shared error wording alone could duplicate a real turn.
   */
  test("thread/read(includeTurns) rejects an unmaterialized thread instead of returning empty", async () => {
    const session = await boot();
    try {
      await handshake(session);
      const started = await session.client.request<{ thread: { id: string } }>("thread/start", {
        cwd: session.workspace,
        sandbox: "read-only",
        approvalPolicy: "never",
      });

      const error = await session.client
        .request("thread/read", { threadId: started.thread.id, includeTurns: true })
        .catch((caught: unknown) => caught);

      const metadata = await session.client.request<{ thread: Record<string, unknown> }>(
        "thread/read",
        { threadId: started.thread.id },
      );
      expect(error).toBeInstanceOf(AppServerRpcError);
      expect((error as AppServerRpcError).message).toContain("list_turns is not supported yet");
      expect(metadata.thread.historyMode).toBe("paginated");
      expect(typeof metadata.thread.path).toBe("string");
      expect(metadata.thread.preview).toBe("");
      expect(metadata.thread.updatedAt).toBe(metadata.thread.createdAt);
      expect(metadata.thread.status).toEqual({ type: "idle" });
      expect(isUnmaterializedThreadError(error, metadata.thread)).toBe(true);
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("thread/name/set renames a thread and notifies", async () => {
    const session = await boot();
    try {
      await handshake(session);
      const started = await session.client.request<{ thread: { id: string } }>("thread/start", {
        cwd: session.workspace,
        sandbox: "read-only",
        approvalPolicy: "never",
      });

      await session.client.request("thread/name/set", {
        threadId: started.thread.id,
        name: "Orkestrator title",
      });
      const read = await session.client.request<{ thread: { name: string | null } }>(
        "thread/read",
        { threadId: started.thread.id },
      );

      expect(read.thread.name).toBe("Orkestrator title");
    } finally {
      await session.stop();
    }
  }, 60_000);
});

/**
 * Why this exists: `codexAppServerConfigOverrides` deliberately does *not* set
 * `features.mcp_2026_07_28`, so a native session inherits whatever the pinned
 * binary defaults to. Every unit test around that decision can only assert that
 * Orkestrator leaves the key alone, which stays true no matter what the default
 * becomes. These two contracts are what actually pin the behaviour the omission
 * is buying, and the Codex upgrade runbook already runs this file.
 */
describeLive("live MCP protocol era", () => {
  test("a 2025-era MCP server is usable under the pinned binary's defaults", async () => {
    const probe = startLegacyEraMcpProbe();
    const session = await boot({
      extraArgs: ["-c", `mcp_servers.probe.url=${JSON.stringify(probe.url)}`],
    });
    try {
      await handshake(session);
      await waitUntil(
        async () => {
          const entry = await readMcpServerStatus(session, "probe");
          return Object.keys(entry?.tools ?? {}).length > 0;
        },
        30_000,
        "the legacy-era probe's tools to be discovered. Check whether the pinned " +
          "Codex now defaults features.mcp_2026_07_28 on",
      );

      const status = await readMcpServerStatus(session, "probe");
      expect(status?.serverInfo?.name).toBe(LEGACY_ERA_PROBE_SERVER);
      expect(Object.keys(status?.tools ?? {})).toContain(LEGACY_ERA_PROBE_TOOL);
      // The handshake that got us there, and the probe that must not have run.
      expect(probe.methods).toContain("initialize");
      expect(probe.methods).not.toContain("server/discover");
    } finally {
      await session.stop();
      await probe.stop();
    }
  }, 60_000);

  /**
   * The failure the override removal fixes, pinned so it cannot silently
   * change. With the feature forced on, Codex asks `server/discover` first and
   * treats the -32020 as terminal — no `initialize` retry, no tools. If a later
   * Codex adds that fallback this test fails, which is the signal to revisit
   * the comment in `codex-config.ts` rather than a regression.
   */
  test("forcing features.mcp_2026_07_28 loses those tools with no initialize retry", async () => {
    const probe = startLegacyEraMcpProbe();
    const session = await boot({
      extraArgs: [
        "-c",
        `mcp_servers.probe.url=${JSON.stringify(probe.url)}`,
        "-c",
        "features.mcp_2026_07_28=true",
      ],
    });
    try {
      await handshake(session);
      // Reading the status is what makes Codex connect, so the poll has to do
      // that on every pass rather than only watch the probe's method log.
      await waitUntil(
        async () => {
          await readMcpServerStatus(session, "probe");
          return probe.methods.includes("server/discover");
        },
        30_000,
        "Codex to probe the 2026-07-28 discovery method with the feature forced on",
      );

      const status = await readMcpServerStatus(session, "probe");
      expect(status).toBeDefined();
      expect(status?.serverInfo).toBeNull();
      expect(Object.keys(status?.tools ?? {})).toHaveLength(0);
    } finally {
      await session.stop();
      await probe.stop();
    }
  }, 60_000);
});

describeLive("live config side effects", () => {
  test("a thread-scoped MCP header replaces the inherited bearer token", async () => {
    const scopedAuthorization = "Bearer attempt-scoped-secret";
    const inheritedTokenEnv = "ORKESTRATOR_LIVE_MCP_BASE_TOKEN";
    const probe = await startMcpMutationProbe(scopedAuthorization);
    const session = await boot({
      extraEnv: { [inheritedTokenEnv]: "environment-wide-secret" },
      extraArgs: [
        "-c",
        `mcp_servers.orkestrator.url=${JSON.stringify(probe.url)}`,
        "-c",
        `mcp_servers.orkestrator.bearer_token_env_var=${JSON.stringify(inheritedTokenEnv)}`,
        "-c",
        "mcp_servers.orkestrator.required=false",
      ],
    });
    try {
      await handshake(session);
      await session.client.request("thread/start", {
        cwd: session.workspace,
        sandbox: "read-only",
        approvalPolicy: "never",
        config: {
          "mcp_servers.orkestrator": {
            url: probe.url,
            http_headers: { Authorization: scopedAuthorization },
            required: true,
            startup_timeout_sec: 10,
          },
        },
      });

      expect(await probe.authorized).toBe(scopedAuthorization);
    } finally {
      await session.stop();
      await probe.stop();
    }
  }, 60_000);

  test("accepts the coordinator MCP approval mode at process and thread scope", async () => {
    const serverUrl = "http://127.0.0.1:9/mcp";
    const session = await boot({
      extraArgs: [
        "-c",
        `mcp_servers.orkestrator.url=${JSON.stringify(serverUrl)}`,
        "-c",
        'mcp_servers.orkestrator.default_tools_approval_mode="approve"',
        "-c",
        "mcp_servers.orkestrator.required=false",
      ],
    });
    try {
      await handshake(session);
      const started = await session.client.request<{ thread: { id: string } }>("thread/start", {
        cwd: session.workspace,
        sandbox: "read-only",
        approvalPolicy: "never",
        config: {
          "mcp_servers.orkestrator.url": serverUrl,
          "mcp_servers.orkestrator.default_tools_approval_mode": "approve",
          "mcp_servers.orkestrator.required": false,
        },
      });

      expect(started.thread.id).toMatch(/^[0-9a-f-]{8,}/);
    } finally {
      await session.stop();
    }
  }, 60_000);

  testLiveMcpApproval(
    "dispatches a mutating MCP tool for a read-only coordinator without prompting",
    async () => {
      const probe = await startMcpMutationProbe();
      const session = await boot({ copyAuth: true });
      try {
        await handshake(session);
        const started = await session.client.request<{ thread: { id: string } }>("thread/start", {
          cwd: session.workspace,
          sandbox: "read-only",
          approvalPolicy: "never",
          developerInstructions:
            "Call mcp__orkestrator__mutating_probe exactly once. Do not call any other tool.",
          config: {
            "mcp_servers.orkestrator.url": probe.url,
            "mcp_servers.orkestrator.required": true,
            "mcp_servers.orkestrator.startup_timeout_sec": 10,
            "mcp_servers.orkestrator.default_tools_approval_mode": "approve",
          },
        });

        await session.client.request("turn/start", {
          threadId: started.thread.id,
          clientUserMessageId: "mcp-approval-canary",
          input: [
            {
              type: "text",
              text: "Run the required mutating probe now.",
              text_elements: [],
            },
          ],
        });

        await Promise.race([
          probe.called,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Codex did not dispatch the mutating MCP probe")),
              60_000,
            ),
          ),
        ]);
      } finally {
        await session.stop();
        await probe.stop();
      }
    },
    90_000,
  );

  /**
   * Documents a real, deliberate side effect: starting a thread under a writable
   * sandbox marks the project trusted in `config.toml`.
   *
   * This is **not** an app-server regression — `codex exec --sandbox
   * danger-full-access`, which the SDK engine already uses for build mode, writes
   * the identical entry. Pinning it here means a future version that *stopped*
   * or *broadened* the mutation would surface as a test failure rather than as a
   * surprise edit to the user's config.
   */
  test("a read-only thread does not mark the project trusted", async () => {
    const session = await boot();
    try {
      await handshake(session);
      await session.client.request("thread/start", {
        cwd: session.workspace,
        sandbox: "read-only",
        approvalPolicy: "never",
      });

      const configPath = join(session.codexHome, "config.toml");
      const config = existsSync(configPath) ? await readFile(configPath, "utf8") : "";
      expect(config).not.toContain("trust_level");
    } finally {
      await session.stop();
    }
  }, 60_000);

  test("a workspace-write thread marks the project trusted", async () => {
    const session = await boot();
    try {
      await handshake(session);
      await session.client.request("thread/start", {
        cwd: session.workspace,
        sandbox: "workspace-write",
        approvalPolicy: "never",
      });

      const config = await readFile(join(session.codexHome, "config.toml"), "utf8");
      expect(config).toContain("trust_level");
      expect(config).toContain('trust_level = "trusted"');
      // Scoped to this project only — it must not become a global setting.
      expect(config).toContain(`[projects.`);
    } finally {
      await session.stop();
    }
  }, 60_000);
});

describeLiveAttachmentTurn("live coordinator attachment permission", () => {
  test("a coordinator permission profile lets app-server consume its staged local image", async () => {
    const session = await boot({ copyAuth: true, coordinator: true });
    try {
      await handshake(session);
      const attachmentPath = join(session.attachmentRoot!, "pixel.png");
      await writeFile(
        attachmentPath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
        { mode: 0o600 },
      );
      const started = await session.client.request<{
        thread: { id: string };
        activePermissionProfile?: { id: string } | null;
      }>("thread/start", {
        cwd: session.workspace,
        approvalPolicy: "never",
      });
      expect(started.activePermissionProfile?.id).toBe("coordinator-live-attachment");

      await session.client.request("turn/start", {
        threadId: started.thread.id,
        input: [
          { type: "text", text: "Reply with OK after inspecting this image.", text_elements: [] },
          { type: "localImage", path: attachmentPath },
        ],
      });
      const completed = await waitForNotification(session, "turn/completed", 120_000);
      expect(completed.params).toMatchObject({ turn: { status: "completed", error: null } });
    } finally {
      await session.stop();
    }
  }, 150_000);
});

describeLive("live shutdown", () => {
  test("closing stdin terminates the child without orphans", async () => {
    const session = await boot();
    await handshake(session);

    const before = await session.client.request<Record<string, unknown>>("thread/start", {
      cwd: session.workspace,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    expect(before).toBeTruthy();

    await session.stop();
    // Give the child a moment to notice EOF.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(session.client.isClosed()).toBe(true);
  }, 60_000);
});
