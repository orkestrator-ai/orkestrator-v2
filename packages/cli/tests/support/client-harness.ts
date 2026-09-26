import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatPublicNamespace,
  PUBLIC_ACTIONS,
  PUBLIC_API_LIMITS,
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicActionResponse,
  type PublicCapabilities,
} from "@orkestrator/protocol/public-api";
import { BACKEND_INSTANCE_DESCRIPTOR_TYPE } from "@orkestrator/protocol/backend-instance";
import type { ClientIo } from "../../src/client/io.js";
import { runClient } from "../../src/client/main.js";

/**
 * Test support for the client: an in-memory IO, a private config directory,
 * and a scriptable fake gateway (a real HTTP server) used only for precise
 * transport behaviour. Integration with the real backend is covered by the
 * packaged tests.
 */

export const TOKEN = "test-token-0123456789abcdef";

export interface CapturedIo extends ClientIo {
  out: string[];
  err: string[];
  stdinBytes: Uint8Array;
}

export function captureIo(
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): CapturedIo {
  const io: CapturedIo = {
    out: [],
    err: [],
    stdinBytes: new Uint8Array(),
    stdout: (text) => void io.out.push(text),
    stdoutBytes: (bytes) => void io.out.push(Buffer.from(bytes).toString("binary")),
    stderr: (text) => void io.err.push(text),
    readStdin: async (maxBytes) => {
      if (io.stdinBytes.byteLength > maxBytes) {
        const { CliError } = await import("../../src/client/errors.js");
        throw new CliError("input-too-large", "stdin too large");
      }
      return io.stdinBytes;
    },
    env,
    cwd,
    now: () => Date.now(),
    stdinIsTty: false,
  };
  return io;
}

export function capabilities(overrides: Partial<PublicCapabilities> = {}): PublicCapabilities {
  return {
    schemaVersion: 1,
    backend: {
      installationId: "install-a",
      generation: "gen-1",
      version: "test",
      startedAt: new Date(0).toISOString(),
    },
    actions: Object.fromEntries(
      Object.entries(PUBLIC_ACTIONS).map(([name, descriptor]) => [
        name,
        { version: descriptor.version, available: true },
      ]),
    ),
    limits: PUBLIC_API_LIMITS,
    requestKeys: {
      currentNamespace: formatPublicNamespace(1_790_000_000_000, "0a1b2c3d"),
      admissionWindowMs: 1,
      retentionMs: 1,
      retainedNamespaces: [],
    },
    providers: {},
    features: {
      transcriptFollow: "poll",
      exec: { local: true, container: true },
      projectCascadeRemove: false,
      localProjectInit: false,
      promptAttachments: false,
      selectedSlashCommands: false,
      enqueue: false,
    },
    ...overrides,
  };
}

export interface RecordedRequest {
  authorization: string | null;
  body: { command: string; args: Record<string, unknown> };
}

export type GatewayResponder = (request: RecordedRequest) => Response | Promise<Response>;

export interface FakeGateway {
  url: string;
  requests: RecordedRequest[];
  respond: GatewayResponder;
  stop(): Promise<void>;
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Envelope with a backend identity, wrapped in the legacy `{result}`. */
export function envelope(response: PublicActionResponse, installationId = "install-a"): Response {
  return json({ result: { ...response, backend: { installationId, generation: "gen-1" } } });
}

export function defaultResponder(
  overrides: Partial<Record<string, PublicActionResponse>> = {},
): GatewayResponder {
  return (request) => {
    const action = String(request.body.args.action);
    if (overrides[action]) return envelope(overrides[action]!);
    if (action === "capabilities")
      return envelope(publicSuccessEnvelope("capabilities", capabilities()));
    if (action === "project.list")
      return envelope(publicSuccessEnvelope("project.list", { items: [], total: 0 }));
    return envelope(publicErrorEnvelope(action, { code: "not-found", message: "no fixture" }));
  };
}

export async function startFakeGateway(
  respond: GatewayResponder = defaultResponder(),
): Promise<FakeGateway> {
  const requests: RecordedRequest[] = [];
  const gateway: FakeGateway = {
    url: "",
    requests,
    respond,
    async stop() {
      server.stop(true);
    },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as RecordedRequest["body"];
      const recorded = { authorization: request.headers.get("authorization"), body };
      requests.push(recorded);
      return gateway.respond(recorded);
    },
  });
  gateway.url = `http://127.0.0.1:${server.port}`;
  return gateway;
}

export interface ClientSandbox {
  root: string;
  configDir: string;
  env: Record<string, string | undefined>;
  run(
    argv: string[],
    io?: CapturedIo,
  ): Promise<{ code: number; out: string; err: string; io: CapturedIo }>;
  /** Write a backend-instance descriptor for `gateway` into a fake data dir. */
  publishDescriptor(
    gateway: FakeGateway,
    options?: { installationId?: string; pid?: number },
  ): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createSandbox(): Promise<ClientSandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-cli-client-"));
  const configDir = path.join(root, "cli-config");
  const env = {
    ORKESTRATOR_CLI_CONFIG_DIR: configDir,
    ORKESTRATOR_DEV_ROOT: path.join(root, "dev-root"),
    HOME: root,
  };
  return {
    root,
    configDir,
    env,
    async run(argv, io = captureIo(env, root)) {
      const code = await runClient(argv, { io, version: "9.9.9" });
      return { code, out: io.out.join(""), err: io.err.join(""), io };
    },
    async publishDescriptor(gateway, options = {}) {
      const dataDir = path.join(root, `data-${Math.random().toString(36).slice(2)}`);
      await mkdir(dataDir, { recursive: true });
      const authFile = path.join(dataDir, "gateway-auth.json");
      await writeFile(authFile, JSON.stringify({ token: TOKEN }));
      await chmod(authFile, 0o600);
      await writeFile(
        path.join(dataDir, "backend-instance.json"),
        JSON.stringify({
          version: 1,
          type: BACKEND_INSTANCE_DESCRIPTOR_TYPE,
          installationId: options.installationId ?? "install-a",
          generation: "gen-1",
          pid: options.pid ?? process.pid,
          startedAt: new Date(0).toISOString(),
          url: gateway.url,
          authFile,
          dataDir,
          appVersion: "test",
          publicApiSchemaVersion: 1,
        }),
      );
      return dataDir;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
