import { withRelayController } from "../public-api/relay-context.js";
import type { BackendProfile } from "@orkestrator/protocol/backend-profile";
import { BACKEND_HELLO_PATH, CLIENT_API_VERSION } from "@orkestrator/protocol/backend-profile";
import {
  CONTROLLER_HEADER,
  emptyNodeAttachments,
  emptyNodeRegistry,
  type NodeAttachments,
  type NodeRegistry,
} from "@orkestrator/protocol/command-nodes";

import {
  emptyControllerSettingsStore,
  type ControllerSettingsStore,
} from "@orkestrator/protocol/controller-settings";

import type { CommandContext, CommandHandler } from "../commands-context.js";
import { registerNodeCommands } from "../commands-registry-nodes.js";
import { NodePortal } from "./node-portal.js";
import { NodeService, type NodeServiceOptions, type NodeServiceStorage } from "./node-service.js";
import type { NodeLinkTimers } from "./node-link.js";

/**
 * Test-only: several in-memory nodes behind one fake `fetch`. Each node is
 * reachable at `https://<name>.test`, answers the authenticated hello like
 * the gateway does, and runs the real node commands over `/invoke`.
 */

export class MemoryNodeStorage implements NodeServiceStorage {
  registry: NodeRegistry = emptyNodeRegistry();
  attachments: NodeAttachments = emptyNodeAttachments();
  controllerSettings: ControllerSettingsStore = emptyControllerSettingsStore();
  writes = { registry: 0, attachments: 0 };
  /** One object stands in for both stores, so a test can patch either here. */
  readonly nodes = this;
  readonly previewServices = this;

  constructor(
    readonly instanceId: string,
    public profile: BackendProfile,
  ) {}

  async getNodeRegistry(): Promise<NodeRegistry> {
    return structuredClone(this.registry);
  }

  async mutateNodeRegistry<T>(
    mutate: (current: NodeRegistry) => { next: NodeRegistry | null; result: T },
  ): Promise<T> {
    const { next, result } = mutate(structuredClone(this.registry));
    if (next) {
      this.registry = structuredClone({ ...next, revision: this.registry.revision + 1 });
      this.writes.registry += 1;
    }
    return result;
  }

  async getNodeAttachments(): Promise<NodeAttachments> {
    return structuredClone(this.attachments);
  }

  async mutateNodeAttachments<T>(
    mutate: (current: NodeAttachments) => { next: NodeAttachments | null; result: T },
  ): Promise<T> {
    const { next, result } = mutate(structuredClone(this.attachments));
    if (next) {
      this.attachments = structuredClone(next);
      this.writes.attachments += 1;
    }
    return result;
  }

  async getControllerSettings(): Promise<ControllerSettingsStore> {
    return structuredClone(this.controllerSettings);
  }

  async mutateControllerSettings<T>(
    mutate: (current: ControllerSettingsStore) => {
      next: ControllerSettingsStore | null;
      result: T;
    },
  ): Promise<T> {
    const { next, result } = mutate(structuredClone(this.controllerSettings));
    if (next) this.controllerSettings = structuredClone(next);
    return result;
  }

  async getBackendProfile(): Promise<BackendProfile> {
    return this.profile;
  }

  async getPreviewBackendIdentity(): Promise<{ instanceId: string; created: boolean }> {
    return { instanceId: this.instanceId, created: false };
  }
}

/** Timers that never fire unless a test runs them. */
export class ManualTimers implements NodeLinkTimers {
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { callback, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  runAll(): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, entry] of entries) entry.callback();
  }
}

export interface TestNode {
  name: string;
  origin: string;
  token: string;
  storage: MemoryNodeStorage;
  service: NodeService;
  events: Array<{ event: string; payload: unknown }>;
  /** Commands this node received over `/invoke`, in order. */
  received: Array<{ command: string; controller: string | null }>;
  /** Simulate an older backend: no hello at all. */
  legacy: boolean;
  /** Advertise `public-action-relay` (false: a leaf from before node routing). */
  publicActionRelay: boolean;
  /** Answer the hello with a different identity (a route that reaches another machine). */
  impersonate?: string;
  online: boolean;
  portal: NodePortal;
  /** Extra commands this node answers (projects, environments, writes). */
  commands: Map<string, (args: Record<string, unknown>) => unknown>;
  /** Open event streams; `emit` pushes to all of them. */
  streams: Set<ReadableStreamDefaultController<Uint8Array>>;
  emit(event: string, payload: unknown): void;
  /** Drop every open event stream (a lost connection). */
  dropStreams(): void;
}

export class TestNodeNetwork {
  readonly nodes = new Map<string, TestNode>();
  readonly timers = new ManualTimers();
  private readonly commands = new Map<string, CommandHandler>();

  constructor() {
    registerNodeCommands((name, handler) => this.commands.set(name, handler));
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const node = [...this.nodes.values()].find((entry) => entry.origin === url.origin);
    if (!node || !node.online) throw new TypeError("fetch failed");
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${node.token}`) {
      return json(401, { error: "Authentication required" });
    }
    const controller = headers.get(CONTROLLER_HEADER);
    if (controller) node.service.noteControllerContact(controller);
    if (url.pathname === BACKEND_HELLO_PATH) {
      if (node.legacy) return new Response("<html></html>", { status: 200 });
      return json(200, await this.hello(node));
    }
    if (url.pathname === "/__orkestrator/status") return json(200, { ok: true });
    if (url.pathname === "/__orkestrator/events") {
      let own: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          own = controller;
          node.streams.add(controller);
          controller.enqueue(
            new TextEncoder().encode(
              `id: c1\ndata: ${JSON.stringify({ event: "gateway.connected", payload: { status: "fresh" } })}\n\n`,
            ),
          );
        },
        cancel() {
          if (own) node.streams.delete(own);
        },
      });
      init?.signal?.addEventListener("abort", () => {
        if (own) node.streams.delete(own);
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/__orkestrator/invoke") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        command: string;
        args: Record<string, unknown>;
      };
      node.received.push({ command: body.command, controller });
      const extra = node.commands.get(body.command);
      const handler = this.commands.get(body.command);
      if (!handler && !extra) return json(500, { error: `Unknown command: ${body.command}` });
      try {
        const result = extra
          ? await extra(
              body.command === "public_action" && controller
                ? withRelayController(body.args ?? {}, controller)
                : (body.args ?? {}),
            )
          : await handler!(body.args ?? {}, {
              nodes: node.service,
              nodePortal: node.portal,
            } as unknown as CommandContext);
        return json(200, { result });
      } catch (error) {
        return json(500, {
          error: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string }).code,
        });
      }
    }
    return json(404, { error: "Not found" });
  }) as typeof fetch;

  async add(
    name: string,
    options: { forceRegistration?: boolean; extra?: Partial<NodeServiceOptions> } = {},
  ): Promise<TestNode> {
    const storage = new MemoryNodeStorage(`bk_${name}`, {
      revision: 1,
      displayName: `${name} machine`,
      colorToken: "teal",
      updatedAt: "2026-10-21T00:00:00.000Z",
    });
    const events: TestNode["events"] = [];
    const service = new NodeService({
      storage,
      emit: (event, payload) => events.push({ event, payload }),
      forceRegistration: options.forceRegistration ?? false,
      portalOrigins: () => [`https://${name}.test`],
      fetchImpl: this.fetch,
      timers: this.timers,
      ...options.extra,
    });
    const portal = new NodePortal({
      nodes: service,
      emit: (event, payload) => events.push({ event, payload }),
      local: {
        invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
          const handler = node.commands.get(command);
          if (!handler) throw new Error(`Unknown command ${command}`);
          return (await handler(args)) as T;
        },
      },
      fetchImpl: this.fetch,
    });
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    let sequence = 1;
    const node: TestNode = {
      name,
      origin: `https://${name}.test`,
      token: `token-${name}-secret`,
      storage,
      service,
      events,
      received: [],
      legacy: false,
      publicActionRelay: true,
      online: true,
      portal,
      commands: new Map(),
      streams,
      emit(event, payload) {
        sequence += 1;
        const frame = new TextEncoder().encode(
          `id: c${sequence}\ndata: ${JSON.stringify({ event, payload })}\n\n`,
        );
        for (const controller of streams) {
          try {
            controller.enqueue(frame);
          } catch {
            streams.delete(controller);
          }
        }
      },
      dropStreams() {
        for (const controller of streams) {
          try {
            controller.error(new Error("connection lost"));
          } catch {
            // Already closed.
          }
        }
        streams.clear();
      },
    };
    this.nodes.set(name, node);
    await service.start();
    await portal.start();
    return node;
  }

  private async hello(node: TestNode) {
    return {
      schemaVersion: 1,
      installationId: node.impersonate ?? node.storage.instanceId,
      generation: "generation-1",
      appVersion: "9.9.9-test",
      clientApi: { minVersion: 1, maxVersion: CLIENT_API_VERSION },
      capabilities: {
        "backend-profile": 1,
        "summary-reads": 1,
        "node-attachment": 1,
        ...(node.publicActionRelay ? { "public-action-relay": 1 } : {}),
      },
      profile: node.storage.profile,
      endpointRole: "client",
      nodeMode: node.service.mode(),
    };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Let queued microtasks and immediately-resolved fetches settle. */
export async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise((r) => setTimeout(r, 0));
}
