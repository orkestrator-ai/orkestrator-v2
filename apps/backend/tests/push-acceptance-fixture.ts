/**
 * Acceptance fixture for the push event layer (to-do 8102 task 7,
 * docs/architecture/push-events.md "Measured result").
 *
 * Everything between the bridge and the client is real: the real gateway on a
 * loopback port, the real `BackendPush` (hub and `native-session` topic), the
 * real `NativeAgentService` with the real `HttpBridgeProvider`, the real
 * `PushSubscriptionClient` reading frames off a real SSE socket, and the real
 * read-policy code the live view uses (`native-session-read-policy.ts`). Only
 * the bridge is fake: a Claude bridge answered in process through `fetchImpl`
 * that counts every request by route and serves its transcript with the
 * shared bridge transcript code (as `conditional-reads-baseline.ts` does).
 *
 * Time is a `ManualClock` shared by the hub, the observer, the viewers'
 * polls and the bridge's streaming, so a quiet ten minutes takes seconds and
 * every cadence is exact. After each timer the clock waits for the real I/O
 * it caused (gateway requests, SSE bytes, observer reads) to finish, so a
 * reading is taken only when the system is quiescent. Latency is reported in
 * two parts: virtual (scheduling: cadences, throttle, coalescing window) and
 * wall (the real processing time of the chain on this host).
 *
 * A viewer is the live view reduced to what decides its traffic: a mount
 * read, background rounds of `get_native_agent_live_update` with the tokens
 * it holds, at the cadence `nativeSessionReadDemand` gives it, an immediate
 * read on an invalidation (a push change, an activity announcement), and the
 * push subscription through the shared client. Discovery reads are not
 * modelled: push does not change their 30 s backstop.
 *
 * Only counts, bytes and milliseconds leave this module; the content is
 * synthetic.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { connect as connectSocket, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  NativeAgentToolOutputRead,
  ToolOutputReadMode,
} from "@orkestrator/protocol/native-agent-tool-output";
import { configureLogger } from "@orkestrator/protocol/logger";
import {
  DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
  NATIVE_AGENT_LIVE_UPDATE_VERSION,
} from "@orkestrator/protocol/native-agent";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "@orkestrator/protocol/native-agent-transcript-patch";
import {
  NATIVE_AGENT_ACTIVITY_EVENT,
  parseNativeAgentActivityAnnouncement,
} from "@orkestrator/protocol/native-agent-observation";
import {
  bridgeTranscriptDetailRouteBody,
  bridgeTranscriptOutputRouteBody,
  bridgeTranscriptRouteBody,
} from "@orkestrator/protocol/node/bridge-transcript-routes";
import { RecentlyRevisedRows } from "@orkestrator/protocol/node/revised-rows";
import {
  PushSubscriptionClient,
  type PushClientDiagnostics,
  type PushKeyChange,
} from "@orkestrator/protocol/push-client";
import {
  NATIVE_SESSION_PUSH_TOPIC,
  PUSH_CHANGED_EVENT,
  PUSH_RESYNC_EVENT,
  formatNativeSessionPushKey,
  parsePushStreamOffer,
  type PushSetSubscriptionsResult,
} from "@orkestrator/protocol/push-events";
import { ManualClock } from "@orkestrator/protocol/testing/manual-clock";
import { HttpBridgeProvider } from "../src/core/http-bridge/index.js";
import { NativeAgentService } from "../src/core/native-agent-service.js";
import { projectionInternals } from "../src/core/native-agent-service-test-collaborators.js";
import { registryCommandAccess } from "../src/core/nodes/workspace-grant-test-support.js";
import { BackendPush } from "../src/core/push/index.js";
import { StorageService } from "../src/core/storage.js";
import { OrkestratorGateway } from "../src/gateway.js";

configureLogger({ level: "error" });

// ---------------------------------------------------------------------------
// The live view's read policy, loaded from the web app at run time. A static
// import would pull the renderer's `@/` aliases into the backend typecheck.

interface ReadDemand {
  intervalMs: number;
  quietBackoffMs: readonly number[] | null;
}
type ReadDemandFn = (
  platform: string,
  phase: string | undefined,
  options: {
    active: boolean;
    observationEvents?: boolean;
    quietObservation?: boolean;
    pushHealthy?: boolean;
  },
) => ReadDemand;

let readDemand: ReadDemandFn | null = null;
async function loadReadPolicy(): Promise<ReadDemandFn> {
  if (readDemand) return readDemand;
  const modulePath = path.join(import.meta.dir, "../../web/src/lib/native-session-read-policy.ts");
  const loaded = (await import(modulePath)) as { nativeSessionReadDemand: ReadDemandFn };
  readDemand = loaded.nativeSessionReadDemand;
  return readDemand;
}

// ---------------------------------------------------------------------------
// The fake Claude bridge.

export const SESSION = {
  environmentId: "env-1",
  agent: "claude",
  logicalSessionKey: "env-env-1:push-acceptance",
} as const;
export const PUSH_KEY = formatNativeSessionPushKey(SESSION);
export const TOOL_CALL_ID = "acceptance-tool";

interface Row {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: Array<Record<string, unknown>>;
  createdAt: string;
}

const fill = (bytes: number, seed: number) =>
  "abcdefghijklmnopqrstuvwxyz0123456789 "
    .repeat(Math.ceil(bytes / 37) + 1)
    .slice(seed % 37, (seed % 37) + bytes);

/** A change marker carried in the tail's text, so a reader can tell which change it has seen. */
const MARKER = /~r(\d+)~/g;
export function newestMarker(text: string): number {
  let newest = 0;
  for (const match of text.matchAll(MARKER)) newest = Math.max(newest, Number(match[1]));
  return newest;
}

/**
 * How the fake bridge signals changes.
 *
 * - `cadence`: a bridge before to-do 8102 task 2. No observe stream (404) and
 *   no state revision, so the push observer reads at the old cadence.
 * - `revisions`: a bridge that advertises `"revisions": 1` on
 *   `GET /event/subscribe?observe=1` and sends a frame per change carrying
 *   the session's `stateRevision` and `transcriptRevision`. Its state route
 *   answers `{ unchanged: true }` to a current `knownStateRevision`. The push
 *   observer then reads only on those hints plus its 30 s backstop.
 */
export type BridgeSignalMode = "cadence" | "revisions";

/** A Claude bridge answered in process; counts every request at the boundary. */
export class FakeClaudeBridge {
  readonly messages: Row[];
  readonly revised = new RecentlyRevisedRows();
  revision = 1;
  status: "idle" | "running" = "idle";
  /** Moves on a state-only change (a question, an approval) the transcript does not show. */
  stateRevision = 1;
  private readonly routes = new Map<string, number>();
  outputResponseBytes = 0;
  private tailIndex = -1;
  private tick = 0;
  /** Virtual time of each change, by revision, while recording. */
  readonly changedAt = new Map<number, number>();
  recording = false;

  /** Moves with every change of what the state route returns. */
  private stateCounter = 1;
  private frameId = 0;
  private readonly observeStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly now: () => number,
    readonly mode: BridgeSignalMode = "cadence",
  ) {
    this.messages = Array.from({ length: 40 }, (_, index) => {
      const assistant = index % 2 === 1;
      return {
        id: `m${index}`,
        role: assistant ? "assistant" : "user",
        content: fill(assistant ? 1_200 : 200, index),
        parts: assistant
          ? [{ type: "text", content: fill(1_200, index), sourcePartId: `m${index}:0` }]
          : [],
        createdAt: new Date(Date.UTC(2026, 10, 5, 0, 0, index)).toISOString(),
      };
    });
  }

  /** A turn starts: a prompt row and a new response. */
  startTurn(): void {
    this.status = "running";
    this.stateCounter += 1;
    this.messages.push({
      id: `u${this.messages.length}`,
      role: "user",
      content: "Continue.",
      parts: [],
      createdAt: new Date(this.now()).toISOString(),
    });
    this.newResponse();
  }

  endTurn(): void {
    this.status = "idle";
    this.stateCounter += 1;
    this.changed(this.messages[this.tailIndex]!.id);
  }

  /** A state-only change. */
  moveState(): void {
    this.stateRevision += 1;
    this.stateCounter += 1;
    this.signal();
  }

  private stateRevisionToken(): string {
    return `acceptance:${this.stateCounter}`;
  }

  /** One observe frame for the session: what a revisions-capable bridge sends per event. */
  private signal(): void {
    if (this.mode !== "revisions" || this.observeStreams.size === 0) return;
    this.frameId += 1;
    const data = JSON.stringify({
      sessionId: "provider-session",
      stateRevision: this.stateRevisionToken(),
      transcriptRevision: `t${this.revision}`,
    });
    const frame = this.encoder.encode(
      `id: ${this.frameId}\nevent: session.updated\ndata: ${data}\n\n`,
    );
    for (const controller of this.observeStreams) controller.enqueue(frame);
  }

  /** Close every observe stream (a bridge going away). */
  closeObserveStreams(): void {
    for (const controller of this.observeStreams) {
      try {
        controller.close();
      } catch {
        // Already closed by its reader.
      }
    }
    this.observeStreams.clear();
  }

  /** One streamed event: the tail grows by about 120 bytes; a new response every 50. */
  stream(): number {
    this.tick += 1;
    if (this.tick % 50 === 0) this.newResponse();
    const tail = this.messages[this.tailIndex]!;
    const text = tail.parts[tail.parts.length - 1]!;
    const revision = this.revision + 1;
    const grown = {
      ...text,
      content: `${String(text.content)}${fill(110, this.tick)} ~r${revision}~`,
    };
    this.messages[this.tailIndex] = {
      ...tail,
      parts: [...tail.parts.slice(0, -1), grown],
      content: String(grown.content),
    };
    this.changed(tail.id);
    return this.revision;
  }

  toolMessageId(): string {
    return this.messages[this.tailIndex]!.id;
  }

  writeToolOutput(output: string): void {
    const row = this.messages[this.tailIndex]!;
    const part = {
      type: "tool-invocation",
      sourcePartId: `${row.id}:tool`,
      toolUseId: TOOL_CALL_ID,
      content: "Fixture output",
      toolName: "Bash",
      toolState: "pending",
      toolOutput: output,
    };
    this.messages[this.tailIndex] = {
      ...row,
      parts: [...row.parts.filter((entry) => entry.toolUseId !== TOOL_CALL_ID), part],
    };
    this.changed(row.id);
  }

  private newResponse(): void {
    this.messages.push({
      id: `a${this.messages.length}`,
      role: "assistant",
      content: "",
      parts: [{ type: "text", content: "", sourcePartId: `a${this.messages.length}:0` }],
      createdAt: new Date(this.now()).toISOString(),
    });
    this.tailIndex = this.messages.length - 1;
    this.changed(this.messages[this.tailIndex]!.id);
  }

  private changed(id: string): void {
    this.revision += 1;
    this.revised.note(id);
    if (this.recording) this.changedAt.set(this.revision, this.now());
    this.signal();
  }

  routeCounts(): Record<string, number> {
    return Object.fromEntries([...this.routes].sort(([a], [b]) => a.localeCompare(b)));
  }

  /** Bridge reads a viewer's round can cause (the observation stream excluded). */
  readCalls(): number {
    let total = 0;
    for (const [route, count] of this.routes) {
      if (!route.includes("/event/subscribe")) total += count;
    }
    return total;
  }

  resetRoutes(): void {
    this.routes.clear();
  }

  private answer(route: string, body: unknown, status = 200): Response {
    this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
    const json = JSON.stringify(body);
    if (route.endsWith("/transcript/output")) this.outputResponseBytes += Buffer.byteLength(json);
    return new Response(json, {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private stateBody(): Record<string, unknown> {
    // Claude's whole session resource (`bridges/claude-bridge/src/routes/session.ts`).
    return {
      id: "provider-session",
      status: this.status,
      title: "Acceptance session",
      // The state marker: a reader can tell which state change it has seen.
      contextUsage: { usedTokens: 12_000 + this.stateRevision, maxTokens: 200_000 },
      turnStartedAt: this.status === "running" ? "2026-11-05T00:00:00.000Z" : undefined,
      createdAt: "2026-11-05T00:00:00.000Z",
      lastActivity: "2026-11-05T00:00:00.000Z",
      activity: this.status === "running" ? { kind: "responding" } : undefined,
      backgroundTasks: {},
      retainedContinuationRequestIds: [],
      completionBlockedByBackgroundTasks: false,
      rewindInProgress: false,
      commandRevision: 1,
      ...(this.mode === "revisions" ? { stateRevision: this.stateRevisionToken() } : {}),
    };
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const segments = url.pathname.split("/").filter(Boolean);
    const route = `${method} /${segments
      .map((s, i) => (i === 1 && segments[0] === "session" && s !== "create" ? ":id" : s))
      .join("/")}`;
    if (route === "POST /session/create")
      return this.answer(route, { sessionId: "provider-session" });
    if (route === "GET /session/:id" || route === "GET /session/:id/status") {
      const known = url.searchParams.get("knownStateRevision");
      if (this.mode === "revisions" && known === this.stateRevisionToken()) {
        return this.answer(route, { unchanged: true, stateRevision: known });
      }
      return this.answer(route, this.stateBody());
    }
    if (route === "GET /event/subscribe" && this.mode === "revisions") {
      this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
      let own: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          own = controller;
          this.observeStreams.add(controller);
          controller.enqueue(
            this.encoder.encode(`event: connected\ndata: ${JSON.stringify({ revisions: 1 })}\n\n`),
          );
        },
        cancel: () => {
          if (own) this.observeStreams.delete(own);
        },
      });
      init?.signal?.addEventListener(
        "abort",
        () => {
          if (!own) return;
          this.observeStreams.delete(own);
          try {
            own.close();
          } catch {
            // Already closed.
          }
        },
        { once: true },
      );
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (
      route === "GET /session/:id/transcript" ||
      route === "GET /session/:id/transcript/detail" ||
      route === "GET /session/:id/transcript/output"
    ) {
      const source = {
        messages: this.messages,
        sessionIdentity: "provider-session",
        generation: "g1",
        contentEpoch: 1,
        revision: this.revision,
        complete: true,
        revisedMessageIds: this.revised.ids(),
        revisedRowsOverflowVersion: this.revised.overflowVersion,
      };
      const query = (name: string) => url.searchParams.get(name);
      const body = route.endsWith("/detail")
        ? bridgeTranscriptDetailRouteBody(source, query)
        : route.endsWith("/output")
          ? bridgeTranscriptOutputRouteBody(source, query)
          : bridgeTranscriptRouteBody(source, query);
      return this.answer(route, body);
    }
    if (route === "GET /session/:id/activity") {
      return this.answer(route, { activity: this.status === "running" ? "running" : "idle" });
    }
    if (route === "GET /session/:id/questions") return this.answer(route, { questions: [] });
    if (route === "GET /session/:id/plan-approvals") return this.answer(route, { approvals: [] });
    if (route === "GET /session/:id/interactions") return this.answer(route, { interactions: [] });
    if (route === "GET /session/:id/queue") return this.answer(route, { items: [] });
    if (route === "GET /session/:id/steer/dispatch")
      return this.answer(route, { dispatch: "unknown" });
    return this.answer(route, { error: "not served by the acceptance bridge" }, 404);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Loopback HTTP, measured at the socket.

interface HttpAnswer {
  status: number;
  body: string;
  /** Bytes on the wire: request line, headers and body out; status, headers and body in. */
  wireOut: number;
  wireIn: number;
}

function httpCall(
  base: string,
  pathAndQuery: string,
  options: { method: string; token: string; body?: string; signal?: AbortSignal },
): Promise<HttpAnswer> {
  const url = new URL(pathAndQuery, base);
  return new Promise((resolve, reject) => {
    let request: ClientRequest | null = null;
    request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const socket = request!.socket;
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            wireOut: socket?.bytesWritten ?? 0,
            wireIn: socket?.bytesRead ?? 0,
          });
        });
      },
    );
    request.on("error", reject);
    options.signal?.addEventListener("abort", () => request?.destroy(), { once: true });
    request.end(options.body);
  });
}

// ---------------------------------------------------------------------------
// Viewers.

interface ViewerStream {
  socket: Socket;
  paused: boolean;
  pause(): void;
  resume(): void;
}

/** An HTTP/1.1 response body off a raw socket: headers skipped, chunked framing removed. */
class HttpBodyDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private headersDone = false;
  private chunked = false;
  /** Bytes left in the current chunk; -1 while reading a size line, -2 for its trailing CRLF. */
  private remaining = -1;

  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.byteLength ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: Buffer[] = [];
    if (!this.headersDone) {
      const end = this.pending.indexOf("\r\n\r\n");
      if (end < 0) return out;
      const head = this.pending.subarray(0, end).toString("latin1");
      this.chunked = /\r\ntransfer-encoding:\s*chunked/i.test(head);
      this.headersDone = true;
      this.pending = this.pending.subarray(end + 4);
    }
    if (!this.chunked) {
      if (this.pending.byteLength) out.push(this.pending);
      this.pending = Buffer.alloc(0);
      return out;
    }
    for (;;) {
      if (this.remaining === -1) {
        const line = this.pending.indexOf("\r\n");
        if (line < 0) break;
        this.remaining = Number.parseInt(this.pending.subarray(0, line).toString("latin1"), 16);
        this.pending = this.pending.subarray(line + 2);
        if (this.remaining === 0) break;
      } else if (this.remaining === -2) {
        if (this.pending.byteLength < 2) break;
        this.pending = this.pending.subarray(2);
        this.remaining = -1;
      } else {
        if (this.pending.byteLength === 0) break;
        const take = Math.min(this.remaining, this.pending.byteLength);
        out.push(this.pending.subarray(0, take));
        this.pending = this.pending.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) this.remaining = -2;
      }
    }
    return out;
  }
}

export interface ViewerFaults {
  /** `push.changed`/`push.resync` frames dropped before the client sees them, by `seq`. */
  dropSeq?: ReadonlySet<number>;
  /** Frames delivered twice, by `seq`. */
  duplicateSeq?: ReadonlySet<number>;
  /**
   * Ignore activity announcements, so only push invalidates the view: the
   * push layer's own latency for an announced change.
   */
  ignoreActivity?: boolean;
  /** Take push through a command gateway while reads still go to this leaf. */
  pushRoute?: { command: AcceptanceStack; nodeId: string };
}

export interface ViewerCounters {
  /** Background rounds of `get_native_agent_live_update`, by what started them. */
  reads: number;
  readsByReason: Record<string, number>;
  readWireOut: number;
  readWireIn: number;
  setCalls: number;
  setWireOut: number;
  setWireIn: number;
  /** Bytes received on the event-stream socket, HTTP framing included. */
  sseBytes: number;
  pushFrames: number;
  /** Transcript answers by status. */
  transcript: Record<string, number>;
}

const emptyCounters = (): ViewerCounters => ({
  reads: 0,
  readsByReason: {},
  readWireOut: 0,
  readWireIn: 0,
  setCalls: 0,
  setWireOut: 0,
  setWireIn: 0,
  sseBytes: 0,
  pushFrames: 0,
  transcript: {},
});

export interface Observation {
  /** Bridge revision of the change. */
  revision: number;
  /** Virtual milliseconds from the bridge change to the read that showed it. */
  virtualMs: number;
  /** Real milliseconds spent, on this host, between that read's trigger and its answer. */
  wallMs: number;
}

export class Viewer {
  readonly counters = emptyCounters();
  readonly client: PushSubscriptionClient;
  transcriptToken: string | undefined;
  stateToken: string | undefined;
  phase: string | undefined;
  /** The context-usage figure the newest state answer showed (the bridge's state marker). */
  stateMarker: number | undefined;
  quietObservation = false;
  /** Newest bridge revision this viewer's reads have shown. */
  seenRevision = 0;
  readonly observations: Observation[] = [];
  readonly setAnswers: PushSetSubscriptionsResult[] = [];
  private pollTimer: unknown = null;
  private quietIndex = 0;
  private reading = false;
  private readAgain: string | null = null;
  private invalidatedAtWall: number | null = null;
  private stream: ViewerStream | null = null;
  /** Bytes the gateway wrote to this viewer's stream, and bytes it received. */
  private streamWritten = 0;
  private streamReceived = 0;
  private stopSubscription: (() => void) | null = null;
  private closed = false;
  inFlight = 0;

  constructor(
    readonly name: string,
    private readonly stack: AcceptanceStack,
    private readonly faults: ViewerFaults = {},
  ) {
    this.client = new PushSubscriptionClient({
      timers: stack.clock,
      now: () => performance.now(),
      ...(faults.pushRoute ? { nodeId: faults.pushRoute.nodeId } : {}),
      setSubscriptions: async (args, signal) => {
        this.inFlight += 1;
        try {
          const info = this.pushStack().info;
          const answer = await httpCall(info.url, "__orkestrator/invoke", {
            method: "POST",
            token: info.token,
            body: JSON.stringify({ command: "push_set_subscriptions", args }),
            signal,
          });
          this.counters.setCalls += 1;
          this.counters.setWireOut += answer.wireOut;
          this.counters.setWireIn += answer.wireIn;
          if (answer.status !== 200) throw new Error(`push_set_subscriptions ${answer.status}`);
          const result = (JSON.parse(answer.body) as { result: PushSetSubscriptionsResult }).result;
          this.setAnswers.push(result);
          return result;
        } finally {
          this.inFlight -= 1;
        }
      },
    });
    this.client.onHealthChange(() => {
      if (!this.closed && !this.reading) this.schedulePoll();
    });
  }

  private pushStack(): AcceptanceStack {
    return this.faults.pushRoute?.command ?? this.stack;
  }

  /** Whether the stream has delivered every byte the gateway wrote to it. */
  streamDrained(): boolean {
    return this.stream === null || this.stream.paused || this.streamReceived >= this.streamWritten;
  }

  pushHealthy(): boolean {
    return this.client.isHealthy(NATIVE_SESSION_PUSH_TOPIC, PUSH_KEY);
  }

  diagnostics(): PushClientDiagnostics {
    return this.client.diagnostics();
  }

  /** Open the event stream, subscribe, and take the mount read. */
  async mount(): Promise<void> {
    await this.connect();
    this.stopSubscription = this.client.subscribe(
      NATIVE_SESSION_PUSH_TOPIC,
      PUSH_KEY,
      (change: PushKeyChange) => this.invalidate(`push-${change.reason}`),
    );
    await this.read("mount");
  }

  /** Open (or reopen) the event stream against the stack's current gateway. */
  async connect(): Promise<void> {
    const gateway = this.pushStack();
    const url = new URL("__orkestrator/events?excludeEvents=terminal-output-", gateway.info.url);
    const known = new Set(gateway.eventWriters().keys());
    let text = "";
    let opened = false;
    // A raw socket, so pausing it really stops reading: the kernel buffers
    // fill and the gateway's own queue grows, as for a slow client.
    const socket = connectSocket({ host: url.hostname, port: Number(url.port) });
    const body = new HttpBodyDecoder();
    const handle: ViewerStream = {
      socket,
      paused: false,
      pause: () => {
        handle.paused = true;
        socket.pause();
      },
      resume: () => {
        handle.paused = false;
        socket.resume();
      },
    };
    socket.on("data", (chunk: Buffer) => {
      this.counters.sseBytes += chunk.byteLength;
      for (const payload of body.push(chunk)) {
        this.streamReceived += payload.byteLength;
        text += payload.toString("utf8");
      }
      let end = text.indexOf("\n\n");
      while (end >= 0) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        if (block.startsWith(": connected")) opened = true;
        this.onBlock(block);
        end = text.indexOf("\n\n");
      }
    });
    socket.on("close", () => this.onStreamEnded(socket));
    socket.on("error", () => this.onStreamEnded(socket));
    this.stream = handle;
    this.streamWritten = 0;
    this.streamReceived = 0;
    socket.write(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n` +
        `Authorization: Bearer ${gateway.info.token}\r\nAccept: text/event-stream\r\n\r\n`,
    );
    await waitReal(() => opened, "event stream never connected");
    const writer = [...gateway.eventWriters().keys()].find((candidate) => !known.has(candidate));
    if (!writer) throw new Error("gateway did not register the event stream");
    // Count what the gateway writes from here on, so a reading can wait for it.
    this.streamWritten = this.streamReceived;
    const write = writer.write.bind(writer);
    writer.write = (chunk: string | Buffer, byteLength?: number) => {
      this.streamWritten += byteLength ?? Buffer.byteLength(chunk);
      return write(chunk, byteLength);
    };
    this.stack.writers.set(this, writer);
  }

  pauseStream(): void {
    this.stream?.pause();
  }

  resumeStream(): void {
    this.stream?.resume();
  }

  /** Server-side bytes buffered for this viewer's stream (the gateway's queue). */
  queuedBytes(): number {
    return this.stack.writers.get(this)?.writableLength ?? 0;
  }

  /** The stream drops (network loss, backend gone). */
  disconnect(): void {
    const stream = this.stream;
    this.stream = null;
    stream?.socket.destroy();
    this.client.streamDisconnected();
  }

  close(): void {
    this.closed = true;
    this.stopSubscription?.();
    this.stopSubscription = null;
    if (this.pollTimer !== null) this.stack.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.disconnect();
    this.client.dispose();
  }

  private onStreamEnded(socket: Socket): void {
    if (this.stream?.socket !== socket) return;
    this.stream = null;
    this.client.streamDisconnected();
  }

  private onBlock(block: string): void {
    // Only the frames a view acts on are parsed; other events are counted bytes.
    if (
      !block.includes('"event":"push.') &&
      !block.includes('"event":"gateway.connected"') &&
      !block.includes(`"event":"${NATIVE_AGENT_ACTIVITY_EVENT}"`)
    )
      return;
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!data) return;
    let envelope: { event?: string; payload?: unknown };
    try {
      envelope = JSON.parse(data) as { event?: string; payload?: unknown };
    } catch {
      return;
    }
    const event = envelope.event ?? "";
    if (event === "gateway.connected") {
      this.client.streamConnected(parsePushStreamOffer(envelope.payload));
      return;
    }
    if (event === PUSH_CHANGED_EVENT || event === PUSH_RESYNC_EVENT) {
      const seq = (envelope.payload as { seq?: number } | undefined)?.seq ?? -1;
      if (this.faults.dropSeq?.has(seq)) return;
      this.counters.pushFrames += 1;
      this.client.accept(event, envelope.payload);
      if (this.faults.duplicateSeq?.has(seq)) this.client.accept(event, envelope.payload);
      return;
    }
    if (event === NATIVE_AGENT_ACTIVITY_EVENT && !this.faults.ignoreActivity) {
      // The view's observation invalidation (native-observation-events.ts).
      // While its subscription is healthy the push frame is the read
      // (useNativeAgentSession), so the announcement alone reads nothing.
      const announcement = parseNativeAgentActivityAnnouncement(envelope.payload);
      if (
        !this.pushHealthy() &&
        announcement?.environmentId === SESSION.environmentId &&
        (announcement.logicalSessionKey === undefined ||
          announcement.logicalSessionKey === SESSION.logicalSessionKey)
      ) {
        this.invalidate("activity");
      }
    }
  }

  /** The coordinator's invalidate: read now, or once more after the read in flight. */
  invalidate(reason: string): void {
    if (this.closed) return;
    this.invalidatedAtWall ??= performance.now();
    if (this.reading) {
      this.readAgain = reason;
      return;
    }
    void this.read(reason);
  }

  private schedulePoll(): void {
    if (this.closed) return;
    if (this.pollTimer !== null) this.stack.clock.clearTimeout(this.pollTimer);
    const demand = this.stack.policy("claude", this.phase, {
      active: true,
      observationEvents: true,
      quietObservation: this.quietObservation,
      pushHealthy: this.pushHealthy(),
    });
    let interval = demand.intervalMs;
    if (demand.quietBackoffMs && this.quietIndex > 0) {
      interval =
        demand.quietBackoffMs[Math.min(this.quietIndex - 1, demand.quietBackoffMs.length - 1)]!;
    }
    this.pollTimer = this.stack.clock.setTimeout(() => {
      this.pollTimer = null;
      void this.read(this.pushHealthy() ? "recovery-poll" : "poll");
    }, interval);
  }

  private async read(reason: string): Promise<void> {
    if (this.closed) return;
    if (this.reading) {
      this.readAgain = reason;
      return;
    }
    this.reading = true;
    this.inFlight += 1;
    if (this.pollTimer !== null) this.stack.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const startedWall = this.invalidatedAtWall ?? performance.now();
    this.invalidatedAtWall = null;
    const background = reason !== "mount";
    try {
      const args = {
        ...SESSION,
        viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION,
        liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
        patchVersion: NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION,
        ...(this.transcriptToken ? { transcriptToken: this.transcriptToken } : {}),
        ...(this.stateToken ? { stateToken: this.stateToken } : {}),
      };
      const answer = await httpCall(this.stack.info.url, "__orkestrator/invoke", {
        method: "POST",
        token: this.stack.info.token,
        body: JSON.stringify({ command: "get_native_agent_live_update", args }),
      });
      if (background) {
        this.counters.reads += 1;
        this.counters.readsByReason[reason] = (this.counters.readsByReason[reason] ?? 0) + 1;
        this.counters.readWireOut += answer.wireOut;
        this.counters.readWireIn += answer.wireIn;
      }
      if (answer.status === 200) this.apply(answer.body, reason, startedWall);
    } catch {
      // A read lost to a restart; the next round covers it.
    } finally {
      this.inFlight -= 1;
      this.reading = false;
    }
    if (this.closed) return;
    const again = this.readAgain;
    this.readAgain = null;
    if (again !== null) {
      void this.read(again);
      return;
    }
    this.schedulePoll();
  }

  private apply(body: string, reason: string, startedWall: number): void {
    const result = (
      JSON.parse(body) as {
        result: {
          transcript: { status: string; token?: string };
          state: {
            status: string;
            token?: string;
            value?: {
              turn?: { phase?: string; quietObservation?: boolean };
              contextUsage?: { usedTokens?: number };
            };
          };
        };
      }
    ).result;
    const { transcript, state } = result;
    this.counters.transcript[transcript.status] =
      (this.counters.transcript[transcript.status] ?? 0) + 1;
    if (transcript.token) this.transcriptToken = transcript.token;
    if (state.token) this.stateToken = state.token;
    const recovery = reason === "recovery-poll";
    const moved = transcript.status !== "unchanged" || state.status !== "unchanged";
    if (state.status === "snapshot" && state.value) {
      this.phase = state.value.turn?.phase;
      this.quietObservation = state.value.turn?.quietObservation === true;
      this.stateMarker = state.value.contextUsage?.usedTokens;
    }
    this.quietIndex = moved ? 0 : this.quietIndex + 1;
    if (recovery && moved) this.client.noteRecoveryReadFoundChange(NATIVE_SESSION_PUSH_TOPIC);
    const newest = newestMarker(body);
    if (newest > this.seenRevision) {
      const wallMs = performance.now() - startedWall;
      for (const [revision, changedAt] of this.stack.bridge.changedAt) {
        if (revision <= this.seenRevision || revision > newest) continue;
        this.observations.push({
          revision,
          virtualMs: this.stack.clock.now() - changedAt,
          wallMs,
        });
      }
      this.seenRevision = newest;
    }
  }
}

async function waitReal(predicate: () => boolean, message: string, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// ---------------------------------------------------------------------------
// The stack.

export interface AcceptanceStackOptions {
  /** A backend with the push layer; without it the gateway offers none (the old cadence). */
  push: boolean;
  /** How the bridge signals changes (default `cadence`). */
  bridge?: BridgeSignalMode;
  clock?: ManualClock;
}

type EventWriter = {
  readonly writableLength: number;
  write(chunk: string | Buffer, byteLength?: number): boolean;
};

export class AcceptanceStack {
  readonly clock: ManualClock;
  readonly bridge: FakeClaudeBridge;
  readonly writers = new Map<Viewer, EventWriter>();
  readonly viewers: Viewer[] = [];
  service!: NativeAgentService;
  push: BackendPush | null = null;
  gateway!: OrkestratorGateway;
  info!: { url: string; token: string };
  policy!: ReadDemandFn;
  /** Observer reads in flight (the topic's provider read). */
  private observerReads = 0;
  private gatewayMetrics!: () => { stream: { sourceBytes: number } };
  private dataDir = "";
  private storage!: StorageService;
  /** The service's wall clock: virtual time from a fixed date. */
  private readonly base = Date.UTC(2026, 10, 19);

  private constructor(private readonly options: AcceptanceStackOptions) {
    this.clock = options.clock ?? new ManualClock();
    this.bridge = new FakeClaudeBridge(() => this.clock.now(), options.bridge ?? "cadence");
  }

  static async start(options: AcceptanceStackOptions): Promise<AcceptanceStack> {
    const stack = new AcceptanceStack(options);
    stack.policy = await loadReadPolicy();
    stack.dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-push-acceptance-"));
    stack.storage = new StorageService(stack.dataDir);
    await stack.storage.init();
    await stack.storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Environment",
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: stack.dataDir,
      setupScriptsComplete: true,
    } as Parameters<StorageService["addEnvironment"]>[0]);
    const rendererRoot = path.join(stack.dataDir, "dist");
    await mkdir(rendererRoot);
    await writeFile(path.join(rendererRoot, "index.html"), '<div id="root"></div>');
    await stack.startBackend();
    await stack.service.ensureSession(SESSION);
    return stack;
  }

  /** Service, push layer and gateway: what a backend process owns. */
  private async startBackend(): Promise<void> {
    const provider = new HttpBridgeProvider(
      { agent: "claude", baseUrl: "http://acceptance-bridge.invalid", authToken: "acceptance" },
      this.bridge.fetch,
      undefined,
      // The backend's wiring (core/index.ts): a bridge hint wakes the push observer.
      (providerSessionId, parts) =>
        this.push?.nativeSessions.wakeProvider(
          SESSION.environmentId,
          SESSION.agent,
          providerSessionId,
          parts,
        ),
    );
    const service = new NativeAgentService(
      this.storage,
      (async (command: string) => {
        throw new Error(`Unexpected backend command: ${command}`);
      }) as never,
      { provider: async () => provider, now: () => this.base + this.clock.now() },
    );
    projectionInternals(service).setObservedShareClock(() => this.clock.now());
    this.service = service;
    if (this.options.push) {
      this.push = new BackendPush({
        hub: { timers: this.clock, now: () => this.clock.now() },
        sessionExists: async () => true,
        nativeAgents: () => ({
          getLiveUpdate: async (input) => {
            this.observerReads += 1;
            try {
              return await service.getLiveUpdate(input);
            } finally {
              this.observerReads -= 1;
            }
          },
          observePushSession: (environmentId, agent, logicalSessionKey) =>
            service.observePushSession(environmentId, agent, logicalSessionKey),
          canWakePushObserverFromBridge: (environmentId, agent) =>
            service.canWakePushObserverFromBridge(environmentId, agent),
          forgetPushSettled: (environmentId, agent, logicalSessionKey) =>
            service.forgetPushSettled(environmentId, agent, logicalSessionKey),
          toolOutputSource: (environmentId, agent, logicalSessionKey, toolUseId, messageId) =>
            service.toolOutputSource(environmentId, agent, logicalSessionKey, toolUseId, messageId),
          notePushHint: (environmentId, agent, logicalSessionKey) =>
            service.notePushHint(environmentId, agent, logicalSessionKey),
        }),
      });
    }
    this.gateway = new OrkestratorGateway({
      backend: {
        commandAccess: registryCommandAccess,
        attachGatewayMetrics: (read) => {
          this.gatewayMetrics = read as typeof this.gatewayMetrics;
        },
        ...(this.push ? { push: this.push } : {}),
        invoke: async (command, args) => {
          if (command === "get_native_agent_tool_output") {
            return service.readToolOutput(args as never);
          }
          if (command !== "get_native_agent_live_update")
            throw new Error(`Unexpected gateway command: ${command}`);
          return service.getLiveUpdate(args as never);
        },
      },
      dataDir: this.dataDir,
      rendererRoot: path.join(this.dataDir, "dist"),
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "acceptance-token-123456" },
      allowNonTailscaleBind: true,
    });
    const info = await this.gateway.start();
    if (!info) throw new Error("gateway did not start");
    this.info = info;
  }

  /**
   * The backend process is replaced (a restart): the old gateway, push layer
   * and service go away with their streams, a new set starts over the same
   * storage, and every viewer's stream reconnects to it. The bridge, like a
   * bridge process, keeps running.
   */
  async restartBackend(changeWhileDown?: () => void): Promise<void> {
    for (const viewer of this.viewers) viewer.disconnect();
    await this.gateway.stop();
    this.push?.dispose();
    await this.service.shutdown();
    changeWhileDown?.();
    await this.startBackend();
    for (const viewer of this.viewers) await viewer.connect();
    await this.settle();
  }

  eventWriters(): Map<EventWriter, unknown> {
    return (this.gateway as unknown as { clients: Map<EventWriter, unknown> }).clients;
  }

  async addViewer(name: string, faults?: ViewerFaults): Promise<Viewer> {
    const viewer = new Viewer(name, this, faults);
    this.viewers.push(viewer);
    await viewer.mount();
    await this.settle();
    return viewer;
  }

  async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const response = await httpCall(this.info.url, "__orkestrator/invoke", {
      method: "POST",
      token: this.info.token,
      body: JSON.stringify({ command, args }),
    });
    if (response.status !== 200) throw new Error(`${command}: HTTP ${response.status}`);
    return (JSON.parse(response.body) as { result: T }).result;
  }

  readToolOutput(mode: ToolOutputReadMode, cursor?: number, anchor?: string) {
    return this.invoke<NativeAgentToolOutputRead>("get_native_agent_tool_output", {
      ...SESSION,
      toolUseId: TOOL_CALL_ID,
      messageId: this.bridge.toolMessageId(),
      mode,
      cursor,
      anchor,
      limit: 4_096,
    });
  }

  /** What the backend's one emit does: every client's stream, and the push layer. */
  emitBackendEvent(event: string, payload: unknown): void {
    this.gateway.emit(event, payload);
    this.push?.observeEvent(event, payload);
  }

  eventBytesWritten(): number {
    return this.gatewayMetrics().stream.sourceBytes;
  }

  hasPendingWork(): boolean {
    return (
      this.observerReads > 0 ||
      this.viewers.some((viewer) => viewer.inFlight > 0 || !viewer.streamDrained())
    );
  }

  /** Waits (in real time) until the I/O the last timer started has finished. */
  async settle(otherWorkPending: () => boolean = () => false): Promise<void> {
    let quiet = 0;
    const deadline = performance.now() + 30_000;
    while (quiet < 3) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.hasPendingWork() || otherWorkPending()) {
        quiet = 0;
        if (performance.now() > deadline) throw new Error("the stack did not settle");
        await new Promise((resolve) => setTimeout(resolve, 0));
      } else {
        quiet += 1;
      }
    }
  }

  async advance(ms: number): Promise<void> {
    await this.clock.advanceAsync(ms, () => this.settle());
  }

  async stop(): Promise<void> {
    for (const viewer of this.viewers.splice(0)) viewer.close();
    await this.gateway.stop().catch(() => undefined);
    this.push?.dispose();
    await this.service.shutdown();
    this.bridge.closeObserveStreams();
    await rm(this.dataDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The measured workload.

export interface PhaseResult {
  /** Virtual seconds the phase lasted. */
  seconds: number;
  viewers: Array<{
    name: string;
    reads: number;
    readsPerMinute: number;
    readsByReason: Record<string, number>;
    /** HTTP bytes of reads and set calls, both directions, plus event-stream bytes. */
    httpBytes: number;
    sseBytes: number;
    wireBytes: number;
    pushFrames: number;
    transcript: Record<string, number>;
  }>;
  bridgeCalls: number;
  bridgeRoutes: Record<string, number>;
  /** Bridge reads a minute, all viewers together. */
  bridgeCallsPerMinute: number;
}

export interface LatencySummary {
  samples: number;
  virtualP50: number;
  virtualP95: number;
  wallP50: number;
  wallP95: number;
  /** Virtual plus wall, per change: the observation latency this host would show. */
  totalP50: number;
  totalP95: number;
}

export interface ScenarioResult {
  mode: "before" | "after";
  viewers: number;
  /** Viewers ignored activity announcements: only push invalidated them. */
  pushOnly: boolean;
  bridge: BridgeSignalMode;
  quiet: PhaseResult;
  streaming: PhaseResult & { latency: LatencySummary };
  announced: PhaseResult & { latency: LatencySummary };
  /** Single unannounced transcript changes, spaced like the announced ones. */
  sparse: PhaseResult & { latency: LatencySummary };
  push: ReturnType<BackendPush["metrics"]> | null;
  client: PushClientDiagnostics[];
}

export interface ScenarioInput {
  mode: "before" | "after";
  viewers: number;
  quietMinutes: number;
  streamingSeconds: number;
  /** State-only changes, each announced by the backend, spaced `announcedEveryMs`. */
  announcedChanges: number;
  announcedEveryMs: number;
  /** Viewers ignore activity announcements (see {@link ViewerFaults.ignoreActivity}). */
  pushOnly?: boolean;
  /** How the bridge signals changes (default `cadence`). */
  bridge?: BridgeSignalMode;
}

export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const round = (value: number, digits = 1) => Number(value.toFixed(digits));

export function summarizeLatency(observations: readonly Observation[]): LatencySummary {
  const virtual = observations.map((o) => o.virtualMs);
  const wall = observations.map((o) => o.wallMs);
  const total = observations.map((o) => o.virtualMs + o.wallMs);
  return {
    samples: observations.length,
    virtualP50: round(percentile(virtual, 50)),
    virtualP95: round(percentile(virtual, 95)),
    wallP50: round(percentile(wall, 50)),
    wallP95: round(percentile(wall, 95)),
    totalP50: round(percentile(total, 50)),
    totalP95: round(percentile(total, 95)),
  };
}

function snapshotCounters(stack: AcceptanceStack) {
  return stack.viewers.map((viewer) => structuredClone(viewer.counters));
}

function phaseResult(
  stack: AcceptanceStack,
  before: ViewerCounters[],
  startedAt: number,
): PhaseResult {
  const seconds = (stack.clock.now() - startedAt) / 1_000;
  const minutes = seconds / 60;
  const bridgeCalls = stack.bridge.readCalls();
  return {
    seconds,
    viewers: stack.viewers.map((viewer, index) => {
      const start = before[index]!;
      const now = viewer.counters;
      const reads = now.reads - start.reads;
      const readsByReason: Record<string, number> = {};
      for (const [reason, count] of Object.entries(now.readsByReason)) {
        const delta = count - (start.readsByReason[reason] ?? 0);
        if (delta > 0) readsByReason[reason] = delta;
      }
      const transcript: Record<string, number> = {};
      for (const [status, count] of Object.entries(now.transcript)) {
        const delta = count - (start.transcript[status] ?? 0);
        if (delta > 0) transcript[status] = delta;
      }
      const httpBytes =
        now.readWireOut -
        start.readWireOut +
        (now.readWireIn - start.readWireIn) +
        (now.setWireOut - start.setWireOut) +
        (now.setWireIn - start.setWireIn);
      const sseBytes = now.sseBytes - start.sseBytes;
      return {
        name: viewer.name,
        reads,
        readsPerMinute: round(reads / minutes, 2),
        readsByReason,
        httpBytes,
        sseBytes,
        wireBytes: httpBytes + sseBytes,
        pushFrames: now.pushFrames - start.pushFrames,
        transcript,
      };
    }),
    bridgeCalls,
    bridgeRoutes: stack.bridge.routeCounts(),
    bridgeCallsPerMinute: round(bridgeCalls / minutes, 1),
  };
}

/** Align with the viewers' own rounds so a phase starts from a settled stack. */
async function beginPhase(stack: AcceptanceStack) {
  await stack.settle();
  stack.bridge.resetRoutes();
  for (const viewer of stack.viewers) viewer.observations.length = 0;
  return { counters: snapshotCounters(stack), startedAt: stack.clock.now() };
}

export async function runScenario(input: ScenarioInput): Promise<ScenarioResult> {
  const stack = await AcceptanceStack.start({
    push: input.mode === "after",
    bridge: input.bridge ?? "cadence",
  });
  try {
    stack.bridge.startTurn();
    for (let index = 0; index < input.viewers; index += 1) {
      await stack.addViewer(String.fromCharCode(97 + index), {
        ignoreActivity: input.pushOnly === true,
      });
      // Viewers mount 250 ms apart, as two windows would, not in lockstep.
      await stack.advance(250);
    }
    // Let mount answers and first frames settle into a steady state.
    await stack.advance(5_000);

    // 1. Quiet running turn: nothing in the session moves.
    let phase = await beginPhase(stack);
    await stack.advance(input.quietMinutes * 60_000);
    const quiet = phaseResult(stack, phase.counters, phase.startedAt);

    // 2. Streaming: the tail grows every 100 ms, a new response every 5 s.
    phase = await beginPhase(stack);
    stack.bridge.recording = true;
    const ticks = Math.round((input.streamingSeconds * 1_000) / 100);
    for (let tick = 0; tick < ticks; tick += 1) {
      stack.bridge.stream();
      await stack.advance(100);
    }
    stack.bridge.recording = false;
    // Allow the last change to be seen by every cadence.
    await stack.advance(1_000);
    const streamingPhase = phaseResult(stack, phase.counters, phase.startedAt);
    const streaming = {
      ...streamingPhase,
      latency: summarizeLatency(stack.viewers.flatMap((viewer) => viewer.observations)),
    };
    stack.bridge.changedAt.clear();

    // 3. Announced state changes: the backend's observer announces each one
    // (a question or approval parking the turn), at a random phase of the
    // cadences, as the activity announcement does today.
    phase = await beginPhase(stack);
    const announced: Observation[] = [];
    for (let index = 0; index < input.announcedChanges; index += 1) {
      // Spread the change across the 500 ms cadence: offset (index * 137) mod 500.
      await stack.advance(input.announcedEveryMs - ((index * 137) % 500));
      stack.bridge.moveState();
      const marker = 12_000 + stack.bridge.stateRevision;
      const changedAt = stack.clock.now();
      const startedWall = performance.now();
      const seen = new Map<Viewer, number>();
      stack.emitBackendEvent(NATIVE_AGENT_ACTIVITY_EVENT, {
        environment_id: SESSION.environmentId,
        agent: SESSION.agent,
        logical_session_key: SESSION.logicalSessionKey,
        state: "waiting",
        reason: "content",
      });
      // Let the announcement's own I/O run, then record when each viewer has it.
      const deadline = changedAt + 2_000;
      while (seen.size < stack.viewers.length && stack.clock.now() < deadline) {
        await stack.settle();
        for (const viewer of stack.viewers) {
          if (!seen.has(viewer) && viewer.stateMarker === marker) {
            seen.set(viewer, performance.now() - startedWall);
            announced.push({
              revision: stack.bridge.stateRevision,
              virtualMs: stack.clock.now() - changedAt,
              wallMs: performance.now() - startedWall,
            });
          }
        }
        if (seen.size < stack.viewers.length) await stack.advance(10);
      }
    }
    await stack.advance(1_000);
    const announcedPhase = phaseResult(stack, phase.counters, phase.startedAt);

    // 4. Sparse unannounced changes: one streamed delta at a time, no backend
    // announcement, spaced like the announced ones. What a revisions-capable
    // bridge's hint alone delivers, against the observer's cadence without it.
    phase = await beginPhase(stack);
    stack.bridge.recording = true;
    for (let index = 0; index < input.announcedChanges; index += 1) {
      await stack.advance(input.announcedEveryMs - ((index * 137) % 500));
      stack.bridge.stream();
    }
    await stack.advance(1_000);
    stack.bridge.recording = false;
    const sparsePhase = phaseResult(stack, phase.counters, phase.startedAt);
    const sparse = {
      ...sparsePhase,
      latency: summarizeLatency(stack.viewers.flatMap((viewer) => viewer.observations)),
    };
    stack.bridge.changedAt.clear();

    return {
      mode: input.mode,
      viewers: input.viewers,
      pushOnly: input.pushOnly === true,
      bridge: input.bridge ?? "cadence",
      quiet,
      streaming,
      announced: { ...announcedPhase, latency: summarizeLatency(announced) },
      sparse,
      push: stack.push?.metrics() ?? null,
      client: stack.viewers.map((viewer) => viewer.diagnostics()),
    };
  } finally {
    await stack.stop();
  }
}

export const DEFAULT_SCENARIO = {
  quietMinutes: 10,
  streamingSeconds: 20,
  announcedChanges: 20,
  announcedEveryMs: 3_000,
} as const;

/** The table the runner prints and the doc records. */
export function formatTable(results: readonly ScenarioResult[]): string {
  const lines: string[] = [];
  const row = (cells: Array<string | number>) => lines.push(`| ${cells.join(" | ")} |`);
  row([
    "Mode",
    "Viewers",
    "Phase",
    "Reads/min per viewer",
    "Wire B/min per viewer (HTTP + SSE)",
    "Bridge calls/min (all viewers)",
    "Bridge routes",
    "Latency p50 / p95 ms (virtual + wall)",
  ]);
  row(["---", "---", "---", "---", "---", "---", "---", "---"]);
  for (const result of results) {
    for (const [name, phase] of [
      ["quiet", result.quiet],
      ["streaming", result.streaming],
      ["announced", result.announced],
      ["sparse unannounced", result.sparse],
    ] as const) {
      const minutes = phase.seconds / 60;
      const perViewer = phase.viewers.map((v) => v.readsPerMinute).join(" / ");
      const bytes = phase.viewers
        .map((v) => `${Math.round(v.httpBytes / minutes)} + ${Math.round(v.sseBytes / minutes)}`)
        .join(" / ");
      const routes = Object.entries(phase.bridgeRoutes)
        .filter(([route]) => !route.includes("/event/subscribe"))
        .map(([route, count]) => `${route.replace("GET /session/:id", "") || "state"} ${count}`)
        .join(", ");
      const latency =
        "latency" in phase && phase.latency.samples > 0
          ? `${phase.latency.totalP50} / ${phase.latency.totalP95} (n=${phase.latency.samples})`
          : "–";
      row([
        `${result.mode === "after" ? `push, ${result.bridge} bridge` : "before"}${result.pushOnly ? " (push only)" : ""}`,
        result.viewers,
        `${name} (${round(phase.seconds, 0)} s)`,
        perViewer,
        bytes,
        phase.bridgeCallsPerMinute,
        routes,
        latency,
      ]);
    }
  }
  return lines.join("\n");
}
