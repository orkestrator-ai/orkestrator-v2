/**
 * The browser half of `terminal-input-results-probe.ts`, bundled for the page
 * by that script. It runs the renderer's real terminal client in the engine
 * under test and turns key presses in a text box into terminal input, as the
 * terminal view does. It counts frames and settles, and keeps the echoed text
 * only to compare it with what was typed; the comparison, never the text,
 * leaves the page.
 */
import { TERMINAL_WEBSOCKET_SUBPROTOCOL } from "@orkestrator/protocol/terminal-websocket";

import { TerminalWebSocketClient } from "../../web/src/lib/native/terminal-websocket-client.ts";
import {
  CHANNEL_STARTUP_TIMEOUT_MS,
  startChannel,
} from "./terminal-input-results-probe-startup.ts";

export type ProbePageStart = {
  /** The terminal endpoint's path on the page's own origin. */
  path: string;
  sessionId: string;
  /** Offer only v1, as a renderer from before input results does. */
  v1Only: boolean;
  /** Fail startup when the channel is not ready by then (`CHANNEL_STARTUP_TIMEOUT_MS`). */
  startupTimeoutMs?: number;
};

export type ProbePageCounts = {
  protocol: string;
  /** Key presses the page turned into input. */
  keys: number;
  /** Binary input frames the client sent. */
  inputFrames: number;
  /** `input-results` frames received. */
  cumulativeResultFrames: number;
  /** `operation-result` frames for an input received. */
  perInputResultFrames: number;
  resultBytes: number;
  settled: number;
  failed: number;
  /** Input the client refused to send on the socket (the HTTP path would carry it). */
  refused: number;
  socketCloses: number;
  fallbackRequired: number;
  /** Key press to settled result, in milliseconds. */
  latencies: number[];
};

type ProbeWindow = Window & {
  __terminalProbe?: {
    start(options: ProbePageStart): Promise<void>;
    drain(): Promise<ProbePageCounts>;
    /** Whether the echoed output equals `expected`; the text stays in the page. */
    echoed(expected: string): Promise<boolean>;
  };
};

const counts: ProbePageCounts = {
  protocol: "",
  keys: 0,
  inputFrames: 0,
  cumulativeResultFrames: 0,
  perInputResultFrames: 0,
  resultBytes: 0,
  settled: 0,
  failed: 0,
  refused: 0,
  socketCloses: 0,
  fallbackRequired: 0,
  latencies: [],
};
const pending = new Set<Promise<void>>();
const decoder = new TextDecoder();
let output = "";

function countFrame(data: unknown): void {
  if (typeof data !== "string") return;
  let frame: { type?: string; operation?: string };
  try {
    frame = JSON.parse(data) as typeof frame;
  } catch {
    return;
  }
  if (frame.type === "input-results") counts.cumulativeResultFrames += 1;
  else if (frame.type === "operation-result" && frame.operation === "input") {
    counts.perInputResultFrames += 1;
  } else return;
  counts.resultBytes += new TextEncoder().encode(data).byteLength;
}

async function start(options: ProbePageStart): Promise<void> {
  const url = `${location.origin.replace(/^http/, "ws")}${options.path}`;
  let resolveReady = () => {};
  const channelReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const client = new TerminalWebSocketClient({
    url,
    createSocket: (socketUrl, protocols) => {
      const offered = options.v1Only ? [TERMINAL_WEBSOCKET_SUBPROTOCOL] : protocols;
      const socket = new WebSocket(socketUrl, offered);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data !== "string") counts.inputFrames += 1;
        send(data);
      };
      socket.addEventListener("open", () => {
        counts.protocol = socket.protocol;
      });
      socket.addEventListener("message", (message) => countFrame(message.data));
      socket.addEventListener("close", () => {
        counts.socketCloses += 1;
      });
      return socket;
    },
    onFallbackRequired: () => {
      counts.fallbackRequired += 1;
    },
    onSocketReady: () => undefined,
    onChannelReady: () => resolveReady(),
  });
  client.subscribe(options.sessionId, (payload) => {
    if (payload.bytes) output += decoder.decode(payload.bytes, { stream: true });
  });
  // Rejects (and disposes the client) when the upgrade or the subscription
  // never succeeds, so the probe reports this route failed and moves on.
  await startChannel(client, options.sessionId, channelReady, {
    timeoutMs: options.startupTimeoutMs ?? CHANNEL_STARTUP_TIMEOUT_MS,
    diagnostics: () => ({
      socketCloses: counts.socketCloses,
      fallbackRequired: counts.fallbackRequired,
    }),
  });

  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Terminal input");
  input.addEventListener("keydown", (event) => {
    if (event.key.length !== 1) return;
    event.preventDefault();
    counts.keys += 1;
    const pressedAt = performance.now();
    const completion = client.enqueueInput(options.sessionId, event.key);
    if (!completion) {
      counts.refused += 1;
      return;
    }
    const settled = completion.then(
      () => {
        counts.settled += 1;
        counts.latencies.push(performance.now() - pressedAt);
      },
      () => {
        counts.failed += 1;
      },
    );
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  });
  document.body.append(input);
  input.focus();
}

async function drain(): Promise<ProbePageCounts> {
  while (pending.size > 0) await Promise.allSettled(Array.from(pending));
  return { ...counts, latencies: [...counts.latencies] };
}

async function echoed(expected: string): Promise<boolean> {
  const deadline = performance.now() + 5_000;
  while (output.length < expected.length && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return output === expected;
}

(window as ProbeWindow).__terminalProbe = { start, drain, echoed };
