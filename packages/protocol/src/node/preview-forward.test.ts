import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../../test-fixtures/preview-app/server";
import {
  DEFAULT_PREVIEW_FORWARD_LIMITS,
  forwardPreviewRequest,
  forwardPreviewUpgrade,
  type PreviewForwardLimits,
  type PreviewForwardResult,
} from "./preview-forward.js";
import {
  crossSiteViolation,
  downstreamResponseHeaders,
  filterCookieHeader,
  mapLocation,
  readCookie,
  rewriteSetCookie,
  upstreamRequestHeaders,
  type PreviewHeaderPolicy,
} from "../preview-header-policy.js";
import { previewFailure } from "../preview-services.js";

const policyFor = (port: number, publicOrigin: string): PreviewHeaderPolicy => ({
  privateAuthority: `localhost:${port}`,
  privateOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
  publicOrigin,
  stripRequestHeaders: ["x-orkestrator-preview-ingress"],
});

describe("preview header policy", () => {
  const policy = policyFor(3000, "https://s-abc.preview.test");

  test("keeps application auth, strips transport and forwarding headers", () => {
    const headers = upstreamRequestHeaders(
      [
        ["Host", "s-abc.preview.test"],
        ["Authorization", "Bearer app-token"],
        ["Cookie", "app=1; __Host-orkestrator-preview=secret; orkestrator_gateway_auth=gw"],
        ["X-Forwarded-Host", "evil.test"],
        ["X-Forwarded-Proto", "http"],
        ["Forwarded", "for=1.2.3.4"],
        ["X-Orkestrator-Opencode-Token", "x"],
        ["x-orkestrator-preview-ingress", "local"],
        ["Connection", "keep-alive, x-drop-me"],
        ["x-drop-me", "1"],
        ["Origin", "https://s-abc.preview.test"],
        ["Referer", "https://s-abc.preview.test/page?q=1"],
        ["Accept", "text/html"],
      ],
      policy,
    );
    expect(headers).toEqual([
      ["host", "localhost:3000"],
      ["Authorization", "Bearer app-token"],
      ["Cookie", "app=1"],
      ["Origin", "http://localhost:3000"],
      ["Referer", "http://localhost:3000/page?q=1"],
      ["Accept", "text/html"],
      ["x-forwarded-proto", "https"],
    ]);
  });

  test("mapped origins use Host for CSRF while retaining the public transport protocol", () => {
    // Next.js Server Actions fall back to Host when X-Forwarded-Host is absent.
    const mapped = upstreamRequestHeaders([["Origin", "https://s-abc.preview.test"]], policy);
    expect(mapped).toContainEqual(["Origin", "http://localhost:3000"]);
    expect(mapped).toContainEqual(["host", "localhost:3000"]);
    expect(mapped.some(([name]) => name.toLowerCase() === "x-forwarded-host")).toBe(false);
    expect(mapped).toContainEqual(["x-forwarded-proto", "https"]);

    // Without a same-service Origin the public origin is forwarded, so
    // absolute URLs the app builds point at the preview host.
    const navigation = upstreamRequestHeaders([["Accept", "text/html"]], policy);
    expect(navigation).toContainEqual(["x-forwarded-host", "s-abc.preview.test"]);
    expect(navigation).toContainEqual(["x-forwarded-proto", "https"]);
  });

  test("foreign origins are forwarded unchanged for the app's own checks", () => {
    const headers = upstreamRequestHeaders([["Origin", "https://evil.test"]], policy);
    expect(headers).toContainEqual(["Origin", "https://evil.test"]);
    expect(headers).toContainEqual(["x-forwarded-host", "s-abc.preview.test"]);
    expect(headers).toContainEqual(["x-forwarded-proto", "https"]);
  });

  test("upgrade mode keeps the websocket handshake fields", () => {
    const headers = upstreamRequestHeaders(
      [
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
        ["Sec-WebSocket-Key", "k"],
        ["Sec-WebSocket-Protocol", "fixture.v1"],
        ["Origin", policy.publicOrigin],
      ],
      policy,
      { upgrade: true },
    );
    expect(headers.map(([name]) => name.toLowerCase())).toEqual([
      "host",
      "upgrade",
      "sec-websocket-key",
      "sec-websocket-protocol",
      "origin",
      "connection",
      "x-forwarded-proto",
    ]);
    expect(headers).toContainEqual(["Origin", "http://localhost:3000"]);
    expect(headers).toContainEqual(["host", "localhost:3000"]);
    expect(headers).toContainEqual(["x-forwarded-proto", "https"]);
  });

  test("cookies: reserved names dropped, Domain removed, __Host- path preserved", () => {
    expect(rewriteSetCookie("__Host-session=x; Path=/; Secure; HttpOnly")).toBe(
      "__Host-session=x; Path=/; Secure; HttpOnly",
    );
    expect(rewriteSetCookie("a=1; Domain=preview.test; Path=/")).toBe("a=1; Path=/");
    expect(rewriteSetCookie("__Host-orkestrator-preview=forged; Path=/")).toBeNull();
    expect(rewriteSetCookie("orkestrator_gateway_auth=forged")).toBeNull();
    expect(filterCookieHeader("__Host-orkestrator-preview=a")).toBeNull();
    expect(
      readCookie(
        [
          ["cookie", "a=1; b=2"],
          ["cookie", "a=3"],
        ],
        "a",
      ),
    ).toBeNull();
    expect(readCookie([["cookie", "a=1; b=2"]], "b")).toBe("2");
  });

  test("maps only same-service absolute redirects", () => {
    expect(mapLocation("http://localhost:3000/next?x=1#h", policy)).toBe(
      "https://s-abc.preview.test/next?x=1#h",
    );
    expect(mapLocation("/relative", policy)).toBe("/relative");
    expect(mapLocation("http://localhost:3001/other", policy)).toBe("http://localhost:3001/other");
    expect(mapLocation("https://accounts.example/oauth", policy)).toBe(
      "https://accounts.example/oauth",
    );
  });

  test("apps on default ports: private origins compare and emit canonically", () => {
    for (const [scheme, port] of [
      ["http", 80],
      ["https", 443],
    ] as const) {
      const defaultPort: PreviewHeaderPolicy = {
        privateAuthority: `localhost:${port}`,
        privateOrigins: [`${scheme}://localhost:${port}`, `${scheme}://127.0.0.1:${port}`],
        publicOrigin: "https://s-abc.preview.test",
      };
      expect(mapLocation(`${scheme}://localhost/next?x=1`, defaultPort)).toBe(
        "https://s-abc.preview.test/next?x=1",
      );
      expect(mapLocation(`${scheme}://localhost:${port}/a`, defaultPort)).toBe(
        "https://s-abc.preview.test/a",
      );
      expect(mapLocation(`${scheme}://127.0.0.1/b`, defaultPort)).toBe(
        "https://s-abc.preview.test/b",
      );
      expect(mapLocation(`${scheme}://localhost:8080/c`, defaultPort)).toBe(
        `${scheme}://localhost:8080/c`,
      );
      expect(
        downstreamResponseHeaders([["Location", `${scheme}://localhost/d`]], defaultPort).headers
          .location,
      ).toBe("https://s-abc.preview.test/d");
      const headers = upstreamRequestHeaders(
        [
          ["Origin", "https://s-abc.preview.test"],
          ["Referer", "https://s-abc.preview.test/page"],
        ],
        defaultPort,
      );
      // The Origin a browser would send for this app: no explicit default port.
      expect(headers).toContainEqual(["Origin", `${scheme}://localhost`]);
      expect(headers).toContainEqual(["Referer", `${scheme}://localhost/page`]);
      expect(headers).toContainEqual(["host", "localhost"]);
      expect(headers.some(([name]) => name.toLowerCase() === "x-forwarded-host")).toBe(false);
      expect(headers).toContainEqual(["x-forwarded-proto", "https"]);
    }
  });

  test("response policy keeps CSP and framing headers", () => {
    const { headers, droppedCookies } = downstreamResponseHeaders(
      [
        ["Content-Security-Policy", "default-src 'self'"],
        ["X-Frame-Options", "DENY"],
        ["Transfer-Encoding", "chunked"],
        ["Set-Cookie", "a=1"],
        ["Set-Cookie", "orkestrator_gateway_auth=x"],
        ["Alt-Svc", 'h3=":443"'],
      ],
      policy,
    );
    expect(headers).toEqual({
      "content-security-policy": "default-src 'self'",
      "x-frame-options": "DENY",
      "set-cookie": "a=1",
    });
    expect(droppedCookies).toBe(1);
  });

  test("cross-site writes and upgrades are refused", () => {
    const origin = "https://s-abc.preview.test";
    expect(crossSiteViolation("POST", [["origin", "https://evil.test"]], origin, false)).toBe(true);
    expect(crossSiteViolation("POST", [["origin", "null"]], origin, false)).toBe(true);
    expect(crossSiteViolation("POST", [["origin", origin]], origin, false)).toBe(false);
    expect(crossSiteViolation("GET", [["origin", "https://evil.test"]], origin, true)).toBe(true);
    expect(crossSiteViolation("POST", [["sec-fetch-site", "cross-site"]], origin, false)).toBe(
      true,
    );
    expect(crossSiteViolation("POST", [], origin, false)).toBe(false);
    // Reads from the service itself never change what writes may do.
    expect(crossSiteViolation("POST", [["sec-fetch-site", "same-site"]], origin, false)).toBe(true);
  });

  test("cross-service reads pass only as top-level document navigations", () => {
    const origin = "https://s-abc.preview.test";
    const sibling = "https://s-def.preview.test";
    const read = (headers: Array<[string, string]>, method = "GET") =>
      crossSiteViolation(method, headers, origin, false);
    const metadata = (site: string, mode: string, dest: string): Array<[string, string]> => [
      ["Sec-Fetch-Site", site],
      ["Sec-Fetch-Mode", mode],
      ["Sec-Fetch-Dest", dest],
    ];
    // The service's own page, worker and assets, and anything the user typed.
    expect(read(metadata("same-origin", "no-cors", "script"))).toBe(false);
    expect(read(metadata("same-origin", "cors", "empty"))).toBe(false);
    expect(read(metadata("none", "navigate", "document"))).toBe(false);
    // Links, form GETs and redirects from a sibling or another site.
    expect(read(metadata("same-site", "navigate", "document"))).toBe(false);
    expect(read(metadata("cross-site", "navigate", "document"))).toBe(false);
    // Everything a sibling could send without the user seeing a new page.
    expect(read(metadata("same-site", "no-cors", "empty"))).toBe(true);
    expect(read(metadata("same-site", "cors", "empty"))).toBe(true);
    expect(read(metadata("same-site", "no-cors", "image"))).toBe(true);
    expect(read(metadata("same-site", "no-cors", "script"))).toBe(true);
    expect(read(metadata("same-site", "navigate", "iframe"))).toBe(true);
    expect(read(metadata("same-site", "navigate", "object"))).toBe(true);
    expect(read(metadata("cross-site", "no-cors", "empty"))).toBe(true);
    expect(read(metadata("cross-site", "no-cors", "empty"), "HEAD")).toBe(true);
    expect(read(metadata("cross-site", "cors", "empty"), "OPTIONS")).toBe(true);
    expect(read([["sec-fetch-site", "same-site"]])).toBe(true);
    expect(read([["sec-fetch-site", "unexpected"]])).toBe(true);
    expect(
      read([...metadata("same-site", "navigate", "document"), ["sec-purpose", "prefetch"]]),
    ).toBe(true);
    expect(
      read([
        ...metadata("cross-site", "navigate", "document"),
        ["sec-purpose", "prefetch;prerender"],
      ]),
    ).toBe(true);
    // Without Fetch Metadata only a foreign Origin (CORS) is distinguishable.
    expect(read([])).toBe(false);
    expect(read([["origin", origin]])).toBe(false);
    expect(read([["origin", sibling]])).toBe(true);
    expect(read([["origin", "null"]])).toBe(true);
    expect(
      read([
        ["origin", origin],
        ["origin", origin],
      ]),
    ).toBe(true);
  });
});

describe("forwardPreviewRequest and forwardPreviewUpgrade", () => {
  let fixture: PreviewFixture;
  let ingress: Server;
  let ingressPort: number;
  let limits: PreviewForwardLimits;
  let connectFailure: Error | null;
  let connectDelayMs: number;
  let connects: number;
  const results: PreviewForwardResult[] = [];
  const openUpstreams = new Set<Socket>();

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "fixture-a" });
    limits = { ...DEFAULT_PREVIEW_FORWARD_LIMITS };
    connectFailure = null;
    connectDelayMs = 0;
    connects = 0;
    results.length = 0;
    const hooks = {
      connect: async () => {
        connects += 1;
        if (connectDelayMs) await Bun.sleep(connectDelayMs);
        if (connectFailure) throw connectFailure;
        const socket = connect(fixture.port, "127.0.0.1");
        openUpstreams.add(socket);
        socket.on("close", () => openUpstreams.delete(socket));
        await new Promise((resolve) => socket.once("connect", resolve));
        return socket;
      },
    };
    ingress = createServer((request, response) => {
      const origin = `http://127.0.0.1:${ingressPort}`;
      void forwardPreviewRequest(
        request,
        response,
        policyFor(fixture.port, origin),
        limits,
        hooks,
      ).then((result) => results.push(result));
    });
    ingress.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const origin = `http://127.0.0.1:${ingressPort}`;
      void forwardPreviewUpgrade(
        request,
        socket,
        head,
        policyFor(fixture.port, origin),
        limits,
        hooks,
      );
    });
    await new Promise<void>((resolve) => ingress.listen(0, "127.0.0.1", resolve));
    ingressPort = (ingress.address() as AddressInfo).port;
  });

  afterEach(async () => {
    ingress.closeAllConnections();
    await new Promise<void>((resolve) => ingress.close(() => resolve()));
    for (const socket of openUpstreams) socket.destroy();
    await fixture.close();
  });

  test("reports the time from upstream connect to the response head", async () => {
    connectDelayMs = 40;
    expect((await get("/health")).status).toBe(200);
    await Bun.sleep(10);
    const completed = results.at(-1)!;
    expect(completed.outcome).toBe("completed");
    expect(completed.firstByteMs).toBeGreaterThanOrEqual(35);

    connectFailure = previewFailure("connection-refused");
    expect((await get("/health")).status).toBeGreaterThanOrEqual(500);
    await Bun.sleep(10);
    expect(results.at(-1)!.outcome).toBe("failed");
    expect(results.at(-1)!.firstByteMs).toBeUndefined();
  });

  function get(
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    body?: Buffer,
    onFirstChunk?: (chunk: Buffer) => void,
  ) {
    return new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
    }>((resolve, reject) => {
      const request = httpRequest(
        { host: "127.0.0.1", port: ingressPort, path, method, headers, agent: false },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            if (chunks.length === 1) onFirstChunk?.(chunk);
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  }

  test("serves root paths and assets without rewriting, with private Host upstream", async () => {
    const page = await get("/", { authorization: "Bearer fixture-app-token" });
    expect(page.status).toBe(200);
    expect(page.headers["x-service-marker"]).toBe("fixture-a");
    expect(String(page.body)).toContain('href="/assets/app.css"');
    const reached = fixture.requests.at(-1)!;
    expect(reached.host).toBe(`localhost:${fixture.port}`);
    expect(reached.authorization).toBe("Bearer fixture-app-token");
    expect(reached.forwardedHost).toBe(`127.0.0.1:${ingressPort}`);
  });

  test("streams the first HTML chunk before the upstream completes", async () => {
    // The upstream finishes only once the client holds the first chunk, so a
    // forwarder that buffered the body until the end would never deliver it.
    let firstChunk = "";
    const result = await get("/chunked", {}, "GET", undefined, (chunk) => {
      firstChunk = String(chunk);
      fixture.releaseStalled();
    });
    expect(firstChunk).toContain("first");
    expect(firstChunk).not.toContain("second");
    expect(String(result.body)).toContain("second");
  });

  test("binary downloads and uploads are byte-exact", async () => {
    const download = await get("/binary");
    expect(createHash("sha256").update(download.body).digest("hex")).toBe(
      download.headers["x-sha256"] as string,
    );
    const payload = Buffer.alloc(700_000, 3);
    const upload = await get(
      "/echo",
      { "content-type": "application/octet-stream" },
      "POST",
      payload,
    );
    expect(JSON.parse(String(upload.body))).toMatchObject({
      bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
  });

  test("same-service fetches and writes retain public protocol and omit forwarded host", async () => {
    for (const method of ["GET", "POST"]) {
      const response = await get(
        "/echo",
        {
          origin: `http://127.0.0.1:${ingressPort}`,
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "https",
        },
        method,
      );
      expect(response.status).toBe(200);
      expect(fixture.requests.at(-1)).toMatchObject({
        method,
        host: `localhost:${fixture.port}`,
        origin: `http://localhost:${fixture.port}`,
        forwardedHost: undefined,
        forwardedProto: "http",
      });
    }
  });

  test("application cookies survive; reserved and widened cookies do not", async () => {
    const result = await get("/cookies/set");
    expect(result.headers["set-cookie"]).toEqual([
      "__Host-session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax",
      "plain=fixture-a; Path=/",
      "widened=1; Path=/",
    ]);
  });

  test("redirects: relative unchanged, same-service absolute mapped, external untouched", async () => {
    expect((await get("/redirect/relative")).headers.location).toBe("/app/next");
    expect((await get("/redirect/absolute")).headers.location).toBe(
      `http://127.0.0.1:${ingressPort}/app/abs?x=1`,
    );
    expect((await get("/redirect/external")).headers.location).toBe(
      "https://external.invalid/callback",
    );
  });

  test("conditional, range, and CSP responses pass through", async () => {
    expect((await get("/conditional", { "if-none-match": '"v1"' })).status).toBe(304);
    const range = await get("/range", { range: "bytes=10-19" });
    expect(range.status).toBe(206);
    expect(String(range.body)).toBe("0123456789");
    const csp = await get("/csp");
    expect(csp.headers["content-security-policy"]).toBe("default-src 'self'");
    expect(csp.headers["x-frame-options"]).toBe("DENY");
  });

  test("compressed representations pass through byte-exact, never decoded", async () => {
    for (const [path, encoding, decode] of [
      ["/encoded/gzip", "gzip", gunzipSync],
      ["/encoded/br", "br", brotliDecompressSync],
    ] as const) {
      const result = await get(path, { "accept-encoding": "gzip, br" });
      expect(result.headers["content-encoding"]).toBe(encoding);
      expect(createHash("sha256").update(result.body).digest("hex")).toBe(
        String(result.headers["x-sha256"]),
      );
      expect(decode(result.body).toString()).toStartWith("fixture-a ");
    }
  });

  test("SSE progresses and completes", async () => {
    const result = await get("/sse");
    expect(String(result.body)).toContain("data: fixture-a-3");
  });

  test("header stall returns a safe gateway timeout", async () => {
    limits.headersTimeoutMs = 50;
    const result = await get("/stall-headers");
    expect(result.status).toBe(504);
    expect(result.headers["x-orkestrator-preview-error"]).toBe("headers-timeout");
  });

  test("body stall after headers ends the connection instead of writing an error", async () => {
    limits.bodyIdleTimeoutMs = 50;
    const outcome = await get("/stall-body").catch((error: Error) => error);
    expect(
      outcome instanceof Error || (outcome as { body: Buffer }).body.toString() === "partial",
    ).toBe(true);
  });

  test("download limit closes endless bodies", async () => {
    limits.downloadMaxBytes = 256 * 1024;
    const outcome = await get("/endless").catch((error: Error) => error);
    if (!(outcome instanceof Error)) expect(outcome.body.length).toBeLessThan(2 * 1024 * 1024);
  });

  test("upload limit rejects oversized declared bodies before forwarding", async () => {
    limits.uploadMaxBytes = 1_000;
    const result = await get("/echo", {}, "POST", Buffer.alloc(5_000));
    expect(result.status).toBe(503);
    expect(fixture.requests.filter((request) => request.path === "/echo")).toHaveLength(0);
  });

  test("connect failures map to safe categories", async () => {
    connectFailure = previewFailure("connection-refused");
    const result = await get("/");
    expect(result.status).toBe(502);
    expect(result.headers["x-orkestrator-preview-error"]).toBe("connection-refused");
    expect(String(result.body)).not.toContain("127.0.0.1");
  });

  test("CONNECT and authority-changing targets are rejected", async () => {
    const trace = await get("/", {}, "TRACE");
    expect(trace.status).toBe(400);
  });

  /** Send raw bytes to the ingress and collect everything until it closes. */
  async function rawExchange(bytes: Buffer): Promise<string> {
    const socket = connect(ingressPort, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(bytes);
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      setTimeout(resolve, 2_000);
    });
    socket.destroy();
    return received;
  }

  // "/a" + U+010D U+010A + "X-Evil:" + U+0120 + "1" as raw UTF-8. Latin1 truncation
  // would turn it into "/a\r\nX-Evil: 1" on the upstream wire.
  const smuggledTarget = Buffer.concat([
    Buffer.from("/a"),
    Buffer.from([0xc4, 0x8d, 0xc4, 0x8a]),
    Buffer.from("X-Evil:"),
    Buffer.from([0xc4, 0xa0]),
    Buffer.from("1"),
  ]);

  // Since Bun 1.4.4 the node:http parser answers these raw targets with a bare
  // 400 before the forwarder runs; Electron's Node still hands them to the
  // forwarder, whose `invalid-request` refusal preview-http1.test.ts covers.
  // Either way nothing may reach the upstream.
  test("non-ASCII request targets are refused before any upstream I/O", async () => {
    const answer = await rawExchange(
      Buffer.concat([
        Buffer.from("GET "),
        smuggledTarget,
        Buffer.from(" HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
      ]),
    );
    expect(answer).toStartWith("HTTP/1.1 400");
    expect(connects).toBe(0);
    expect(fixture.requests).toHaveLength(0);
  });

  test("non-ASCII upgrade targets are refused before any upstream I/O", async () => {
    const answer = await rawExchange(
      Buffer.concat([
        Buffer.from("GET "),
        smuggledTarget,
        Buffer.from(
          " HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        ),
      ]),
    );
    expect(answer).toStartWith("HTTP/1.1 400");
    expect(connects).toBe(0);
  });

  test("websocket upgrade is transparent: subprotocol, text and binary echo", async () => {
    // lib.dom hides Bun's constructor overload for custom handshake headers.
    const BunWebSocket = WebSocket as typeof WebSocket & {
      new (url: string, options: Bun.WebSocketOptions): WebSocket;
    };
    const socket = new BunWebSocket(`ws://127.0.0.1:${ingressPort}/ws`, {
      protocols: ["fixture.v1"],
      headers: { Origin: `http://127.0.0.1:${ingressPort}` },
    });
    socket.binaryType = "arraybuffer";
    const messages: Array<string | ArrayBuffer> = [];
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("socket error"));
    });
    expect(socket.protocol).toBe("fixture.v1");
    expect(fixture.requests.at(-1)).toMatchObject({
      host: `localhost:${fixture.port}`,
      origin: `http://localhost:${fixture.port}`,
      forwardedHost: undefined,
      forwardedProto: "http",
    });
    const received = new Promise<void>((resolve) => {
      socket.onmessage = (event) => {
        messages.push(event.data as string | ArrayBuffer);
        if (messages.length === 3) resolve();
      };
    });
    socket.send("hello");
    socket.send(new Uint8Array([1, 2, 3]));
    await received;
    expect(JSON.parse(messages[0] as string)).toEqual({
      hello: "fixture-a",
      protocol: "fixture.v1",
    });
    expect(messages[1]).toBe("hello");
    expect(Array.from(new Uint8Array(messages[2] as ArrayBuffer))).toEqual([1, 2, 3]);
    const closed = new Promise<number>(
      (resolve) => (socket.onclose = (event) => resolve(event.code)),
    );
    socket.close(4001, "bye");
    expect(await closed).toBe(4001);
  });

  test("non-101 upgrade answers are relayed as ordinary responses", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${ingressPort}/not-a-socket`);
    const error = await new Promise<string>((resolve) => {
      socket.onerror = () => resolve("error");
      socket.onopen = () => resolve("open");
    });
    expect(error).toBe("error");
  });
});

describe("forwardPreviewUpgrade refusal bodies", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function tcpServer(onSocket: (socket: Socket) => void): Promise<number> {
    const server: NetServer = createNetServer(onSocket);
    const sockets = new Set<Socket>();
    server.on("connection", (socket: Socket) => sockets.add(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    return (server.address() as AddressInfo).port;
  }

  /** The ingress side of a real client connection, plus the browser end. */
  async function clientPair(): Promise<{
    browser: Socket;
    client: Socket;
    received: () => string;
  }> {
    let accept!: (socket: Socket) => void;
    const accepted = new Promise<Socket>((resolve) => (accept = resolve));
    const port = await tcpServer((socket) => accept(socket));
    const browser = connect(port, "127.0.0.1");
    cleanups.push(() => browser.destroy());
    let received = "";
    browser.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
    browser.on("error", () => undefined);
    return { browser, client: await accepted, received: () => received };
  }

  /** An upstream that answers the handshake with a 200 declaring 100 bytes, sends 7, and stalls. */
  async function stallingUpstream(): Promise<{ port: number; answered: () => boolean }> {
    let answered = false;
    const port = await tcpServer((socket) =>
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\npartial");
        answered = true;
      }),
    );
    return { port, answered: () => answered };
  }

  function forward(upstreamPort: number, client: Socket, limits: PreviewForwardLimits) {
    const request = {
      method: "GET",
      url: "/ws",
      rawHeaders: [
        "Host",
        "x",
        "Upgrade",
        "websocket",
        "Connection",
        "Upgrade",
        "Sec-WebSocket-Key",
        "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version",
        "13",
      ],
    } as unknown as IncomingMessage;
    return forwardPreviewUpgrade(
      request,
      client,
      Buffer.alloc(0),
      policyFor(upstreamPort, "http://127.0.0.1:1"),
      limits,
      {
        connect: async () => {
          const socket = connect(upstreamPort, "127.0.0.1");
          cleanups.push(() => socket.destroy());
          await new Promise((resolve) => socket.once("connect", resolve));
          return socket;
        },
      },
    );
  }

  test("a stalled refusal body settles within the body idle limit", async () => {
    const upstream = await stallingUpstream();
    const { client, received } = await clientPair();
    const started = Date.now();
    const result = await forward(upstream.port, client, {
      ...DEFAULT_PREVIEW_FORWARD_LIMITS,
      bodyIdleTimeoutMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result).toMatchObject({ outcome: "failed", category: "headers-timeout" });
    for (let attempt = 0; attempt < 100 && !received().includes("\r\n\r\n"); attempt += 1)
      await Bun.sleep(5);
    expect(received()).toStartWith("HTTP/1.1 504");
  });

  test("a client disconnect ends the refusal read", async () => {
    const upstream = await stallingUpstream();
    const { browser, client } = await clientPair();
    const pending = forward(upstream.port, client, {
      ...DEFAULT_PREVIEW_FORWARD_LIMITS,
      bodyIdleTimeoutMs: 30_000,
    });
    for (let attempt = 0; attempt < 200 && !upstream.answered(); attempt += 1) await Bun.sleep(5);
    expect(upstream.answered()).toBe(true);
    await Bun.sleep(30);
    browser.destroy();
    const result = await Promise.race([pending, Bun.sleep(2_000).then(() => "still pending")]);
    expect(result).toMatchObject({ outcome: "failed" });
  });
});
