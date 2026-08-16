import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { eventMatchesSubscription, MAX_STATIC_FALLBACK_SOURCE_BYTES, normalizeGatewayEventMetricKey, normalizeMetricLabel, OrkestratorGateway, parseEventSubscriptionFilter, readStaticFileWithinLimit, rewriteBrowserPreviewBody, stripCodedContentHeaders, stripTransformedRepresentationHeaders } from "../../../apps/backend/src/gateway";
import { stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import {
  auxiliaryServers,
  createLogger,
  createRendererRoot,
  createTempDir,
  decodeResponseBody,
  eventClients,
  gateways,
  occupyContiguousPorts,
  openEventStream,
  pinBufferedBytes,
  readGatewayMetrics,
  requestUrl,
  startGateway,
  waitUntil,
  writeRendererAsset,
} from "./gateway-test-harness.js";


describe("remote gateway", () => {



  test("separates content-coded metadata from full transformed-representation stripping", () => {
    const upstream = () => ({
      etag: "\"upstream\"",
      "content-md5": "identity-md5",
      "content-digest": "sha-256=:content:",
      "repr-digest": "sha-256=:representation:",
      digest: "sha-256=identity",
      "accept-ranges": "bytes",
      "content-type": "text/plain",
    });

    // Nothing was transformed: only the fields defined over content-coded bytes
    // are dropped, so the response still describes the identity representation.
    const coded = upstream();
    stripCodedContentHeaders(coded);
    expect(coded).toEqual({
      etag: "\"upstream\"",
      "repr-digest": "sha-256=:representation:",
      digest: "sha-256=identity",
      "accept-ranges": "bytes",
      "content-type": "text/plain",
    });

    // Bytes were replaced: every validator and digest calculated over them goes,
    // and the gateway cannot serve ranges over what it produced on the fly.
    const transformed = upstream();
    stripTransformedRepresentationHeaders(transformed);
    expect(transformed).toEqual({ "content-type": "text/plain" });

    // Both are safe on headers that never carried the fields.
    const bare: OutgoingHttpHeaders = { "content-type": "text/plain" };
    stripCodedContentHeaders(bare);
    stripTransformedRepresentationHeaders(bare);
    expect(bare).toEqual({ "content-type": "text/plain" });
  });



  test("uses gzip-only fallback and leaves non-beneficial content as identity", async () => {
    const dataDir = await createTempDir("ork-static-fallback-selection-");
    const rendererRoot = await createRendererRoot(dataDir);
    await writeRendererAsset(
      rendererRoot,
      "assets/compressible-12345678.js",
      "console.log('gzip fallback');".repeat(200),
    );
    await writeRendererAsset(rendererRoot, "assets/tiny-12345678.txt", "x");

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const authorization = { authorization: `Bearer ${info.token}` };
    const gzip = await requestUrl(`${info.url}assets/compressible-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "gzip" },
    });
    expect(gzip.status).toBe(200);
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(gzip)).toContain("gzip fallback");

    const identity = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      headers: { ...authorization, "accept-encoding": "br, gzip" },
    });
    expect(identity.status).toBe(200);
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.body).toBe("x");

    // Identity is acceptable here, so the identity metadata HEAD reports is
    // already accurate and nothing is withheld: the response stays usable for
    // revalidation and for discovering the resource size.
    const tinyHead = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      method: "HEAD",
      headers: { ...authorization, "accept-encoding": "br, gzip" },
    });
    expect(tinyHead.status).toBe(200);
    expect(tinyHead.headers["content-encoding"]).toBeUndefined();
    expect(tinyHead.headers["content-length"]).toBe("1");
    expect(tinyHead.headers.etag).toBe(String(identity.headers.etag));
    expect(tinyHead.rawBody.byteLength).toBe(0);

    const tinyHeadRevalidated = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      headers: {
        ...authorization,
        "accept-encoding": "br, gzip",
        "if-none-match": String(tinyHead.headers.etag),
      },
    });
    expect(tinyHeadRevalidated.status).toBe(304);
    expect(tinyHeadRevalidated.rawBody.byteLength).toBe(0);

    const wildcardHead = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      method: "HEAD",
      headers: {
        ...authorization,
        "accept-encoding": "br, gzip",
        "if-none-match": "*",
      },
    });
    expect(wildcardHead.status).toBe(304);
    expect(wildcardHead.rawBody.byteLength).toBe(0);

    const unacceptable = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      headers: {
        ...authorization,
        "accept-encoding": "br, gzip, identity;q=0",
      },
    });
    expect(unacceptable.status).toBe(200);
    expect(["br", "gzip"]).toContain(unacceptable.headers["content-encoding"]);
    expect(decodeResponseBody(unacceptable)).toBe("x");
  });



  test("serves identity when a coded form was acceptable but the server declined it", async () => {
    const dataDir = await createTempDir("ork-static-declined-");
    const rendererRoot = await createRendererRoot(dataDir);
    const source = Buffer.alloc(MAX_STATIC_FALLBACK_SOURCE_BYTES + 1, 0x61);
    await writeRendererAsset(rendererRoot, "assets/large-12345678.js", source);

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const authorization = { authorization: `Bearer ${info.token}` };
    // The client refused identity and br/gzip were both acceptable, so a 406
    // would be a lie: the asset is representable, this server just will not
    // spend 8MB+ of CPU and memory doing it.
    const response = await requestUrl(`${info.url}assets/large-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "br, gzip, identity;q=0" },
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.rawBody.byteLength).toBe(source.byteLength);

    const head = await requestUrl(`${info.url}assets/large-12345678.js`, {
      method: "HEAD",
      headers: { ...authorization, "accept-encoding": "br, gzip, identity;q=0" },
    });
    expect(head.status).toBe(response.status);
    expect(head.headers["content-encoding"]).toBeUndefined();
    expect(head.headers["content-length"]).toBe(String(source.byteLength));

    // Only a request that accepts *nothing* is a real 406.
    const unrepresentable = await requestUrl(`${info.url}assets/large-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "identity;q=0" },
    });
    expect(unrepresentable.status).toBe(406);
  });



  test("reads fallback sources through a stat-verified bounded file handle", async () => {
    const root = await createTempDir("ork-static-bounded-read-");
    const filePath = path.join(root, "asset.js");
    await writeFile(filePath, "small source");
    const originalStat = await stat(filePath);

    expect(
      await readStaticFileWithinLimit(
        filePath,
        originalStat.mtimeMs,
        originalStat.size,
      ),
    ).toEqual(Buffer.from("small source"));

    await writeFile(filePath, Buffer.alloc(1024 * 1024, 0x61));
    expect(
      await readStaticFileWithinLimit(
        filePath,
        originalStat.mtimeMs,
        originalStat.size,
      ),
    ).toBeNull();
    expect(
      await readStaticFileWithinLimit(
        filePath,
        originalStat.mtimeMs,
        MAX_STATIC_FALLBACK_SOURCE_BYTES + 1,
      ),
    ).toBeNull();
    expect(
      await readStaticFileWithinLimit(
        path.join(root, "missing.js"),
        originalStat.mtimeMs,
        originalStat.size,
      ),
    ).toBeNull();
  });



  test("collapses per-entity event names and rejects unusable labels", () => {
    expect(normalizeGatewayEventMetricKey("terminal-output-session-1")).toBe("terminal-output");
    expect(normalizeGatewayEventMetricKey("terminal-output-tmux:env:tab")).toBe("terminal-output-tmux");
    // One label per container would otherwise evict genuine event names.
    expect(normalizeGatewayEventMetricKey("claude-state-abc123")).toBe("claude-state");
    expect(normalizeGatewayEventMetricKey("claude-state-def456")).toBe("claude-state");
    expect(normalizeGatewayEventMetricKey("environment-renamed")).toBe("environment-renamed");
    expect(normalizeGatewayEventMetricKey("container-log")).toBe("container-log");

    expect(normalizeMetricLabel("get_environments")).toBe("get_environments");
    expect(normalizeMetricLabel("  spaced  ")).toBe("spaced");
    expect(normalizeMetricLabel("ok.name:v1-2")).toBe("ok.name:v1-2");
    expect(normalizeMetricLabel("9leading")).toBe("__invalid__");
    expect(normalizeMetricLabel("has space")).toBe("__invalid__");
    expect(normalizeMetricLabel("")).toBe("__invalid__");
    expect(normalizeMetricLabel("x".repeat(97))).toBe("__invalid__");
    // `__proto__` must not survive into a label that later becomes an object key.
    expect(normalizeMetricLabel("__proto__")).toBe("__invalid__");
    // Reserved buckets pass through even though they fail the label pattern.
    for (const reserved of ["__overflow__", "__invalid__", "__unknown__", "__keepalive__"]) {
      expect(normalizeMetricLabel(reserved)).toBe(reserved);
    }
  });



  test("never retains a rejected command name, including when the registry is not consulted", async () => {
    const secretLikeName = "AValidLookingSecretToken1234567890";
    // Mirrors OrkestratorBackend: shutdown is refused before the registry
    // lookup, so the error text says nothing about whether the name is known.
    let shuttingDown = false;
    const backend = {
      invoke: mock(async (command: string) => {
        if (shuttingDown) throw new Error("Backend is shutting down");
        if (command !== "registered_command") {
          throw new Error(`Unknown backend command: ${command}`);
        }
        return { ok: true };
      }),
      hasCommand: (command: string) => command === "registered_command",
    };
    const { info } = await startGateway({ backend });
    const invoke = (command: string) => requestUrl(`${info.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command }),
    });

    expect((await invoke(secretLikeName)).status).toBe(500);
    shuttingDown = true;
    expect((await invoke(`${secretLikeName}Shutdown`)).status).toBe(500);
    expect((await invoke("registered_command")).status).toBe(500);

    const metrics = await readGatewayMetrics(info);
    const keys = Object.keys(metrics.commands);
    expect(keys.some((key) => key.includes("SecretToken"))).toBe(false);
    expect(metrics.commands.__unknown__).toMatchObject({ count: 2, failures: 2 });
    // A registered command keeps its own bucket even when it fails.
    expect(metrics.commands.registered_command).toMatchObject({ count: 1, failures: 1 });
  });



  test("filters terminal prefixes while restoring explicitly subscribed sessions", () => {
    expect(parseEventSubscriptionFilter(" terminal-output-one, menu- ")).toEqual([
      "terminal-output-one",
      "menu-",
    ]);
    expect(eventMatchesSubscription(
      "menu-zoom",
      null,
      ["terminal-output-one"],
      ["terminal-output-"],
    )).toBe(false);
    expect(eventMatchesSubscription(
      "terminal-output-one",
      null,
      ["terminal-output-one"],
      ["terminal-output-"],
    )).toBe(true);
    expect(eventMatchesSubscription(
      "terminal-output-two",
      null,
      ["terminal-output-one"],
      ["terminal-output-"],
    )).toBe(false);
  });



  test("counts actual event writes, bounds labels, and closes each stream exactly once", async () => {
    const { gateway, info } = await startGateway();
    const lagging = await openEventStream(gateway, info);
    const healthy = await openEventStream(gateway, info);
    const payload = { bytesBase64: "eA==" };
    const terminalMessage = `data: ${JSON.stringify({
      event: "terminal-output-session-a",
      payload,
    })}\n\n`;

    pinBufferedBytes(lagging.response, 2 * 1024 * 1024);
    gateway.emit("terminal-output-session-a", payload);
    await waitUntil(
      () => healthy.received().includes("terminal-output-session-a"),
      "Healthy stream never received the terminal frame",
    );

    pinBufferedBytes(lagging.response, 8 * 1024 * 1024 + 1);
    gateway.emit("environment-changed", { id: "env" });
    await waitUntil(() => lagging.aborted(), "Lagging stream was never dropped");
    await waitUntil(
      () => healthy.received().includes("environment-changed"),
      "Healthy stream never received the authoritative event",
    );

    let metrics = await readGatewayMetrics(info);
    expect(metrics.stream).toMatchObject({
      open: 1,
      connecting: 0,
      opened: 2,
      closed: 1,
      dropped: 1,
      stalled: 1,
      softDesyncs: 1,
    });
    expect(metrics.events["terminal-output"]).toEqual({
      frames: 1,
      wireBytes: Buffer.byteLength(terminalMessage),
      droppedFrames: 1,
      droppedClients: 0,
    });
    expect(metrics.events["environment-changed"]).toMatchObject({
      frames: 1,
      droppedClients: 1,
    });

    // Terminal identifiers collapse to fixed categories, and arbitrary labels
    // can consume neither unbounded bytes nor unbounded map entries.
    gateway.emit("terminal-output-tmux:env:tab:one", payload);
    gateway.emit(`${"x".repeat(1_000)} secret`, null);
    for (let index = 0; index < 150; index += 1) {
      gateway.emit(`event-${index}`, index);
    }
    await waitUntil(
      () => healthy.received().includes('"event":"event-149"'),
      "Event cardinality frames did not reach the healthy stream",
    );

    metrics = await readGatewayMetrics(info);
    const eventKeys = Object.keys(metrics.events);
    expect(eventKeys).toContain("terminal-output-tmux");
    expect(eventKeys).toContain("__invalid__");
    expect(eventKeys).toContain("__overflow__");
    expect(eventKeys.every((key) => !key.includes("secret"))).toBe(true);
    expect(eventKeys).toHaveLength(128);
    expect(eventKeys.every((key) => Buffer.byteLength(key) <= 96)).toBe(true);
    expect(eventKeys.reduce((total, key) => total + Buffer.byteLength(key), 0)).toBeLessThanOrEqual(8 * 1024);

    healthy.response.destroy();
    healthy.close();
    await waitUntil(
      () => eventClients(gateway).size === 0,
      "Healthy stream did not close",
    );
    metrics = await readGatewayMetrics(info);
    expect(metrics.stream).toMatchObject({
      open: 0,
      opened: 2,
      closed: 2,
      dropped: 1,
    });
  });



  test("retains only the latest refused tmux repaint and flushes it on drain", async () => {
    const dataDir = await createTempDir("ork-gateway-tmux-soft-limit-");
    const rendererRoot = await createRendererRoot(dataDir);
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: createLogger(),
    });
    const writes: string[] = [];
    const client = {
      writableLength: 1024 * 1024,
      write: mock((message: string) => {
        writes.push(message);
        return false;
      }),
      destroy: mock(() => undefined),
    };
    const state = {
      prefixes: null,
      includedPrefixes: ["terminal-output-tmux:env:tab:one"],
      excludedPrefixes: ["terminal-output-"],
      desyncedSessions: new Set<string>(),
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    clients.set(client, state);

    gateway.emit("terminal-output-tmux:env:tab:one", {
      text: "old pane",
      full: true,
    });
    gateway.emit("terminal-output-tmux:env:tab:one", {
      text: "latest pane",
      full: true,
    });
    gateway.emit("environment-changed", { id: "env" });
    expect(writes).toEqual([]);

    client.writableLength = 0;
    const flushed = (
      gateway as unknown as {
        flushDesyncNotices(client: object, state: typeof state): boolean;
      }
    ).flushDesyncNotices(client, state);

    expect(flushed).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("latest pane");
    expect(writes[0]).not.toContain("old pane");
    expect(writes[0]).not.toContain('"desynced":true');
    expect(state.desyncedSessions.size).toBe(0);

    // A later refused line patch invalidates any retained full frame because
    // replaying that frame alone would still omit the patch.
    client.writableLength = 1024 * 1024;
    gateway.emit("terminal-output-tmux:env:tab:one", {
      text: "recovery base",
      full: true,
    });
    gateway.emit("terminal-output-tmux:env:tab:one", {
      text: "\u001b[2;1H\u001b[2Kpatch",
      full: false,
    });
    client.writableLength = 0;
    expect((
      gateway as unknown as {
        flushDesyncNotices(client: object, state: typeof state): boolean;
      }
    ).flushDesyncNotices(client, state)).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain('"desynced":true');
    expect(writes[1]).not.toContain("recovery base");
  });



  test("retains one latest repaint per session for a multiplexed terminal stream", async () => {
    // A same-origin browser now multiplexes every mounted terminal onto one
    // filtered stream, so a lagging client can owe recovery frames for several
    // tmux sessions at once. Retention is per session, not per socket.
    const dataDir = await createTempDir("ork-gateway-tmux-multiplexed-");
    const rendererRoot = await createRendererRoot(dataDir);
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: createLogger(),
    });
    const writes: string[] = [];
    const client = {
      writableLength: 1024 * 1024,
      write: mock((message: string) => {
        writes.push(message);
        return false;
      }),
      destroy: mock(() => undefined),
    };
    const state = {
      prefixes: null,
      includedPrefixes: [
        "terminal-output-tmux:env:tab:one",
        "terminal-output-tmux:env:tab:two",
      ],
      excludedPrefixes: ["terminal-output-"],
      desyncedSessions: new Set<string>(),
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    clients.set(client, state);

    gateway.emit("terminal-output-tmux:env:tab:one", {
      text: "one old",
      full: true,
    });
    gateway.emit("terminal-output-tmux:env:tab:two", {
      text: "two old",
      full: true,
    });
    gateway.emit("terminal-output-tmux:env:tab:one", {
      text: "one latest",
      full: true,
    });
    gateway.emit("terminal-output-tmux:env:tab:two", {
      text: "two latest",
      full: true,
    });
    expect(writes).toEqual([]);
    expect(state.desyncedSessions).toEqual(
      new Set(["tmux:env:tab:one", "tmux:env:tab:two"]),
    );

    client.writableLength = 0;
    const flushed = (
      gateway as unknown as {
        flushDesyncNotices(client: object, state: typeof state): boolean;
      }
    ).flushDesyncNotices(client, state);

    expect(flushed).toBe(true);
    // One recovery frame per session, each the newest full-pane repaint — not a
    // single frame for whichever session lagged last.
    expect(writes).toHaveLength(2);
    const combined = writes.join("");
    expect(combined).toContain("one latest");
    expect(combined).toContain("two latest");
    expect(combined).not.toContain(Buffer.from("one old").toString("base64"));
    expect(combined).not.toContain(Buffer.from("two old").toString("base64"));
    expect(combined).not.toContain('"desynced":true');
    expect(state.desyncedSessions.size).toBe(0);
  });



  test("disconnects before a current frame would exceed the hard buffer limit", async () => {
    const dataDir = await createTempDir("ork-gateway-hard-limit-");
    const rendererRoot = await createRendererRoot(dataDir);
    const logger = createLogger();
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger,
    });
    const client = {
      writableLength: 8 * 1024 * 1024 - 10,
      write: mock(() => true),
      destroy: mock(() => undefined),
    };
    const clients = (
      gateway as unknown as { clients: Map<object, unknown> }
    ).clients;
    clients.set(client, {
      prefixes: null,
      includedPrefixes: null,
      excludedPrefixes: null,
      desyncedSessions: new Set<string>(),
    });

    gateway.emit("environment-changed", { id: "environment-a" });
    expect(client.write).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(clients.has(client)).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });



  test("subscribes a connecting stream from its own query string", async () => {
    const { gateway, info } = await startGateway();
    const scoped = await openEventStream(gateway, info, "?events=menu-");
    const terminal = await openEventStream(
      gateway,
      info,
      "?excludeEvents=terminal-output-&includeEvents=terminal-output-one",
    );

    gateway.emit("terminal-output-two", { bytesBase64: "dHdv" });
    gateway.emit("environment-changed", { id: "env" });
    gateway.emit("terminal-output-one", { bytesBase64: "b25l" });
    gateway.emit("menu-zoom", "in");

    // Each stream is ordered, so waiting for the last permitted event proves the
    // earlier ones were filtered rather than merely still in flight.
    await waitUntil(
      () => scoped.received().includes("menu-zoom"),
      "Scoped stream never received its subscribed event",
    );
    await waitUntil(
      () => terminal.received().includes("terminal-output-one"),
      "Terminal stream never received its restored session",
    );

    expect(scoped.received()).not.toContain("environment-changed");
    expect(scoped.received()).not.toContain("terminal-output-");
    expect(terminal.received()).not.toContain("terminal-output-two");
    expect(terminal.received()).not.toContain("menu-zoom");

    scoped.close();
    terminal.close();
  });



  test("leaves application string literals and already-proxied paths untouched", () => {
    const prefix = "/__orkestrator/browser/loopback/3000";
    const target = new URL("http://127.0.0.1:3000/");
    const source = [
      'const parts = location.pathname.split("/");',
      'const key = ["users", id].join("/");',
      'createBrowserRouter([{ path: "/", element: root }]);',
      'if (route.startsWith("/admin")) {}',
      "const icon = '/assets/icon.svg';",
      `const proxied = "${prefix}";`,
      `import "${prefix}/src/dep.js";`,
    ].join("\n");

    expect(rewriteBrowserPreviewBody(source, prefix, target, "js")).toBe(source);
  });



  test("keeps desktop control available and selects another browser port when the preferred port is occupied", async () => {
    const occupied = createServer((_request, response) => response.end("occupied"));
    auxiliaryServers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const occupiedAddress = occupied.address();
    if (!occupiedAddress || typeof occupiedAddress === "string") throw new Error("Expected TCP address");

    const { info } = await startGateway({
      port: occupiedAddress.port,
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
    });

    expect(info.browserUrl).toBeTruthy();
    expect(info.browserError).toBeUndefined();
    expect(new URL(info.browserUrl!).port).not.toBe(String(occupiedAddress.port));
    const headers = { authorization: `Bearer ${info.token}` };
    const response = await requestUrl(info.url, {
      headers,
    });
    const browserResponse = await requestUrl(info.browserUrl!, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(browserResponse.status).toBe(200);
  });



  test("uses an ephemeral browser port after every nearby fallback port is occupied", async () => {
    const occupied = await occupyContiguousPorts(21);
    auxiliaryServers.push(...occupied.servers);
    const logger = createLogger();

    const { info } = await startGateway({ port: occupied.start, logger });
    const selectedPort = Number(new URL(info.browserUrl!).port);

    expect(selectedPort < occupied.start || selectedPort > occupied.start + 20).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("nearby ports were in use"));
  });



  test("falls back to an ephemeral port when port 65535 is occupied", async () => {
    const occupied = createServer((_request, response) => response.end("occupied"));
    try {
      await new Promise<void>((resolve, reject) => {
        occupied.once("error", reject);
        occupied.listen(65_535, "127.0.0.1", () => {
          occupied.off("error", reject);
          resolve();
        });
      });
      auxiliaryServers.push(occupied);
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }

    const { info } = await startGateway({ port: 65_535 });

    expect(new URL(info.browserUrl!).port).not.toBe("65535");
  });



  test("accepts command bodies far larger than the shared JSON limit and rejects oversized ones with 413", async () => {
    const dataDir = await createTempDir("ork-gateway-invoke-size-");
    await createRendererRoot(dataDir);

    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => ({
        command,
        snapshotLength: (args.snapshot as string | undefined)?.length ?? 0,
      })),
    };
    const gateway = new OrkestratorGateway({
      backend,
      dataDir,
      rendererRoot: path.join(dataDir, "dist"),
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: createLogger(),
      allowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();
    expect(info).not.toBeNull();

    const headers = {
      authorization: `Bearer ${info!.token}`,
      "content-type": "application/json",
    };

    /*
     * Durable snapshots — agent handoffs above all — routinely exceed the 1 MiB
     * body limit the other JSON routes use. This route has to clear the 32 MB
     * storage limit or those limits are unreachable and a legitimate save fails
     * as a transport error.
     */
    const largeSnapshot = "x".repeat(4 * 1024 * 1024);
    const accepted = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: "save_agent_handoff",
        args: { snapshot: largeSnapshot },
      }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json()).toEqual({
      result: { command: "save_agent_handoff", snapshotLength: largeSnapshot.length },
    });

    const oversized = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: "save_agent_handoff",
        args: { snapshot: "x".repeat(49 * 1024 * 1024) },
      }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.json()).toEqual({ error: "Request body is too large" });
    expect(backend.invoke).toHaveBeenCalledTimes(1);
  });



  test("surfaces persistence failures without reporting a successful rotation", async () => {
    const root = await createTempDir("ork-gateway-write-failure-");
    const fileInsteadOfDirectory = path.join(root, "not-a-directory");
    await writeFile(fileInsteadOfDirectory, "blocked");
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: path.join(fileInsteadOfDirectory, "child"),
      rendererRoot: root,
      env: {},
      logger: createLogger(),
    });

    await expect(gateway.setToken("replacement-token-123456")).rejects.toThrow();
  });

});
