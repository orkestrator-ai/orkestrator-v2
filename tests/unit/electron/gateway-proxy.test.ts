import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { activeDynamicCompressionCount, allocateBufferedProxySource, browserPreviewDecodeSnapshot, canAppendToProxySourceBuffer, canBufferBodyChunk, canStartDynamicCompression, canTransformProxyRepresentation, COMPRESSION_MIN_BYTES, DynamicCompressionBufferBudget, dynamicProxyCompressionBufferSnapshot, isCompressibleContentType, isDynamicCompressionSizeEligible, MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES, MAX_BUFFERED_BODY_CHUNKS, MAX_CONCURRENT_DYNAMIC_COMPRESSIONS, MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES, MAX_DYNAMIC_PROXY_BUFFERED_SOURCE_BYTES, OrkestratorGateway, parseStrictContentLengthHeader, releaseReservationOnResponseSettled, responseStatusCanHaveBody, settleRewrittenProxyBodyResponse, shouldAbandonBufferedProxyBody } from "../../../apps/backend/src/gateway";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  auxiliaryServers,
  createRendererRoot,
  createTempDir,
  decodeResponseBody,
  gateways,
  requestUrl,
  startGateway,
  waitUntil,
} from "./gateway-test-harness.js";


describe("remote gateway", () => {



  test("covers dynamic compression MIME, size, chunk, and proxy eligibility boundaries", () => {
    for (const contentType of [
      "text/plain",
      "TEXT/CSS; charset=UTF-8",
      "application/manifest+json",
      "application/wasm",
      "application/xml",
      "application/problem+json",
      "application/example+xml",
      "image/svg+xml",
    ]) {
      expect(isCompressibleContentType(contentType), contentType).toBe(true);
    }
    for (const contentType of [
      null,
      "",
      "application/jsonp",
      "application/xml-dtd",
      "application/octet-stream",
      "font/woff2",
      "image/png",
    ]) {
      expect(isCompressibleContentType(contentType), String(contentType)).toBe(false);
    }

    expect(isDynamicCompressionSizeEligible(COMPRESSION_MIN_BYTES - 1)).toBe(false);
    expect(isDynamicCompressionSizeEligible(COMPRESSION_MIN_BYTES)).toBe(true);
    expect(isDynamicCompressionSizeEligible(MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES)).toBe(true);
    expect(isDynamicCompressionSizeEligible(MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES + 1)).toBe(false);
    expect(isDynamicCompressionSizeEligible(-1)).toBe(false);
    expect(isDynamicCompressionSizeEligible(Number.NaN)).toBe(false);
    expect(canStartDynamicCompression(-1)).toBe(false);

    expect(canBufferBodyChunk(0, 0, 1, 1)).toBe(true);
    expect(canBufferBodyChunk(1, 1, 1, 1)).toBe(false);
    expect(canBufferBodyChunk(0, MAX_BUFFERED_BODY_CHUNKS - 1, 1, 1)).toBe(true);
    expect(canBufferBodyChunk(0, MAX_BUFFERED_BODY_CHUNKS, 1, 1)).toBe(false);
    expect(canBufferBodyChunk(0, 0, 0, 0)).toBe(true);
    expect(canBufferBodyChunk(-1, 0, 1, 1)).toBe(false);
    expect(canBufferBodyChunk(0, -1, 1, 1)).toBe(false);
    expect(canBufferBodyChunk(0, 0, -1, 1)).toBe(false);
    expect(canBufferBodyChunk(0, 0, 1, -1)).toBe(false);
    expect(canBufferBodyChunk(Number.NaN, 0, 1, 1)).toBe(false);
    expect(canBufferBodyChunk(0, Number.NaN, 1, 1)).toBe(false);
    expect(canBufferBodyChunk(0, 0, Number.NaN, 1)).toBe(false);
    expect(canBufferBodyChunk(0, 0, 1, Number.NaN)).toBe(false);
    expect(canBufferBodyChunk(0.5, 0, 1, 1)).toBe(false);
    expect(canBufferBodyChunk(0, 0, 1, Number.MAX_SAFE_INTEGER + 1)).toBe(false);

    expect(responseStatusCanHaveBody("GET", 200)).toBe(true);
    expect(responseStatusCanHaveBody("HEAD", 200)).toBe(false);
    expect(responseStatusCanHaveBody("GET", 199)).toBe(false);
    expect(responseStatusCanHaveBody("GET", 204)).toBe(false);
    expect(responseStatusCanHaveBody("GET", 205)).toBe(false);
    expect(responseStatusCanHaveBody("GET", 304)).toBe(false);
    expect(canTransformProxyRepresentation("GET", 200, null)).toBe(true);
    expect(canTransformProxyRepresentation("GET", 206, null)).toBe(false);
    expect(canTransformProxyRepresentation("GET", 200, "bytes 0-9/10")).toBe(false);
    expect(parseStrictContentLengthHeader(null)).toBeNull();
    expect(parseStrictContentLengthHeader("")).toBeNull();
    expect(parseStrictContentLengthHeader("01")).toBeNull();
    expect(parseStrictContentLengthHeader("-1")).toBeNull();
    expect(parseStrictContentLengthHeader("1.5")).toBeNull();
    expect(parseStrictContentLengthHeader("1024")).toBe(1024);
    expect(parseStrictContentLengthHeader(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });



  test("bounds dynamic proxy source reservations by count and aggregate bytes", () => {
    const budget = new DynamicCompressionBufferBudget(2, 3 * COMPRESSION_MIN_BYTES);
    const releaseFirst = budget.tryReserve(COMPRESSION_MIN_BYTES);
    const releaseSecond = budget.tryReserve(2 * COMPRESSION_MIN_BYTES);
    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();
    expect(budget.snapshot()).toEqual({
      activeCount: 2,
      activeBytes: 3 * COMPRESSION_MIN_BYTES,
    });
    expect(budget.tryReserve(COMPRESSION_MIN_BYTES)).toBeNull();
    releaseFirst?.();
    releaseFirst?.();
    expect(budget.snapshot()).toEqual({
      activeCount: 1,
      activeBytes: 2 * COMPRESSION_MIN_BYTES,
    });
    releaseSecond?.();
    expect(budget.snapshot()).toEqual({ activeCount: 0, activeBytes: 0 });
    // Admission is decided against this instance's own ceilings. Compression
    // eligibility is the caller's concern, so a sub-threshold size that fits the
    // budget is admitted rather than silently refused.
    const releaseSmall = budget.tryReserve(COMPRESSION_MIN_BYTES - 1);
    expect(releaseSmall).not.toBeNull();
    expect(budget.snapshot().activeBytes).toBe(COMPRESSION_MIN_BYTES - 1);
    releaseSmall?.();
    const tinyBudget = new DynamicCompressionBufferBudget(1, 512);
    const releaseTiny = tinyBudget.tryReserve(256);
    expect(releaseTiny).not.toBeNull();
    expect(tinyBudget.tryReserve(257)).toBeNull();
    releaseTiny?.();
    expect(budget.tryReserve(-1)).toBeNull();
    expect(budget.tryReserve(Number.NaN)).toBeNull();
    expect(budget.tryReserve(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(budget.snapshot()).toEqual({ activeCount: 0, activeBytes: 0 });

    const productionBudget = new DynamicCompressionBufferBudget();
    const releaseLarge = productionBudget.tryReserve(MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES);
    expect(releaseLarge).not.toBeNull();
    expect(productionBudget.tryReserve(MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES)).toBeNull();
    expect(productionBudget.snapshot().activeBytes).toBeLessThanOrEqual(
      MAX_DYNAMIC_PROXY_BUFFERED_SOURCE_BYTES,
    );
    releaseLarge?.();

    const responseBudget = new DynamicCompressionBufferBudget(1, COMPRESSION_MIN_BYTES);
    const releaseResponse = responseBudget.tryReserve(COMPRESSION_MIN_BYTES);
    const response = new EventEmitter() as ServerResponse;
    expect(releaseResponse).not.toBeNull();
    releaseReservationOnResponseSettled(response, releaseResponse!);
    expect(responseBudget.snapshot()).toEqual({
      activeCount: 1,
      activeBytes: COMPRESSION_MIN_BYTES,
    });
    response.emit("finish");
    response.emit("close");
    expect(responseBudget.snapshot()).toEqual({ activeCount: 0, activeBytes: 0 });
  });



  test("guards the buffered proxy source allocation, bound, and abandon decision", () => {
    const allocated = allocateBufferedProxySource(COMPRESSION_MIN_BYTES);
    expect(allocated?.byteLength).toBe(COMPRESSION_MIN_BYTES);
    expect(allocateBufferedProxySource(0)?.byteLength).toBe(0);
    // An allocation the host cannot satisfy surfaces as null so the caller can
    // release its reservation and fail the request instead of throwing inside
    // an event callback.
    expect(allocateBufferedProxySource(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(allocateBufferedProxySource(-1)).toBeNull();
    expect(allocateBufferedProxySource(Number.NaN)).toBeNull();
    expect(allocateBufferedProxySource(1.5)).toBeNull();

    expect(canAppendToProxySourceBuffer(0, 1024, 1024)).toBe(true);
    expect(canAppendToProxySourceBuffer(1024, 0, 1024)).toBe(true);
    expect(canAppendToProxySourceBuffer(1024, 1, 1024)).toBe(false);
    expect(canAppendToProxySourceBuffer(0, 1025, 1024)).toBe(false);
    expect(canAppendToProxySourceBuffer(-1, 1, 1024)).toBe(false);
    expect(canAppendToProxySourceBuffer(0, -1, 1024)).toBe(false);
    expect(canAppendToProxySourceBuffer(0, 1, -1)).toBe(false);
    expect(canAppendToProxySourceBuffer(Number.NaN, 1, 1024)).toBe(false);
    expect(canAppendToProxySourceBuffer(0, Number.NaN, 1024)).toBe(false);
    expect(canAppendToProxySourceBuffer(0, 1, Number.NaN)).toBe(false);

    expect(shouldAbandonBufferedProxyBody(false, false, false)).toBe(false);
    expect(shouldAbandonBufferedProxyBody(true, false, false)).toBe(true);
    expect(shouldAbandonBufferedProxyBody(false, true, false)).toBe(true);
    expect(shouldAbandonBufferedProxyBody(false, false, true)).toBe(true);
    expect(shouldAbandonBufferedProxyBody(true, true, true)).toBe(true);
  });



  test("fails rewritten proxy responses when asynchronous body preparation rejects", async () => {
    const writeHead = mock(() => undefined);
    const end = mock(() => undefined);
    const finish = mock(() => undefined);
    const fail = mock(() => undefined);
    const response = {
      destroyed: false,
      writeHead,
      end,
    } as unknown as ServerResponse;

    settleRewrittenProxyBodyResponse(
      response,
      200,
      { "content-type": "text/html" },
      Promise.reject("preview preparation failed"),
      () => false,
      finish,
      fail,
    );
    await waitUntil(() => fail.mock.calls.length === 1, "Rejected preview preparation did not fail");

    expect(fail.mock.calls[0]?.[0]).toEqual(new Error("preview preparation failed"));
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });



  test("settles a rewritten proxy body with its own length, vary, and encoding", async () => {
    const settle = async (
      prepared: { body: Buffer; encoding: string; variesByEncoding: boolean },
      headers: OutgoingHttpHeaders,
    ) => {
      const writeHead = mock(() => undefined);
      const end = mock(() => undefined);
      const finish = mock(() => undefined);
      const fail = mock(() => undefined);
      const response = { destroyed: false, writeHead, end } as unknown as ServerResponse;
      settleRewrittenProxyBodyResponse(
        response,
        200,
        headers,
        Promise.resolve(prepared) as never,
        () => false,
        finish,
        fail,
      );
      await waitUntil(() => finish.mock.calls.length === 1, "Preview body never settled");
      return { writeHead, end, headers, fail, finish };
    };

    const compressed = await settle(
      { body: Buffer.from("gzipped-preview"), encoding: "gzip", variesByEncoding: true },
      { "content-type": "text/html" },
    );
    expect(compressed.headers["content-length"]).toBe("gzipped-preview".length);
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(compressed.headers.vary).toBe("Accept-Encoding");
    expect(compressed.writeHead.mock.calls[0]).toEqual([200, compressed.headers]);
    expect(compressed.end.mock.calls[0]?.[0]).toEqual(Buffer.from("gzipped-preview"));
    expect(compressed.fail).not.toHaveBeenCalled();

    // Identity must strip an inherited upstream encoding rather than leave the
    // body mislabelled as still compressed.
    const identity = await settle(
      { body: Buffer.from("plain"), encoding: "identity", variesByEncoding: false },
      { "content-type": "text/html", "content-encoding": "br" },
    );
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect("content-encoding" in identity.headers).toBe(false);
    expect(identity.headers["content-length"]).toBe(5);
    expect(identity.headers.vary).toBeUndefined();
  });



  test("discards a rewritten proxy body when the response already settled or died", async () => {
    for (const scenario of ["settled", "destroyed"] as const) {
      const writeHead = mock(() => undefined);
      const end = mock(() => undefined);
      const finish = mock(() => undefined);
      const fail = mock(() => undefined);
      const response = {
        destroyed: scenario === "destroyed",
        writeHead,
        end,
      } as unknown as ServerResponse;
      let settledPreparation = false;

      settleRewrittenProxyBodyResponse(
        response,
        200,
        { "content-type": "text/html" },
        Promise.resolve({
          body: Buffer.from("late"),
          encoding: "identity",
          variesByEncoding: false,
        }).finally(() => {
          settledPreparation = true;
        }) as never,
        () => scenario === "settled",
        finish,
        fail,
      );
      await waitUntil(() => settledPreparation, "Preview preparation never settled");
      // One extra turn so a stray write would have landed before we assert.
      await Promise.resolve();

      expect(writeHead).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    }
  });



  test("allows configured public client origins without proxying browser traffic", async () => {
    const { info } = await startGateway({
      allowedOrigins: [
        "https://orkestrator.dev",
        "https://www.orkestrator.dev",
        "https://*.vercel.app",
      ],
    });
    const endpoint = `${info.url}__orkestrator/status`;

    const preflight = await requestUrl(endpoint, {
      method: "OPTIONS",
      headers: {
        origin: "https://orkestrator.dev",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
        "access-control-request-private-network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://orkestrator.dev");
    expect(preflight.headers["access-control-allow-private-network"]).toBe("true");
    // Remote renderers authenticate bridge calls with these headers, so a
    // preflight that omits one blocks every request to that bridge from the
    // browser.
    expect(preflight.headers["access-control-allow-headers"]).toBe(
      "Authorization, Content-Type, X-Orkestrator-Codex-Token, X-Orkestrator-Claude-Token, X-Orkestrator-OpenCode-Token, X-Orkestrator-Acp-Token",
    );

    const connected = await requestUrl(endpoint, {
      headers: {
        origin: "https://www.orkestrator.dev",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(connected.status).toBe(200);
    expect(connected.json()).toEqual({ ok: true });
    expect(connected.headers["access-control-allow-origin"]).toBe("https://www.orkestrator.dev");

    const preview = await requestUrl(endpoint, {
      headers: {
        origin: "https://orkestrator-git-main-team.vercel.app",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(preview.status).toBe(200);

    const rejected = await requestUrl(endpoint, {
      headers: {
        origin: "https://untrusted.example",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.json()).toEqual({ error: "Origin not allowed" });
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();

    const unauthenticated = await requestUrl(endpoint, {
      headers: { origin: "https://www.orkestrator.dev" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers["access-control-allow-origin"]).toBe("https://www.orkestrator.dev");

    const wrongMethod = await requestUrl(endpoint, {
      method: "POST",
      headers: {
        origin: "https://www.orkestrator.dev",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers["access-control-allow-origin"]).toBe("https://www.orkestrator.dev");

    const sameHost = await requestUrl(endpoint, {
      headers: {
        origin: new URL(info.url).origin,
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(sameHost.status).toBe(200);

    const malformed = await requestUrl(endpoint, {
      headers: {
        origin: "not an origin",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(malformed.status).toBe(403);
  });



  test("preserves bodyless and ranged proxy response semantics", async () => {
    const partial = "partial response ".repeat(128);
    const target = createServer((request, response) => {
      if (request.url === "/not-modified") {
        response.writeHead(304, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": 4096,
          etag: "\"cached\"",
          "content-md5": "identity-md5",
          "content-digest": "sha-256=:identity:",
          "repr-digest": "sha-256=:identity:",
          digest: "sha-256=identity",
          "accept-ranges": "bytes",
        });
        response.end();
        return;
      }
      response.writeHead(206, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(partial),
        "content-range": `bytes 0-${Buffer.byteLength(partial) - 1}/${Buffer.byteLength(partial) * 2}`,
        etag: "\"partial\"",
        "accept-ranges": "bytes",
      });
      response.end(partial);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const { info } = await startGateway({ compression: "body" });
    const headers = {
      authorization: `Bearer ${info.token}`,
      "accept-encoding": "br, gzip",
    };

    const notModified = await requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${address.port}/not-modified`,
      { headers },
    );
    expect(notModified.status).toBe(304);
    expect(notModified.rawBody.byteLength).toBe(0);
    expect(notModified.headers["content-length"]).toBe("4096");
    // RFC 9110 requires a 304 to carry the ETag a 200 would have sent, and the
    // gateway transforms nothing here, so identity-representation metadata is
    // preserved. Only the content-coded digests are dropped.
    expect(notModified.headers.etag).toBe("\"cached\"");
    expect(notModified.headers["accept-ranges"]).toBe("bytes");
    expect(notModified.headers["repr-digest"]).toBe("sha-256=:identity:");
    expect(notModified.headers.digest).toBe("sha-256=identity");
    expect(notModified.headers["content-md5"]).toBeUndefined();
    expect(notModified.headers["content-digest"]).toBeUndefined();
    expect(notModified.headers["content-encoding"]).toBeUndefined();
    expect(notModified.headers.vary).toContain("Accept-Encoding");

    const ranged = await requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${address.port}/range`,
      { headers },
    );
    expect(ranged.status).toBe(206);
    expect(ranged.body).toBe(partial);
    expect(ranged.headers["content-length"]).toBe(String(Buffer.byteLength(partial)));
    expect(ranged.headers["content-range"]).toBe(
      `bytes 0-${Buffer.byteLength(partial) - 1}/${Buffer.byteLength(partial) * 2}`,
    );
    expect(ranged.headers.etag).toBe("\"partial\"");
    expect(ranged.headers["accept-ranges"]).toBe("bytes");
    expect(ranged.headers["content-encoding"]).toBeUndefined();
    expect(ranged.headers.vary).toContain("Accept-Encoding");
  });



  test("streams identity when all proxy buffer reservations are occupied and reuses released slots", async () => {
    const body = "buffer admission ".repeat(128);
    const parkedResponses: ServerResponse[] = [];
    let parkResponses = true;
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      if (!parkResponses) {
        response.end(body);
        return;
      }
      response.write(body.slice(0, Math.floor(body.length / 2)));
      parkedResponses.push(response);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const { info } = await startGateway({ compression: "body" });
    const endpoint = new URL(
      `${info.url}__orkestrator/proxy/loopback/${address.port}/parked`,
    );
    const openedHeaders: IncomingHttpHeaders[] = [];
    const startRequest = () => new Promise<{
      headers: IncomingHttpHeaders;
      rawBody: Buffer;
    }>((resolve, reject) => {
      const request = httpRequest({
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        headers: {
          authorization: `Bearer ${info.token}`,
          "accept-encoding": "gzip",
        },
      }, (response) => {
        openedHeaders.push(response.headers);
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("aborted", () => reject(new Error("Response aborted")));
        response.on("error", reject);
        response.on("end", () => resolve({
          headers: response.headers,
          rawBody: Buffer.concat(chunks),
        }));
      });
      request.on("error", reject);
      request.end();
    });
    // Every buffered body needs a codec slot from a separate pool of the same
    // size once it completes. Assert the pool is idle up front so a slot leaked
    // by an earlier test fails here instead of silently flipping one of the
    // expected gzip responses to identity.
    expect(activeDynamicCompressionCount()).toBe(0);
    expect(dynamicProxyCompressionBufferSnapshot()).toEqual({ activeCount: 0, activeBytes: 0 });

    const completed = Array.from(
      { length: MAX_CONCURRENT_DYNAMIC_COMPRESSIONS + 1 },
      () => startRequest(),
    );
    await waitUntil(
      () => parkedResponses.length === MAX_CONCURRENT_DYNAMIC_COMPRESSIONS + 1,
      "Proxy targets did not all reach the parked state",
    );
    await waitUntil(
      () => openedHeaders.length === 1,
      "Overflow proxy response did not begin streaming identity",
    );
    expect(openedHeaders[0]?.["content-encoding"]).toBeUndefined();
    // The reserved byte total must be the sum of the declared Content-Lengths,
    // which is what proves the admission call is wired to the declared size
    // rather than to some other eligible constant.
    expect(dynamicProxyCompressionBufferSnapshot()).toEqual({
      activeCount: MAX_CONCURRENT_DYNAMIC_COMPRESSIONS,
      activeBytes: MAX_CONCURRENT_DYNAMIC_COMPRESSIONS * Buffer.byteLength(body),
    });

    for (const response of parkedResponses) {
      response.end(body.slice(Math.floor(body.length / 2)));
    }
    const results = await Promise.all(completed);
    expect(results.filter((result) => result.headers["content-encoding"] === "gzip")).toHaveLength(
      MAX_CONCURRENT_DYNAMIC_COMPRESSIONS,
    );
    expect(results.filter((result) => result.headers["content-encoding"] === undefined)).toHaveLength(1);

    parkResponses = false;
    const recovered = await requestUrl(endpoint.toString(), {
      headers: {
        authorization: `Bearer ${info.token}`,
        "accept-encoding": "gzip",
      },
    });
    expect(recovered.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(recovered)).toBe(body);
    await waitUntil(
      () => dynamicProxyCompressionBufferSnapshot().activeCount === 0,
      "Proxy buffer reservations were not all returned",
    );
    expect(dynamicProxyCompressionBufferSnapshot()).toEqual({ activeCount: 0, activeBytes: 0 });
  });



  test("aborts a buffered proxy body that stalls and returns its reservation", async () => {
    const recoveryBody = "stall recovery ".repeat(256);
    const stalled: ServerResponse[] = [];
    const target = createServer((request, response) => {
      if (request.url === "/recovery") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(recoveryBody),
        });
        response.end(recoveryBody);
        return;
      }
      // Headers and a first chunk arrive, then the upstream goes silent forever.
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": 8192,
      });
      response.write("partial");
      stalled.push(response);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const { info } = await startGateway({
      compression: "body",
      proxyBodyIdleTimeoutMs: 150,
    });
    const headers = {
      authorization: `Bearer ${info.token}`,
      "accept-encoding": "gzip",
    };
    const endpoint = (path: string) => (
      `${info.url}__orkestrator/proxy/loopback/${address.port}${path}`
    );

    const stalledResult = await requestUrl(endpoint("/stall"), { headers });
    expect(stalledResult.status).toBe(502);
    expect(stalledResult.body).toContain("stalled for 150 ms");
    expect(stalled).toHaveLength(1);

    // The stalled request must not have left its slot or its bytes behind.
    await waitUntil(
      () => dynamicProxyCompressionBufferSnapshot().activeCount === 0,
      "Stalled proxy body did not release its reservation",
    );
    expect(dynamicProxyCompressionBufferSnapshot()).toEqual({ activeCount: 0, activeBytes: 0 });

    const recovery = await requestUrl(endpoint("/recovery"), { headers });
    expect(recovery.status).toBe(200);
    expect(recovery.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(recovery)).toBe(recoveryBody);
  });



  test("keeps a slow but progressing proxy body alive past the idle timeout", async () => {
    const chunk = "slow drip ".repeat(64);
    const chunkCount = 6;
    const body = chunk.repeat(chunkCount);
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      let written = 0;
      // Each gap is under the idle timeout but the total run is well over it,
      // so this only succeeds if every chunk rearms the timer.
      const writeNext = () => {
        response.write(chunk);
        written += 1;
        if (written === chunkCount) {
          response.end();
          return;
        }
        setTimeout(writeNext, 40);
      };
      setTimeout(writeNext, 40);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const { info } = await startGateway({
      compression: "body",
      proxyBodyIdleTimeoutMs: 120,
    });

    const result = await requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${address.port}/slow`,
      {
        headers: {
          authorization: `Bearer ${info.token}`,
          "accept-encoding": "gzip",
        },
      },
    );
    expect(result.status).toBe(200);
    expect(result.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(result)).toBe(body);
    expect(dynamicProxyCompressionBufferSnapshot()).toEqual({ activeCount: 0, activeBytes: 0 });
  });



  test("streams ineligible proxy bodies as identity without changing their metadata", async () => {
    const large = "identity proxy ".repeat(256);
    const small = "small identity";
    const target = createServer((request, response) => {
      if (request.url === "/no-transform") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(large),
          "cache-control": "public, No-Transform",
          etag: "\"no-transform\"",
        });
        response.end(large);
        return;
      }
      if (request.url === "/head") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(large),
          etag: "\"head\"",
          "content-md5": "identity-md5",
          "content-digest": "sha-256=:identity:",
          "repr-digest": "sha-256=:identity:",
          digest: "sha-256=identity",
          "accept-ranges": "bytes",
        });
        response.end(large);
        return;
      }
      if (request.url === "/chunked") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          etag: "\"chunked\"",
        });
        response.write(large.slice(0, 100));
        response.end(large.slice(100));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(small),
        etag: "\"small\"",
      });
      response.end(small);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const { info } = await startGateway({ compression: "body" });
    const headers = {
      authorization: `Bearer ${info.token}`,
      "accept-encoding": "gzip",
    };
    const endpoint = (path: string) => (
      `${info.url}__orkestrator/proxy/loopback/${address.port}${path}`
    );

    const noTransform = await requestUrl(endpoint("/no-transform"), { headers });
    expect(noTransform.body).toBe(large);
    expect(noTransform.headers["content-encoding"]).toBeUndefined();
    expect(noTransform.headers["content-length"]).toBe(String(Buffer.byteLength(large)));
    expect(noTransform.headers.etag).toBe("\"no-transform\"");
    expect(noTransform.headers.vary).toBeUndefined();

    const head = await requestUrl(endpoint("/head"), { method: "HEAD", headers });
    expect(head.rawBody.byteLength).toBe(0);
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(large)));
    expect(head.headers["content-encoding"]).toBeUndefined();
    // The gateway transforms nothing for a HEAD, so the identity metadata it
    // reports stays internally consistent with the identity Content-Length it
    // also reports. Accept-Ranges is honest because ranged GETs are passed
    // through untransformed.
    expect(head.headers.etag).toBe("\"head\"");
    expect(head.headers["accept-ranges"]).toBe("bytes");
    expect(head.headers["repr-digest"]).toBe("sha-256=:identity:");
    expect(head.headers.digest).toBe("sha-256=identity");
    // Both of these are defined over the content-coded bytes, which a
    // corresponding GET may well have compressed.
    expect(head.headers["content-md5"]).toBeUndefined();
    expect(head.headers["content-digest"]).toBeUndefined();
    expect(head.headers.vary).toContain("Accept-Encoding");

    const chunked = await requestUrl(endpoint("/chunked"), { headers });
    expect(chunked.body).toBe(large);
    expect(chunked.headers["content-encoding"]).toBeUndefined();
    expect(chunked.headers.etag).toBe("\"chunked\"");
    expect(chunked.headers.vary).toContain("Accept-Encoding");

    const belowThreshold = await requestUrl(endpoint("/small"), { headers });
    expect(belowThreshold.body).toBe(small);
    expect(belowThreshold.headers["content-encoding"]).toBeUndefined();
    expect(belowThreshold.headers.etag).toBe("\"small\"");
    expect(belowThreshold.headers.vary).toContain("Accept-Encoding");
  });



  test("returns 502 and releases admission when an eligible buffered proxy body aborts", async () => {
    const recoveryBody = "recovered ".repeat(512);
    const target = createServer((request, response) => {
      if (request.url === "/recovery") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(recoveryBody),
        });
        response.end(recoveryBody);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": 4096,
      });
      response.write("partial");
      setTimeout(() => response.socket?.destroy(), 10);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const { info } = await startGateway({ compression: "body" });
    const endpoint = `${info.url}__orkestrator/proxy/loopback/${address.port}/buffered-abort`;
    const headers = {
      authorization: `Bearer ${info.token}`,
      "accept-encoding": "gzip",
    };

    const aborted = await requestUrl(endpoint, { headers });
    expect(aborted.status).toBe(502);
    expect(aborted.body).toContain("aborted");

    const recovery = await requestUrl(endpoint.replace("buffered-abort", "recovery"), { headers });
    expect(recovery.status).toBe(200);
    expect(recovery.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(recovery)).toBe(recoveryBody);
  });



  test("releases a proxy buffer reservation when the downstream disconnects while buffering", async () => {
    // Abruptly dropping a socket connected to Bun's in-process test server can
    // wedge the runner, so exercise the full disconnect lifecycle in a child.
    // All eight admission slots are occupied first: the recovery response can
    // be compressed only if the disconnected request releases its reservation.
    const dataDir = await createTempDir("ork-gateway-buffer-disconnect-");
    const rendererRoot = await createRendererRoot(dataDir);
    const scriptPath = path.join(dataDir, "buffer-disconnect-scenario.ts");
    const gatewayModule = path.resolve(import.meta.dir, "../../../apps/backend/src/gateway.ts");
    await writeFile(scriptPath, `
      import { createServer, request as httpRequest } from "node:http";
      import { connect } from "node:net";
      import { OrkestratorGateway } from ${JSON.stringify(gatewayModule)};

      const failTimer = setTimeout(() => {
        console.log("TIMED_OUT");
        process.exit(1);
      }, 8000);
      const recoveryBody = "disconnect recovery ".repeat(256);
      let parked = 0;
      let closed = 0;
      const target = createServer((request, response) => {
        if (request.url === "/recovery") {
          response.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-length": Buffer.byteLength(recoveryBody),
          });
          response.end(recoveryBody);
          return;
        }
        parked += 1;
        request.socket.once("close", () => {
          closed += 1;
        });
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": 4096,
        });
        response.write("partial");
      });
      await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
      const targetPort = target.address().port;

      const gateway = new OrkestratorGateway({
        backend: { invoke: async () => null },
        dataDir: ${JSON.stringify(dataDir)},
        rendererRoot: ${JSON.stringify(rendererRoot)},
        bindAddress: "127.0.0.1",
        port: 0,
        compression: "body",
        env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        allowNonTailscaleBind: true,
      });
      const info = await gateway.start();
      if (!info) throw new Error("Gateway did not start");
      const gatewayUrl = new URL(info.url);
      const sockets = Array.from({ length: 8 }, (_, index) => {
        const socket = connect({
          host: gatewayUrl.hostname,
          port: Number(gatewayUrl.port),
        }, () => {
          socket.write([
            "GET /__orkestrator/proxy/loopback/" + targetPort + "/park/" + index + " HTTP/1.1",
            "Host: " + gatewayUrl.host,
            "Authorization: Bearer " + info.token,
            "Accept-Encoding: gzip",
            "",
            "",
          ].join("\\r\\n"));
        });
        socket.on("error", () => undefined);
        return socket;
      });

      while (parked < 8) await Bun.sleep(5);
      sockets[0].destroy();
      while (closed < 1) await Bun.sleep(5);

      const encoding = await new Promise((resolve, reject) => {
        const request = httpRequest({
          hostname: gatewayUrl.hostname,
          port: Number(gatewayUrl.port),
          path: "/__orkestrator/proxy/loopback/" + targetPort + "/recovery",
          headers: {
            authorization: "Bearer " + info.token,
            "accept-encoding": "gzip",
          },
        }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.headers["content-encoding"]));
        });
        request.once("error", reject);
        request.end();
      });

      if (encoding !== "gzip") {
        console.log("RECOVERY_ENCODING=" + String(encoding));
        process.exit(1);
      }
      clearTimeout(failTimer);
      console.log("RESERVATION_RELEASED");
      process.exit(0);
    `);

    const scenario = Bun.spawn([process.execPath, scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      scenario.exited,
      new Response(scenario.stdout).text(),
      new Response(scenario.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout).toContain("RESERVATION_RELEASED");
    expect(exitCode).toBe(0);
  });



  test("does not double encode an already encoded proxy response", async () => {
    const body = Buffer.from("already encoded ".repeat(512));
    const encoded = gzipSync(body);
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": encoded.byteLength,
      });
      response.end(encoded);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway({ compression: "on" });
    const result = await requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${address.port}/encoded`,
      {
        headers: {
          authorization: `Bearer ${info.token}`,
          "accept-encoding": "br, gzip",
        },
      },
    );
    expect(result.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(result.rawBody)).toEqual(body);
  });



  test("terminates the downstream response when an upstream proxy aborts after headers", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      setTimeout(() => response.socket?.destroy(), 10);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    await expect(requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${targetAddress.port}/aborted`,
      { headers: { authorization: `Bearer ${info.token}` } },
    )).rejects.toThrow("Response aborted");
  });



  test("rewrites loopback proxy redirects and target cookies into the proxy namespace", async () => {
    const target = createServer((request, response) => {
      if (request.url === "/relative") {
        response.writeHead(302, { location: "/next" });
        response.end();
        return;
      }
      if (request.url === "/absolute") {
        const address = target.address();
        if (!address || typeof address !== "object") throw new Error("Target server did not bind");
        response.writeHead(302, { location: `http://127.0.0.1:${address.port}/next?x=1` });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "Access-Control-Allow-Credentials": "true",
        "set-cookie": [
          "app_session=abc123; Path=/; HttpOnly",
          "orkestrator_gateway_auth=evil; Path=/",
        ],
      });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const proxyPrefix = `/__orkestrator/proxy/loopback/${targetAddress.port}`;

    try {
      const cookieResponse = await requestUrl(`${info.url}${proxyPrefix}/cookies`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(cookieResponse.status).toBe(200);
      expect(cookieResponse.headers["set-cookie"]).toEqual([
        `app_session=abc123; Path=${proxyPrefix}/; HttpOnly`,
      ]);
      // A proxied service must not be able to inject its own CORS policy.
      expect(cookieResponse.headers["access-control-allow-origin"]).toBeUndefined();
      expect(cookieResponse.headers["access-control-allow-credentials"]).toBeUndefined();

      const relativeRedirect = await requestUrl(`${info.url}${proxyPrefix}/relative`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(relativeRedirect.status).toBe(302);
      expect(relativeRedirect.headers.location).toBe(`${proxyPrefix}/next`);

      const absoluteRedirect = await requestUrl(`${info.url}${proxyPrefix}/absolute`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(absoluteRedirect.status).toBe(302);
      expect(absoluteRedirect.headers.location).toBe(`${proxyPrefix}/next?x=1`);
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });



  test("rejects preview text whose rewritten form exceeds the output limit", async () => {
    let source = "";
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(source),
      });
      response.end(source);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const unit = '<img src="/a">';
    source = unit.repeat(Math.floor((3 * 1024 * 1024) / Buffer.byteLength(unit)));
    expect(Buffer.byteLength(source)).toBeLessThan(8 * 1024 * 1024);

    const { info } = await startGateway({ compression: "body" });
    const result = await requestUrl(
      `${info.url}__orkestrator/browser/loopback/${address.port}/large.html`,
      {
        headers: {
          authorization: `Bearer ${info.token}`,
          origin: "null",
          "accept-encoding": "gzip",
        },
      },
    );
    expect(result.status).toBe(502);
    expect(result.body).toContain("exceeded 8388608 rewritten bytes");
    // Even the rejected-at-rewrite path must hand its decoded bytes back.
    await waitUntil(
      () => browserPreviewDecodeSnapshot().activeBytes === 0,
      "Rejected preview rewrite did not release its decoded bytes",
    );
  });



  test("returns decoded preview bytes to the shared budget on success and failure", async () => {
    const html = "<a href=\"/page\">link</a>".repeat(64);
    const target = createServer((request, response) => {
      if (request.url === "/abort.html") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html) * 2,
        });
        response.write(html);
        setTimeout(() => response.socket?.destroy(), 10);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
      });
      response.end(html);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const { info } = await startGateway({ compression: "body" });
    const headers = {
      authorization: `Bearer ${info.token}`,
      origin: "null",
      "accept-encoding": "gzip",
    };
    const endpoint = (path: string) => (
      `${info.url}__orkestrator/browser/loopback/${address.port}${path}`
    );

    expect(browserPreviewDecodeSnapshot()).toEqual({ activeBytes: 0 });
    // The aggregate ceiling has to leave room for real preview traffic; a single
    // per-request limit's worth must be a small fraction of it.
    expect(MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES).toBeGreaterThan(8 * 1024 * 1024);

    const rewritten = await requestUrl(endpoint("/ok.html"), { headers });
    expect(rewritten.status).toBe(200);
    expect(decodeResponseBody(rewritten)).toContain(
      `/__orkestrator/browser/loopback/${address.port}/page`,
    );
    await waitUntil(
      () => browserPreviewDecodeSnapshot().activeBytes === 0,
      "Successful preview did not release its decoded bytes",
    );

    const aborted = await requestUrl(endpoint("/abort.html"), { headers });
    expect(aborted.status).toBe(502);
    await waitUntil(
      () => browserPreviewDecodeSnapshot().activeBytes === 0,
      "Aborted preview did not release its decoded bytes",
    );

    // A budget that never returned bytes would eventually refuse everything, so
    // prove the path still works after both a success and a failure.
    const afterRecovery = await requestUrl(endpoint("/again.html"), { headers });
    expect(afterRecovery.status).toBe(200);
    expect(browserPreviewDecodeSnapshot()).toEqual({ activeBytes: 0 });
  });



  test("allows null-origin browser preview preflights and forwards non-simple requests", async () => {
    const received = mock(() => undefined);
    const target = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        received(request.method, request.url, request.headers["x-preview-test"], Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const targetUrl = `${info.url}__orkestrator/browser/loopback/${targetAddress.port}/api`;
    const preflight = await requestUrl(targetUrl, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-preview-test",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("null");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(preflight.headers["access-control-allow-headers"]).toBe("content-type, x-preview-test");
    expect(received).not.toHaveBeenCalled();

    const proxied = await requestUrl(targetUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info.token}`,
        origin: "null",
        "content-type": "application/json",
        "x-preview-test": "forwarded",
      },
      body: '{"message":"hello"}',
    });
    expect(proxied.status).toBe(200);
    expect(proxied.json()).toEqual({ ok: true });
    expect(proxied.headers["access-control-allow-origin"]).toBe("null");
    expect(proxied.headers["access-control-allow-credentials"]).toBe("true");
    expect(received).toHaveBeenCalledWith("POST", "/api", "forwarded", '{"message":"hello"}');
  });



  test("aborts oversized streaming preview bodies without waiting for upstream completion", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      const chunk = Buffer.alloc(1024 * 1024, 97);
      for (let index = 0; index < 9; index += 1) response.write(chunk);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const result = await requestUrl(`${info.url}__orkestrator/browser/loopback/${targetAddress.port}/large.js`, {
      headers: { authorization: `Bearer ${info.token}`, origin: "null" },
    });
    expect(result.status).toBe(502);
    expect(result.body).toContain("exceeded 8388608");
  });



  test("rejects preview text with an unsupported content encoding", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "zstd",
      });
      response.end("opaque");
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const result = await requestUrl(`${info.url}__orkestrator/browser/loopback/${targetAddress.port}/`, {
      headers: { authorization: `Bearer ${info.token}`, origin: "null" },
    });
    expect(result.status).toBe(502);
    expect(result.body).toContain("unsupported content encoding");
  });



  test("redirects preview-referred root requests back into their namespace", async () => {
    const { info } = await startGateway();
    const referer = `${info.url}__orkestrator/browser/loopback/3000/app`;

    const redirect = await requestUrl(`${info.url}api/status?probe=1`, {
      headers: { referer, origin: "null" },
    });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.location).toBe("/__orkestrator/browser/loopback/3000/api/status?probe=1");
    expect(redirect.headers["access-control-allow-origin"]).toBe("null");
    expect(redirect.headers["access-control-allow-credentials"]).toBe("true");
    expect(redirect.headers["cache-control"]).toBe("no-store");

    const preflight = await requestUrl(`${info.url}api/status`, {
      method: "OPTIONS",
      headers: {
        referer,
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("null");
    expect(preflight.headers["access-control-allow-headers"]).toBe("content-type");

    const unrelatedReferer = await requestUrl(`${info.url}api/status`, {
      headers: { referer: `${info.url}some/other/page` },
    });
    expect(unrelatedReferer.status).toBe(401);

    const malformedReferer = await requestUrl(`${info.url}api/status`, {
      headers: { referer: "not a url" },
    });
    expect(malformedReferer.status).toBe(401);
  });



  test("cancels the upstream request when the preview client disconnects", async () => {
    // Abruptly dropping an in-process connection to a Bun HTTP server wedges
    // the bun:test runner even after the scenario completes, so the whole
    // disconnect scenario runs in a subprocess and reports over stdout.
    const dataDir = await createTempDir("ork-gateway-disconnect-");
    const rendererRoot = await createRendererRoot(dataDir);
    const scriptPath = path.join(dataDir, "disconnect-scenario.ts");
    const gatewayModule = path.resolve(import.meta.dir, "../../../apps/backend/src/gateway.ts");
    await writeFile(scriptPath, `
      import { createServer } from "node:http";
      import { connect } from "node:net";
      import { OrkestratorGateway } from ${JSON.stringify(gatewayModule)};

      setTimeout(() => { console.log("TIMED_OUT"); process.exit(1); }, 8000);

      const target = createServer((request, response) => {
        request.socket.once("close", () => {
          console.log("UPSTREAM_CLOSED");
          process.exit(0);
        });
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write("streaming");
      });
      await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
      const targetPort = target.address().port;

      const gateway = new OrkestratorGateway({
        backend: { invoke: async () => null },
        dataDir: ${JSON.stringify(dataDir)},
        rendererRoot: ${JSON.stringify(rendererRoot)},
        bindAddress: "127.0.0.1",
        port: 0,
        env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        allowNonTailscaleBind: true,
      });
      const info = await gateway.start();
      if (!info) throw new Error("Gateway did not start");
      const gatewayUrl = new URL(info.url);

      const socket = connect({ host: gatewayUrl.hostname, port: Number(gatewayUrl.port) }, () => {
        socket.write([
          "GET /__orkestrator/browser/loopback/" + targetPort + "/stream HTTP/1.1",
          "Host: " + gatewayUrl.host,
          "Authorization: Bearer " + info.token,
          "",
          "",
        ].join("\\r\\n"));
      });
      socket.once("data", () => socket.destroy());
    `);

    const scenario = Bun.spawn([process.execPath, scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      scenario.exited,
      new Response(scenario.stdout).text(),
      new Response(scenario.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout).toContain("UPSTREAM_CLOSED");
    expect(exitCode).toBe(0);
  });



  test("serves renderer requests through a configured dev server proxy", async () => {
    const devServer = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`dev:${request.url}`);
    });
    await new Promise<void>((resolve) => devServer.listen(0, "127.0.0.1", resolve));
    const devAddress = devServer.address();
    if (!devAddress || typeof devAddress !== "object") throw new Error("Dev server did not bind");

    const dataDir = await createTempDir("ork-gateway-dev-");
    const rendererRoot = path.join(dataDir, "dist");
    await mkdir(rendererRoot);

    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      rendererDevServerUrl: `http://127.0.0.1:${devAddress.port}`,
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: { debug: mock(() => undefined), error: mock(() => undefined), info: mock(() => undefined), warn: mock(() => undefined) },
      allowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();

    try {
      const response = await requestUrl(`${info!.url}src/main.tsx?dev=1`, {
        headers: { authorization: `Bearer ${info!.token}` },
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe("dev:/src/main.tsx?dev=1");
    } finally {
      await new Promise<void>((resolve) => devServer.close(() => resolve()));
    }
  });



  test("stops promptly and disconnects an active streaming proxy response", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("streaming");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { gateway, info } = await startGateway();
    const request = httpRequest(`${info.url}__orkestrator/proxy/loopback/${targetAddress.port}/stream`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    let resolveResponseClosed: () => void = () => undefined;
    const responseClosed = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const responseStarted = new Promise<void>((resolve, reject) => {
      request.once("response", (response) => {
        response.once("close", resolveResponseClosed);
        response.once("data", () => resolve());
        response.once("error", reject);
      });
      request.once("error", reject);
    });
    request.end();

    try {
      await responseStarted;
      await Promise.race([
        gateway.stop(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Gateway stop timed out")), 1_000)),
      ]);
      await expect(responseClosed).resolves.toBeUndefined();
    } finally {
      request.destroy();
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

});
