/**
 * Terminal input results (GW-16) in real browser engines, on each route an agent
 * can reach (to-do 5080 task 3, retired; the results are in
 * docs/architecture/remote-gateway.md):
 *
 *   mise exec -- bun apps/backend/scripts/terminal-input-results-probe.ts \
 *     [--engines webkit,chromium] [--latency-ms 40] [--out result.json]
 *
 * Starts, in this process, a leaf gateway in front of a fake terminal backend
 * that echoes every write, a command gateway that relays
 * `/__orkestrator/nodes/<leaf>/…` to it, and a TCP proxy in front of the leaf
 * that delays every chunk by `--latency-ms` in each direction. All listen on
 * ephemeral 127.0.0.1 ports; tokens and browser sessions are random and never
 * printed. The page bundles the renderer's real terminal client
 * (`terminal-input-results-probe-page.ts`), and Playwright types into it: keys
 * 25 ms apart, then keys with no delay, then a reload and a few more keys.
 *
 * Routes: `direct` (the leaf), `relay` (the command node's relay to the leaf)
 * and `latency` (the leaf behind the delaying proxy), each with both
 * subprotocols offered and with only v1 offered, as an older renderer does.
 * Per run it reports the negotiated subprotocol, input and result frame counts,
 * result bytes, failures, refusals, socket closes, fallbacks, key-to-result
 * latency, whether the backend received and echoed exactly what was typed, and
 * whether input works after a reload. Never content. An engine that cannot
 * launch is reported as `unavailable`. It never touches a real data directory,
 * backend, terminal or provider. JSON goes to stdout (or `--out`).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { CONTROLLER_HEADER } from "@orkestrator/protocol/command-nodes";
import { configureLogger } from "@orkestrator/protocol/logger";
import { TERMINAL_WEBSOCKET_PATH } from "@orkestrator/protocol/terminal-websocket";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright-core";

import type { BackendHelloIdentity } from "../src/gateway.js";
import { startGateway, type StartedGateway } from "./gateway-frame-costs.js";
import type { ProbePageCounts, ProbePageStart } from "./terminal-input-results-probe-page.ts";

const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox };
const SESSION = "input-results-probe";
const LEAF_NODE = "bk_leaf";
/** The same counts as the Chromium run in 1202 task 11: 52 typed keys, 316 with no delay. */
const TYPED_KEYS = 52;
const BURST_KEYS = 316;
const RELOAD_KEYS = 12;
const TYPING_DELAY_MS = 25;
const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const identity: BackendHelloIdentity = {
  installationId: "bk_leaf-probe",
  generation: "generation-1",
  appVersion: "0.0.0-probe",
  profile: {
    revision: 1,
    displayName: "Leaf",
    colorToken: "teal",
    updatedAt: "2026-11-13T00:00:00.000Z",
  },
  nodeMode: "leaf",
};

export type Route = "direct" | "relay" | "latency";

export type PhaseResult = {
  keys: number;
  inputFrames: number;
  resultFrames: number;
  cumulativeResultFrames: number;
  perInputResultFrames: number;
  resultBytes: number;
  failed: number;
  refused: number;
  medianMs: number;
  p95Ms: number;
};

export type RunResult = {
  route: Route;
  offer: "both" | "v1-only";
  protocol: string;
  typing: PhaseResult;
  noDelay: PhaseResult;
  socketCloses: number;
  fallbackRequired: number;
  /** The backend received every key once, in order. */
  writesIntact: boolean;
  /** The terminal output the page received equals what was typed. */
  echoIntact: boolean;
  /** A reloaded page subscribes again and its keys arrive intact. */
  inputAfterReload: boolean;
};

export type EngineResult =
  | { engine: string; status: "unavailable"; reason: string }
  | { engine: string; status: "observed"; version: string; runs: RunResult[] };

/** Typing text of `count` keys; the same for every run, never reported. */
export function keysFor(count: number, offset = 0): string {
  let text = "";
  for (let index = 0; index < count; index += 1) {
    text += KEY_ALPHABET[(index + offset) % KEY_ALPHABET.length];
  }
  return text;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** What happened between two snapshots of the page's counters. */
export function phaseBetween(before: ProbePageCounts, after: ProbePageCounts): PhaseResult {
  const latencies = after.latencies.slice(before.latencies.length);
  const cumulative = after.cumulativeResultFrames - before.cumulativeResultFrames;
  const perInput = after.perInputResultFrames - before.perInputResultFrames;
  return {
    keys: after.keys - before.keys,
    inputFrames: after.inputFrames - before.inputFrames,
    resultFrames: cumulative + perInput,
    cumulativeResultFrames: cumulative,
    perInputResultFrames: perInput,
    resultBytes: after.resultBytes - before.resultBytes,
    failed: after.failed - before.failed,
    refused: after.refused - before.refused,
    medianMs: round(percentile(latencies, 0.5)),
    p95Ms: round(percentile(latencies, 0.95)),
  };
}

/** The leaf: a fake terminal backend that records and echoes every write. */
async function startLeaf(rendererRoot: string) {
  const writes: string[] = [];
  let revision = 0;
  let leaf: StartedGateway | undefined;
  leaf = await startGateway(
    {
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === "get_terminal_session") return { id: args.sessionId, running: true };
        if (command === "get_terminal_output_snapshot") {
          return { output: "", generation: 1, revision: 0 };
        }
        if (command === "terminal_write") {
          const data = String(args.data);
          writes.push(data);
          revision += 1;
          leaf?.gateway.emit(`terminal-output-${String(args.sessionId)}`, {
            text: data,
            generation: 1,
            revision,
          });
          return { delivered: true };
        }
        return null;
      },
    },
    { rendererRoot, backendHello: async () => identity },
  );
  return {
    leaf,
    writes,
    reset: () => {
      writes.length = 0;
      revision = 0;
    },
  };
}

/** A command node whose relay reaches the leaf. */
function startCommand(rendererRoot: string, leaf: StartedGateway) {
  return startGateway(
    { invoke: async () => null },
    {
      rendererRoot,
      backendHello: async () => ({ ...identity, installationId: "bk_command-probe" }),
      nodeHooks: {
        isPortalOriginAllowed: () => false,
        noteControllerContact: () => undefined,
        relayTarget: () => ({
          baseUrl: leaf.url.href,
          headers: { authorization: `Bearer ${leaf.token}`, [CONTROLLER_HEADER]: "bk_command" },
        }),
      },
    },
  );
}

/**
 * A TCP proxy that delays every chunk by `delayMs` in each direction, in order.
 * Equal delays keep order: timers of one duration fire first in, first out.
 */
async function startLatencyProxy(target: URL, delayMs: number) {
  const sockets = new Set<Socket>();
  const pipeDelayed = (from: Socket, to: Socket) => {
    from.on("data", (chunk) => {
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, delayMs);
    });
    from.on("end", () => setTimeout(() => to.end(), delayMs));
    from.on("error", () => to.destroy());
  };
  const server: Server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(client).add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    pipeDelayed(client, upstream);
    pipeDelayed(upstream, client);
    const forget = () => {
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("close", forget);
    upstream.on("close", forget);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy has no address");
  return {
    url: new URL(`http://127.0.0.1:${address.port}/`),
    stop: async () => {
      for (const socket of Array.from(sockets)) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function writeRendererRoot(dir: string): Promise<string> {
  const root = path.join(dir, "dist");
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "terminal-input-results-probe-page.ts")],
    target: "browser",
    outdir: root,
    naming: "probe.js",
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  await writeFile(
    path.join(root, "index.html"),
    '<!doctype html><html><head><script type="module" src="/probe.js"></script></head>' +
      "<body></body></html>",
  );
  return root;
}

type Targets = {
  writes: string[];
  resetWrites(): void;
  route(route: Route): { page: URL; gateway: StartedGateway; path: string };
};

async function startPage(page: Page, base: URL, start: ProbePageStart) {
  await page.goto(base.href, { waitUntil: "load" });
  await page.waitForFunction(() => "__terminalProbe" in window);
  await page.evaluate(
    (options) =>
      (
        window as unknown as { __terminalProbe: { start(o: unknown): Promise<void> } }
      ).__terminalProbe.start(options),
    start,
  );
}

const drain = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __terminalProbe: { drain(): Promise<ProbePageCounts> } }
    ).__terminalProbe.drain(),
  );

const echoed = (page: Page, expected: string) =>
  page.evaluate(
    (text) =>
      (
        window as unknown as { __terminalProbe: { echoed(t: string): Promise<boolean> } }
      ).__terminalProbe.echoed(text),
    expected,
  );

async function run(
  type: BrowserType,
  targets: Targets,
  route: Route,
  offer: RunResult["offer"],
): Promise<RunResult> {
  const browser = await type.launch();
  try {
    const { page: base, gateway, path: socketPath } = targets.route(route);
    const context = await browser.newContext();
    const session = (
      gateway.gateway as unknown as { issueBrowserSession(): string }
    ).issueBrowserSession();
    await context.addCookies([
      { name: "orkestrator_gateway_auth", value: session, url: base.origin },
    ]);
    const page = await context.newPage();
    const start: ProbePageStart = {
      path: socketPath,
      sessionId: SESSION,
      v1Only: offer === "v1-only",
    };
    targets.resetWrites();
    await startPage(page, base, start);

    const typed = keysFor(TYPED_KEYS);
    const burst = keysFor(BURST_KEYS, TYPED_KEYS);
    const initial = await drain(page);
    await page.keyboard.type(typed, { delay: TYPING_DELAY_MS });
    const afterTyping = await drain(page);
    await page.keyboard.type(burst, { delay: 0 });
    const afterBurst = await drain(page);
    const writesIntact = targets.writes.join("") === typed + burst;
    const echoIntact = await echoed(page, typed + burst);

    targets.resetWrites();
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => "__terminalProbe" in window);
    await page.evaluate(
      (options) =>
        (
          window as unknown as { __terminalProbe: { start(o: unknown): Promise<void> } }
        ).__terminalProbe.start(options),
      start,
    );
    const reloadKeys = keysFor(RELOAD_KEYS, 7);
    await page.keyboard.type(reloadKeys, { delay: TYPING_DELAY_MS });
    const afterReload = await drain(page);
    const inputAfterReload =
      afterReload.settled === RELOAD_KEYS &&
      afterReload.failed === 0 &&
      targets.writes.join("") === reloadKeys &&
      (await echoed(page, reloadKeys));
    await context.close();
    return {
      route,
      offer,
      protocol: afterBurst.protocol,
      typing: phaseBetween(initial, afterTyping),
      noDelay: phaseBetween(afterTyping, afterBurst),
      socketCloses: afterBurst.socketCloses,
      fallbackRequired: afterBurst.fallbackRequired,
      writesIntact,
      echoIntact,
      inputAfterReload,
    };
  } finally {
    await browser.close();
  }
}

async function probeEngine(
  name: string,
  type: BrowserType,
  targets: Targets,
): Promise<EngineResult> {
  let version: string;
  try {
    const browser = await type.launch();
    version = browser.version();
    await browser.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      message
        .split("\n")
        .map((line) => line.replace(/[║╔╗╚╝═]/g, "").trim())
        .find((line) => line.length > 0 && !line.startsWith("_wrapApiCall")) ?? "launch failed";
    return { engine: name, status: "unavailable", reason };
  }
  const runs: RunResult[] = [];
  for (const route of ["direct", "relay", "latency"] as const) {
    for (const offer of ["both", "v1-only"] as const) {
      runs.push(await run(type, targets, route, offer));
    }
  }
  return { engine: name, status: "observed", version, runs };
}

async function main(): Promise<void> {
  configureLogger({ level: "error" });
  const { values } = parseArgs({
    options: {
      engines: { type: "string", default: "webkit,chromium" },
      "latency-ms": { type: "string", default: "40" },
      out: { type: "string" },
    },
  });
  const names = String(values.engines)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!ENGINES[name]) throw new Error(`Unknown engine: ${name}`);
  }
  const latencyMs = Number(values["latency-ms"]);
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error("--latency-ms must be >= 0");

  const dir = await mkdtemp(path.join(os.tmpdir(), "ork-terminal-input-results-probe-"));
  const stops: Array<() => Promise<void>> = [];
  try {
    const rendererRoot = await writeRendererRoot(dir);
    const { leaf, writes, reset } = await startLeaf(rendererRoot);
    stops.push(leaf.stop);
    const command = await startCommand(rendererRoot, leaf);
    stops.push(command.stop);
    const proxy = await startLatencyProxy(leaf.url, latencyMs);
    stops.push(proxy.stop);
    const targets: Targets = {
      writes,
      resetWrites: reset,
      route: (route) => {
        if (route === "relay") {
          return {
            page: command.url,
            gateway: command,
            path: `/__orkestrator/nodes/${LEAF_NODE}${TERMINAL_WEBSOCKET_PATH}`,
          };
        }
        return {
          page: route === "latency" ? proxy.url : leaf.url,
          gateway: leaf,
          path: TERMINAL_WEBSOCKET_PATH,
        };
      },
    };
    const results: EngineResult[] = [];
    for (const name of names) results.push(await probeEngine(name, ENGINES[name]!, targets));
    const output = JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        platform: `${process.platform}-${process.arch}`,
        latencyMsEachWay: latencyMs,
        loadAverage: os.loadavg().map(round),
        results,
      },
      null,
      2,
    );
    if (values.out) await writeFile(values.out, `${output}\n`);
    else console.log(output);
  } finally {
    for (const stop of stops.reverse()) await stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
