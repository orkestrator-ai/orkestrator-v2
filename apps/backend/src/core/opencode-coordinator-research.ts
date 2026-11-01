/**
 * A coordinator's research MCP servers on OpenCode.
 *
 * OpenCode has no bridge, so the backend registers the servers the launcher
 * named (Settings → Coordinator web research) on the coordinator's own
 * `opencode serve` process, and allows their tools by exact id in the
 * coordinator's permission rules. Exact ids rather than a `context7_*`
 * pattern, because OpenCode always loads the checkout's project configuration:
 * a project server named `context7_x` owns `context7_x_*` tools, which the
 * pattern would admit too. OpenCode 1.19.4 lists only built-in tools over
 * HTTP, so the research server's tools are listed from the server itself.
 */
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CoordinatorResearchMcpServer } from "@orkestrator/protocol/coordinator-web-research";
import { openCodeHealthHeaders } from "./commands-server-health.js";
import { readBoundedOpenCodeResponse } from "./opencode-bounded-response.js";

type ResearchRegistration = {
  input: ResearchInput;
  generation: number;
  ready: boolean;
  pending?: Promise<readonly string[]>;
};

/**
 * One backend's coordinator research registrations, keyed like the
 * agent-tools configuration (`local:<runtime id>`): set at launch and
 * forgotten with it. Owned by the backend's `OpenCodeAgentToolsReconciler`
 * (`runtime.localServers.openCodeAgentTools.research`), whose cancellation
 * forgets the same keys.
 */
export class OpenCodeCoordinatorResearch {
  /** Exact research tool ids per OpenCode server. */
  private readonly researchToolIds = new Map<string, readonly string[]>();
  private readonly registrations = new Map<string, ResearchRegistration>();

  /**
   * Register `servers` on a coordinator's OpenCode server and record the exact
   * tool ids they contributed. A server that does not connect is skipped:
   * research is optional, and the coordinator context only offers tools it has.
   */
  configure(input: ResearchInput): Promise<readonly string[]> {
    this.researchToolIds.delete(input.serverKey);
    this.registrations.set(input.serverKey, {
      input: { ...input, signal: undefined },
      generation: 0,
      ready: false,
    });
    return this.ensure(input.serverKey, input.signal);
  }

  /** Disposal drops runtime MCP registrations, but persisted session rules survive. */
  invalidate(serverKey: string): void {
    this.researchToolIds.delete(serverKey);
    const registration = this.registrations.get(serverKey);
    if (registration) {
      registration.generation += 1;
      registration.ready = false;
      registration.pending = undefined;
    }
  }

  /** Restore the launcher-owned endpoint before granting any exact tool permissions. */
  ensure(serverKey: string, signal?: AbortSignal): Promise<readonly string[]> {
    const registration = this.registrations.get(serverKey);
    if (!registration) return Promise.resolve([]);
    if (registration.ready) return Promise.resolve(this.toolIds(serverKey));
    if (registration.pending) return registration.pending;
    const generation = registration.generation;
    const pending = registerResearchServers({
      ...registration.input,
      // Launch signals expire; every instance restoration needs a fresh deadline.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    })
      .then((allowed) => {
        if (
          this.registrations.get(serverKey) !== registration ||
          registration.generation !== generation
        ) {
          throw new Error("OpenCode research instance changed during registration");
        }
        registration.ready = true;
        this.researchToolIds.set(serverKey, allowed);
        return allowed;
      })
      .finally(() => {
        if (registration.pending === pending) registration.pending = undefined;
      });
    registration.pending = pending;
    return pending;
  }

  toolIds(serverKey: string): readonly string[] {
    return this.researchToolIds.get(serverKey) ?? [];
  }

  forget(serverKey: string): void {
    this.researchToolIds.delete(serverKey);
    this.registrations.delete(serverKey);
  }
}

/** OpenCode's MCP tool key part: other characters than these become `_`. */
function openCodeToolKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * The OpenCode tool ids a research server's `tools` are registered under,
 * without any another server could also produce.
 *
 * OpenCode names an MCP tool `<server>_<tool>`, so a project server whose name
 * extends the research server's (`context7_a`) produces `context7_a_b` for its
 * tool `b`, the same id as the research server's tool `a_b`. Such a tool is
 * left out rather than allowed under a name two servers share.
 */
export function openCodeResearchToolIds(
  server: string,
  tools: readonly string[],
  otherServers: readonly string[],
): string[] {
  const prefix = `${openCodeToolKeyPart(server)}_`;
  const shadows = otherServers
    .map(openCodeToolKeyPart)
    .filter((other) => other.startsWith(prefix))
    .map((other) => `${other}_`);
  return [...new Set(tools.map((tool) => `${prefix}${openCodeToolKeyPart(tool)}`))].filter(
    (id) => !shadows.some((shadow) => id.startsWith(shadow)),
  );
}

const LIST_TIMEOUT_MS = 10_000;
const MAX_RESEARCH_TOOLS = 128;

/** The research server's own tool names, listed directly: OpenCode does not report MCP tools. */
async function listResearchTools(url: string, signal?: AbortSignal): Promise<string[]> {
  const client = new McpClient(
    { name: "orkestrator-opencode-research", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const deadline = AbortSignal.timeout(LIST_TIMEOUT_MS);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    await client.connect(transport, { signal: bounded, timeout: LIST_TIMEOUT_MS });
    const listed = await client.listTools(undefined, { signal: bounded, timeout: LIST_TIMEOUT_MS });
    return (listed.tools ?? [])
      .map((tool) => tool.name.trim())
      .filter((name) => name.length > 0 && name.length <= 128)
      .slice(0, MAX_RESEARCH_TOOLS);
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
  }
}

type ResearchInput = {
  serverKey: string;
  port: number;
  password: string;
  directory: string;
  servers: readonly CoordinatorResearchMcpServer[];
  signal?: AbortSignal;
};

async function registerResearchServers(input: ResearchInput): Promise<readonly string[]> {
  if (input.servers.length === 0) return [];
  const headers = openCodeHealthHeaders(input.password);
  const url = new URL(`http://127.0.0.1:${input.port}/mcp`);
  url.searchParams.set("directory", input.directory);
  const connected: CoordinatorResearchMcpServer[] = [];
  let serverNames: string[] = [];
  for (const server of input.servers) {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: server.name,
        // Remote and credential-free: nothing runs on this machine, and the
        // name replaces any project entry the checkout declared under it.
        config: { type: "remote", url: server.url, enabled: true, oauth: false, timeout: 10_000 },
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    // The response is the status of every MCP server, project ones included.
    const status = await readBoundedOpenCodeResponse(response);
    if (!isRecord(status)) continue;
    serverNames = Object.keys(status);
    const entry = status[server.name];
    if (isRecord(entry) && entry.status === "connected") connected.push(server);
  }
  const allowed: string[] = [];
  for (const server of connected) {
    const tools = await listResearchTools(server.url, input.signal).catch(() => []);
    allowed.push(
      ...openCodeResearchToolIds(
        server.name,
        tools,
        serverNames.filter((name) => name !== server.name),
      ),
    );
  }
  return allowed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
