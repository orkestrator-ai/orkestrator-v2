import { afterEach, describe, expect, mock, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LOCAL_CONNECTION_ID } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  RELAYED_NODE_EVENT,
  relayedNodeEventName,
  type RelayedNodeEvent,
} from "@orkestrator/protocol/node-events";

import { BackendHttpClient } from "../../desktop/electron/backend-process";
import { ConnectionManager } from "../../desktop/electron/connection-manager";
import {
  DesktopWindowContexts,
  type DesktopWindowContextRecord,
} from "../../desktop/electron/desktop-window-contexts";
import { registerFederationIpc } from "../../desktop/electron/federation-ipc";
import {
  createOrkestratorElectronApi,
  type IpcRendererLike,
} from "../../desktop/electron/preload-api";
import { compatibilityPathUsage } from "../src/core/compatibility-path-usage";
import type { OrkestratorGateway } from "../src/gateway";
import {
  eventClients,
  readGatewayMetrics,
  startGateway,
  waitUntil,
} from "./gateway-test-harness.js";

/**
 * The desktop's relay end to end: the real preload API, IPC handlers, window
 * bookkeeping, connection manager and backend client, against a real gateway.
 * Only Electron's own IPC pipe and web contents are stand-ins.
 */

const LEAF = "bk_leaf" as BackendId;
const OTHER = "bk_other" as BackendId;
const LEAF_EVENT = relayedNodeEventName(LEAF);
const OTHER_EVENT = relayedNodeEventName(OTHER);
const TRUSTED_RENDERER_URL = "http://127.0.0.1:1420";

type StreamState = {
  relayedEvents?: string | null;
  relayedStream?: boolean;
  includedPrefixes: string[] | null;
};

function streams(gateway: OrkestratorGateway): StreamState[] {
  return [...eventClients(gateway).values()] as StreamState[];
}

function mainStreams(gateway: OrkestratorGateway): StreamState[] {
  return streams(gateway).filter((state) => !state.relayedStream);
}

/** What each of main's filtered streams carries; a healthy desktop has at most one. */
function relayedFilters(gateway: OrkestratorGateway): string[][] {
  return streams(gateway)
    .filter((state) => state.relayedStream)
    .map((state) => state.includedPrefixes ?? []);
}

function waitForFilter(gateway: OrkestratorGateway, events: string[], message: string) {
  const wanted = JSON.stringify(events.length > 0 ? [events] : []);
  return waitUntil(() => JSON.stringify(relayedFilters(gateway)) === wanted, message);
}

function relayedEvent(nodeId: BackendId, id: string): RelayedNodeEvent {
  return { nodeId, kind: "event", event: "resource-changed", payload: { id } };
}

function emitRelayed(gateway: OrkestratorGateway, nodeId: BackendId, id: string): void {
  gateway.emit(relayedNodeEventName(nodeId), relayedEvent(nodeId, id));
}

async function relayedFramesWritten(info: { url: string; token: string }): Promise<number> {
  const metrics = (await readGatewayMetrics(info)) as unknown as {
    events: Record<string, { frames: number } | undefined>;
  };
  return metrics.events[RELAYED_NODE_EVENT]?.frames ?? 0;
}

function eventIds(frames: readonly unknown[]): string[] {
  return (frames as RelayedNodeEvent[]).flatMap((frame) =>
    frame.kind === "event" ? [(frame.payload as { id: string }).id] : [],
  );
}

function resyncs(frames: readonly unknown[]): unknown[] {
  return (frames as RelayedNodeEvent[]).filter((frame) => frame.kind === "resync");
}

/** A real gateway over a backend that answers what the connection manager reads. */
function startBackend(options: Parameters<typeof startGateway>[0] = {}) {
  return startGateway({
    backend: {
      invoke: mock(async (command: string) =>
        command === "get_desktop_connections"
          ? { activeConnectionId: LOCAL_CONNECTION_ID, connections: [] }
          : null,
      ),
    },
    ...options,
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One desktop main process on a backend at `url`, with the windows it serves. */
async function startDesktop(
  info: { url: string; token: string },
  options: { reconnectDelayMs?: number } = {},
) {
  const client = new BackendHttpClient(info.url, info.token, {
    eventReconnectDelayMs: options.reconnectDelayMs ?? 5,
  });
  const manager = new ConnectionManager({
    localBackend: client,
    secureStorage: {
      isAsyncEncryptionAvailable: async () => false,
      encryptStringAsync: async (value: string) => Buffer.from(value),
      decryptStringAsync: async (value: Buffer) => ({
        result: value.toString(),
        shouldReEncrypt: false,
      }),
    },
    onEvent: () => undefined,
    onConnectionEvent: (connectionId, event, payload) =>
      windows.relayBackendEvent(connectionId, event, payload),
  });
  const windows: DesktopWindowContexts<DesktopWindowContextRecord> = new DesktopWindowContexts({
    connections: () => manager,
    createPreviews: () => {
      throw new Error("not used");
    },
    cancelPrompts: () => undefined,
    releaseWorkspaceGrant: () => undefined,
    releaseSlot: () => undefined,
    setConnectionTitle: () => undefined,
    publishConnectionLists: () => undefined,
    menuChanged: () => undefined,
    logger: { warn: () => undefined },
  });
  await manager.initialize();
  client.listen((event, payload) => manager.handleLocalEvent(event, payload));
  cleanups.push(() => client.stopListening());

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const notifications = new Map<string, (event: never, ...args: unknown[]) => void>();
  registerFederationIpc({
    ipc: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
        void handlers.set(channel, listener),
      on: (channel: string, listener: (event: never, ...args: unknown[]) => void) =>
        void notifications.set(channel, listener),
    },
    trustedRendererUrl: TRUSTED_RENDERER_URL,
    addRelayedListen: (event: never, name: unknown) => windows.addRelayedListen(event, name),
    removeRelayedListen: (event: never, name: unknown) => windows.removeRelayedListen(event, name),
    resetRelayedListens: (event: never) => windows.resetRelayedListens(event),
  } as never);

  let nextRendererId = 1;
  /** A renderer's end of Electron's IPC, delivering in order on one pipe. */
  function rendererIpc(id: number) {
    const onRenderer = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
    const sender = { sender: { id }, senderFrame: { url: `${TRUSTED_RENDERER_URL}/` } };
    const ipc: IpcRendererLike = {
      invoke: async <T = unknown>(channel: string, ...args: unknown[]) =>
        handlers.get(channel)?.(sender, ...args) as T,
      send: (channel, ...args) => notifications.get(channel)?.(sender as never, ...args),
      on: (channel, listener) => {
        onRenderer.set(channel, [...(onRenderer.get(channel) ?? []), listener]);
      },
    };
    const contents = {
      id,
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        for (const listener of onRenderer.get(channel) ?? []) listener({}, ...args);
      },
    };
    return { ipc, contents };
  }

  async function record(id: number, scope: string, extra = {}) {
    await manager.bind(scope, LOCAL_CONNECTION_ID);
    return {
      window: { isDestroyed: () => false },
      scope,
      slot: id,
      previewConnectionId: LOCAL_CONNECTION_ID,
      browserPreviewManager: { destroyAll: () => undefined },
      previewTransport: { disposeAll: async () => undefined },
      artifactHosts: { dispose: () => undefined },
      ...extra,
    };
  }

  return {
    client,
    windows,
    /** A window on Local that takes events from main (`localWindowGatewayTransport` off). */
    async openRelayWindow() {
      const id = nextRendererId++;
      const { ipc, contents } = rendererIpc(id);
      const close = windows.register({
        ...(await record(id, `window-${id}`)),
        contents,
      } as never);
      return { id, api: createOrkestratorElectronApi(ipc), ipc, close };
    },
    /** A window on Local with `localWindowGatewayTransport` on. */
    async openGatewayWindow() {
      const id = nextRendererId++;
      const { ipc, contents } = rendererIpc(id);
      windows.register({
        ...(await record(id, `window-${id}`, { localGatewayTransport: true })),
        contents,
      } as never);
      return { id, api: createOrkestratorElectronApi(ipc) };
    },
  };
}

type Listening = {
  listen<T = unknown>(event: string, callback: (payload: T) => void): () => void;
  eventStreamReady(event: string): Promise<void>;
};

/** What a renderer does: listen, then wait for the stream that carries the event. */
async function watch(api: Listening, event: string) {
  const frames: unknown[] = [];
  const stop = api.listen(event, (payload) => void frames.push(payload));
  await api.eventStreamReady(event);
  return { frames, stop };
}

describe("what the desktop's main process takes from a real gateway", () => {
  test("no relayed event at all while no window listens to one", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const window = await desktop.openRelayWindow();
    const authoritative: unknown[] = [];
    window.api.listen("environment-renamed", (payload) => void authoritative.push(payload));
    const oldName: unknown[] = [];
    window.api.listen(RELAYED_NODE_EVENT, (payload) => void oldName.push(payload));
    await waitUntil(() => mainStreams(gateway).length === 1, "Main's stream never opened");
    const legacyBefore = compatibilityPathUsage.snapshot().paths;

    emitRelayed(gateway, LEAF, "nobody-watches");
    gateway.emit("environment-renamed", { id: "authoritative" });
    await waitUntil(() => authoritative.length === 1, "Main's stream stalled");

    expect(mainStreams(gateway)[0]?.relayedEvents).toBe("per-node");
    expect(relayedFilters(gateway)).toEqual([]);
    expect(oldName).toEqual([]);
    expect(await relayedFramesWritten(info)).toBe(0);
    expect(compatibilityPathUsage.snapshot().paths["relayed-node-event.legacy-stream"]).toEqual(
      legacyBefore["relayed-node-event.legacy-stream"],
    );
    expect(
      compatibilityPathUsage.snapshot().paths["relayed-node-event.legacy-desktop-stream"],
    ).toEqual(legacyBefore["relayed-node-event.legacy-desktop-stream"]);
  });

  test("only the per-node events a window listens to, and only to that window", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const watching = await desktop.openRelayWindow();
    const idle = await desktop.openRelayWindow();
    const leaf = await watch(watching.api, LEAF_EVENT);
    const idleFrames: unknown[] = [];
    idle.api.listen(RELAYED_NODE_EVENT, (payload) => void idleFrames.push(payload));
    await waitForFilter(gateway, [LEAF_EVENT], "The filter never named the watched node");

    emitRelayed(gateway, LEAF, "one");
    emitRelayed(gateway, OTHER, "unwatched");
    emitRelayed(gateway, LEAF, "two");
    await waitUntil(() => eventIds(leaf.frames).length === 2, "A watched frame never arrived");

    expect(eventIds(leaf.frames)).toEqual(["one", "two"]);
    expect(idleFrames).toEqual([]);
    // The gateway wrote main two frames: the unwatched node's bytes never left it.
    expect(await relayedFramesWritten(info)).toBe(2);
  });

  test("a fresh stream tells each listener to read", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const window = await desktop.openRelayWindow();
    const leaf = await watch(window.api, LEAF_EVENT);
    await waitUntil(() => resyncs(leaf.frames).length === 1, "A fresh stream never announced");
    expect(resyncs(leaf.frames)).toEqual([{ nodeId: LEAF, kind: "resync" }]);
    expect(relayedFilters(gateway)).toEqual([[LEAF_EVENT]]);
  });
});

describe("a window starting and stopping a listen", () => {
  test("widens and narrows main's one filter from its cursor, losing nothing", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const window = await desktop.openRelayWindow();
    const leaf = await watch(window.api, LEAF_EVENT);
    await waitForFilter(gateway, [LEAF_EVENT], "The first listen did not open the stream");
    emitRelayed(gateway, LEAF, "first");
    await waitUntil(() => eventIds(leaf.frames).length === 1, "First frame never arrived");

    const other = window.api.listen(OTHER_EVENT, () => undefined);
    // During the swap: the old stream is closing and the new one not yet open.
    emitRelayed(gateway, LEAF, "during-the-swap");
    await window.api.eventStreamReady(OTHER_EVENT);
    await waitForFilter(
      gateway,
      [LEAF_EVENT, OTHER_EVENT].sort(),
      "A second listen did not widen the filter",
    );
    emitRelayed(gateway, LEAF, "after-the-swap");
    await waitUntil(() => eventIds(leaf.frames).length === 3, "A frame was lost across the swap");
    expect(eventIds(leaf.frames)).toEqual(["first", "during-the-swap", "after-the-swap"]);
    // Resumed, so nothing is told to read again.
    expect(resyncs(leaf.frames)).toHaveLength(1);

    other();
    await waitForFilter(gateway, [LEAF_EVENT], "Stopping a listen did not narrow the filter");
    expect(mainStreams(gateway)).toHaveLength(1);

    leaf.stop();
    await waitForFilter(gateway, [], "Stopping the last listen did not close the stream");
    expect(mainStreams(gateway)).toHaveLength(1);
  });

  test("two callbacks on one event are one listen until the last one stops", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const window = await desktop.openRelayWindow();
    const first = await watch(window.api, LEAF_EVENT);
    const second = await watch(window.api, LEAF_EVENT);
    await waitForFilter(gateway, [LEAF_EVENT], "The stream never opened");

    first.stop();
    emitRelayed(gateway, LEAF, "still-wanted");
    await waitUntil(() => eventIds(second.frames).length === 1, "The other callback lost out");
    expect(relayedFilters(gateway)).toEqual([[LEAF_EVENT]]);

    second.stop();
    await waitForFilter(gateway, [], "The last callback leaving did not stop the listen");
  });

  test("windows share the filter: one leaving keeps what the other listens to", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const first = await desktop.openRelayWindow();
    const second = await desktop.openRelayWindow();
    const firstLeaf = await watch(first.api, LEAF_EVENT);
    const secondLeaf = await watch(second.api, LEAF_EVENT);
    await waitForFilter(gateway, [LEAF_EVENT], "The stream never opened");

    firstLeaf.stop();
    emitRelayed(gateway, LEAF, "for-the-second");
    await waitUntil(() => eventIds(secondLeaf.frames).length === 1, "The other window lost out");
    expect(eventIds(firstLeaf.frames)).toEqual([]);
    expect(relayedFilters(gateway)).toEqual([[LEAF_EVENT]]);
  });
});

describe("a renderer going away", () => {
  test("a closed window's listens are dropped, leaving the other window's", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const closing = await desktop.openRelayWindow();
    const staying = await desktop.openRelayWindow();
    await watch(closing.api, OTHER_EVENT);
    await watch(staying.api, LEAF_EVENT);
    await waitForFilter(gateway, [LEAF_EVENT, OTHER_EVENT].sort(), "The filter never widened");

    closing.close();
    await waitForFilter(gateway, [LEAF_EVENT], "A closed window's listen outlived it");

    staying.close();
    await waitForFilter(gateway, [], "The last window closing did not close the stream");
  });

  test("a reloaded window's previous document no longer counts", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const window = await desktop.openRelayWindow();
    await watch(window.api, OTHER_EVENT);
    await waitForFilter(gateway, [OTHER_EVENT], "The stream never opened");

    // What a reload does: the preload runs again against the same web contents.
    const reloaded = createOrkestratorElectronApi(window.ipc);
    await waitForFilter(gateway, [], "A reload kept the previous document's listens");

    const leaf = await watch(reloaded, LEAF_EVENT);
    await waitForFilter(gateway, [LEAF_EVENT], "The new document's listen never arrived");
    await waitUntil(() => resyncs(leaf.frames).length === 1, "The new stream never announced");
  });
});

describe("two local windows on the relay", () => {
  test("each receive what they watch", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const window = await desktop.openRelayWindow();
    const second = await desktop.openRelayWindow();
    const onWindow = await watch(window.api, LEAF_EVENT);
    const onSecond = await watch(second.api, OTHER_EVENT);
    await waitForFilter(gateway, [LEAF_EVENT, OTHER_EVENT].sort(), "The filter never widened");

    emitRelayed(gateway, LEAF, "for-the-window");
    emitRelayed(gateway, OTHER, "for-the-second");
    await waitUntil(
      () => eventIds(onWindow.frames).length === 1 && eventIds(onSecond.frames).length === 1,
      "A frame never arrived",
    );

    expect(eventIds(onWindow.frames)).toEqual(["for-the-window"]);
    expect(eventIds(onSecond.frames)).toEqual(["for-the-second"]);
  });

  test("a reconnect the ring covers replays exactly once, with no resync", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info, { reconnectDelayMs: 200 });
    const window = await desktop.openRelayWindow();
    const second = await desktop.openRelayWindow();
    const onWindow = await watch(window.api, LEAF_EVENT);
    const onSecond = await watch(second.api, LEAF_EVENT);
    await waitForFilter(gateway, [LEAF_EVENT], "The stream never opened");
    await waitUntil(() => resyncs(onWindow.frames).length === 1, "No first announcement");
    // The second window can join after the first announcement has already
    // reached the first. Reconnect must add no resync to either one's baseline.
    const windowResyncs = resyncs(onWindow.frames).length;
    const secondResyncs = resyncs(onSecond.frames).length;

    await dropFilteredStream(gateway);
    emitRelayed(gateway, LEAF, "missed");
    await waitUntil(
      () => eventIds(onWindow.frames).length === 1 && eventIds(onSecond.frames).length === 1,
      "The missed frame was never replayed",
      5_000,
    );

    expect(eventIds(onWindow.frames)).toEqual(["missed"]);
    expect(eventIds(onSecond.frames)).toEqual(["missed"]);
    expect(resyncs(onWindow.frames)).toHaveLength(windowResyncs);
    expect(resyncs(onSecond.frames)).toHaveLength(secondResyncs);
  });

  test("a gap the ring cannot cover reaches both as a resync", async () => {
    const { gateway, info } = await startBackend({
      relayedEventReplay: { frameCapacity: 4, idleRetentionMs: 60_000 },
    });
    const desktop = await startDesktop(info, { reconnectDelayMs: 200 });
    const window = await desktop.openRelayWindow();
    const second = await desktop.openRelayWindow();
    const onWindow = await watch(window.api, LEAF_EVENT);
    const onSecond = await watch(second.api, LEAF_EVENT);
    await waitForFilter(gateway, [LEAF_EVENT], "The stream never opened");
    await waitUntil(() => resyncs(onWindow.frames).length === 1, "No first announcement");
    onWindow.frames.length = 0;
    onSecond.frames.length = 0;

    await dropFilteredStream(gateway);
    for (let index = 0; index < 32; index += 1) emitRelayed(gateway, LEAF, String(index));
    await waitUntil(
      () => resyncs(onWindow.frames).length === 1 && resyncs(onSecond.frames).length === 1,
      "The gap was never reported",
      5_000,
    );

    expect(onWindow.frames).toEqual([{ nodeId: LEAF, kind: "resync" }]);
    expect(onSecond.frames).toEqual([{ nodeId: LEAF, kind: "resync" }]);
    await waitForFilter(gateway, [LEAF_EVENT], "The stream did not come back");
  });

  test("a route to a new backend process starts fresh and resyncs", async () => {
    const first = await startBackend();
    const second = await startBackend();
    const desktop = await startDesktop(first.info);
    const window = await desktop.openRelayWindow();
    const onWindow = await watch(window.api, LEAF_EVENT);
    await waitUntil(() => resyncs(onWindow.frames).length === 1, "No first announcement");
    onWindow.frames.length = 0;

    desktop.client.retarget(second.info.url, second.info.token, { preserveCursor: false });
    await waitForFilter(second.gateway, [LEAF_EVENT], "The stream did not follow the route");
    await waitUntil(() => resyncs(onWindow.frames).length === 1, "The new process was not read");
    await waitForFilter(first.gateway, [], "The previous route kept its stream");

    emitRelayed(second.gateway, LEAF, "after-the-move");
    await waitUntil(
      () => eventIds(onWindow.frames).length === 1,
      "The new route delivered nothing",
    );
  });
});

describe("a window on the direct gateway transport", () => {
  test("adds nothing to main's filter, while a relay window beside it still does", async () => {
    const { gateway, info } = await startBackend();
    const desktop = await startDesktop(info);
    const direct = await desktop.openGatewayWindow();
    const frames: unknown[] = [];
    direct.api.listen(OTHER_EVENT, (payload) => void frames.push(payload));
    await direct.api.eventStreamReady(OTHER_EVENT);
    await waitUntil(() => mainStreams(gateway).length === 1, "Main's stream never opened");
    expect(relayedFilters(gateway)).toEqual([]);

    const second = await desktop.openRelayWindow();
    const onSecond = await watch(second.api, LEAF_EVENT);
    await waitForFilter(
      gateway,
      [LEAF_EVENT],
      "The relay window's listen never reached the filter",
    );
    emitRelayed(gateway, LEAF, "for-the-relay-window");
    emitRelayed(gateway, OTHER, "not-through-main");
    await waitUntil(
      () => eventIds(onSecond.frames).length === 1,
      "The relay window's frame never came",
    );
    expect(frames).toEqual([]);
  });
});

/**
 * A backend from before per-node names: it ignores `relayedEvents`, carries every
 * relayed event on the main stream under the old name, and replays them with ids.
 */
async function startOlderBackend() {
  const eventUrls: URL[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__orkestrator/invoke") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: { activeConnectionId: "local", connections: [] } }));
      return;
    }
    if (url.pathname !== "/__orkestrator/events") {
      response.writeHead(404).end();
      return;
    }
    eventUrls.push(url);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `id: older:0\ndata: ${JSON.stringify({ event: "gateway.connected", payload: { status: url.searchParams.has("since") ? "replayed" : "fresh" } })}\n\n`,
    );
    open.add(response);
    response.on("close", () => open.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  let revision = 0;
  return {
    info: {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      token: "older-backend-token",
    },
    eventUrls,
    openStreams: () => open.size,
    send(payload: unknown) {
      revision += 1;
      const frame = JSON.stringify({ event: RELAYED_NODE_EVENT, payload });
      for (const response of open) response.write(`id: older:${revision}\ndata: ${frame}\n\n`);
    },
    dropStreams() {
      for (const response of open) response.destroy();
    },
  };
}

describe("an older backend", () => {
  test("still reaches two relay windows under the old name", async () => {
    const older = await startOlderBackend();
    const desktop = await startDesktop(older.info);
    const window = await desktop.openRelayWindow();
    const second = await desktop.openRelayWindow();
    const onWindow = await watch(window.api, RELAYED_NODE_EVENT);
    const onSecond = await watch(second.api, RELAYED_NODE_EVENT);
    await waitUntil(() => older.openStreams() === 1, "Main's stream never opened");

    older.send(relayedEvent(LEAF, "old-name"));
    await waitUntil(
      () => eventIds(onWindow.frames).length === 1 && eventIds(onSecond.frames).length === 1,
      "An old-name frame never arrived",
    );

    // Asked for per-node names, which this backend does not know; and since the
    // watch answered without `perNodeEvents`, no window asked for a node's stream.
    expect(older.eventUrls).toHaveLength(1);
    expect(older.eventUrls[0]?.searchParams.get("relayedEvents")).toBe("per-node");
    expect(older.eventUrls[0]?.searchParams.has("includeEvents")).toBe(false);
  });

  test("its resync after a reconnect still reaches both", async () => {
    const older = await startOlderBackend();
    const desktop = await startDesktop(older.info);
    const window = await desktop.openRelayWindow();
    const second = await desktop.openRelayWindow();
    const onWindow = await watch(window.api, RELAYED_NODE_EVENT);
    const onSecond = await watch(second.api, RELAYED_NODE_EVENT);
    await waitUntil(() => older.openStreams() === 1, "Main's stream never opened");
    older.send(relayedEvent(LEAF, "seen"));
    await waitUntil(() => eventIds(onWindow.frames).length === 1, "First frame never arrived");

    older.dropStreams();
    await waitUntil(() => older.eventUrls.length === 2, "Main never reconnected", 5_000);
    await waitUntil(() => older.openStreams() === 1, "The reconnect never settled");
    expect(older.eventUrls[1]?.searchParams.get("since")).toBe("older:1");
    older.send({ nodeId: LEAF, kind: "resync" });

    await waitUntil(
      () => resyncs(onWindow.frames).length === 1 && resyncs(onSecond.frames).length === 1,
      "The resync never arrived",
    );
    expect(older.eventUrls.every((url) => !url.searchParams.has("includeEvents"))).toBe(true);
  });
});

/** Ends main's filtered stream from the gateway's side, as a dropped link does. */
async function dropFilteredStream(gateway: OrkestratorGateway): Promise<void> {
  const clients = eventClients(gateway) as unknown as Map<{ destroy(): void }, StreamState>;
  const entry = [...clients].find(([, state]) => state.relayedStream);
  if (!entry) throw new Error("No filtered stream to drop");
  entry[0].destroy();
  await waitUntil(() => relayedFilters(gateway).length === 0, "The stream did not close");
}
