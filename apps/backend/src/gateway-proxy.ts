import { GatewayHandlers } from "./gateway-handlers.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { pipeline, type Readable } from "node:stream";
import path from "node:path";
import { constants as zlibConstants, createGzip } from "node:zlib";
import { MAX_BROWSER_PREVIEW_BODY_BYTES, IMMUTABLE_ASSET_CACHE_CONTROL, REVALIDATED_DOCUMENT_CACHE_CONTROL, DYNAMIC_GZIP_LEVEL, MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES, SSE_COMPRESSION_CHUNK_BYTES, MAX_STATIC_FALLBACK_SOURCE_BYTES, normalizeContentEncoding, headerValueToString, mimeType, negotiateEncoding, appendHeadersVary, isCompressibleContentType, isCompressibleStaticContentType, isImmutableHashedAsset, httpDateFromMtimeMs, etagForStaticVariant, staticEncodingQuality, preferredStaticCompressionEncodings, compressedStaticSiblingPath, ifNoneMatchMatches, ifModifiedSinceMatches, isDynamicCompressionSizeEligible, canBufferBodyChunk, dynamicProxyCompressionBufferBudget, browserPreviewDecodeBudget, allocateBufferedProxySource, canAppendToProxySourceBuffer, shouldAbandonBufferedProxyBody, releaseReservationOnResponseSettled, compressStaticFileWithinLimits, responseCompressionContexts, prepareCompressedBody, settleRewrittenProxyBodyResponse, jsonResponse, textResponse, sanitizeTargetRequestHeaders, sanitizeProxyResponseHeaders, canTransformProxyRepresentation, parseStrictContentLengthHeader, stripCodedContentHeaders, stripTransformedRepresentationHeaders, browserPreviewContentKind, browserPreviewContentDecoder, rewriteBrowserPreviewBody } from "./gateway-internals.js";
import type { StaticContentEncoding } from "./gateway-internals.js";

export class GatewayProxy extends GatewayHandlers {
  protected async proxyToTarget(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    proxyPrefix?: string,
    browserPreview = false,
    stripOrigin = false,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      let activeProxyResponse: IncomingMessage | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        // Keep-alive sockets outlive individual requests; drop this
        // request's disconnect handler so they do not accumulate.
        request.socket.removeListener("close", cancelProxyForDisconnect);
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        if (!response.headersSent) {
          jsonResponse(response, 502, { error: error.message });
        } else {
          response.destroy(error);
        }
        finish();
      };
      const targetHeaders = sanitizeTargetRequestHeaders(request.headers, target, stripOrigin);
      // The gateway owns representation negotiation on the remote-facing hop.
      // Keeping the loopback hop decoded prevents double compression and lets
      // preview rewriting enforce its decoded-byte bound.
      targetHeaders["accept-encoding"] = "identity";
      const proxyRequest = http.request({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: targetHeaders,
      }, (proxyResponse) => {
        activeProxyResponse = proxyResponse;
        const responseHeaders = sanitizeProxyResponseHeaders(proxyResponse.headers, target, proxyPrefix);
        const responseStatus = proxyResponse.statusCode ?? 502;
        const contentRange = headerValueToString(proxyResponse.headers["content-range"]);
        const transformableRepresentation = canTransformProxyRepresentation(
          request.method,
          responseStatus,
          contentRange,
        );
        const compressionContext = responseCompressionContexts.get(response);
        const upstreamContentEncoding = headerValueToString(proxyResponse.headers["content-encoding"]);
        const upstreamIsIdentity = normalizeContentEncoding(upstreamContentEncoding) === "identity";
        const contentType = headerValueToString(proxyResponse.headers["content-type"]);
        const cacheControl = headerValueToString(proxyResponse.headers["cache-control"]);
        const transformAllowed = !cacheControl
          ?.toLowerCase()
          .split(",")
          .some((directive) => directive.trim() === "no-transform");
        if (browserPreview) {
          delete responseHeaders["x-frame-options"];
          delete responseHeaders["content-security-policy"];
          delete responseHeaders["content-security-policy-report-only"];
          if (request.headers.origin === "null") {
            responseHeaders["access-control-allow-origin"] = "null";
            responseHeaders["access-control-allow-credentials"] = "true";
            appendHeadersVary(responseHeaders, "Origin");
          } else {
            responseHeaders["access-control-allow-origin"] = "*";
          }
        }

        const previewContentKind = browserPreview && proxyPrefix && transformableRepresentation
          ? browserPreviewContentKind(proxyResponse.headers["content-type"])
          : null;
        if (browserPreview && proxyPrefix && previewContentKind) {
          const decoder = browserPreviewContentDecoder(proxyResponse.headers["content-encoding"]);
          if (decoder === undefined) {
            proxyResponse.destroy();
            fail(new Error("Browser preview response used an unsupported content encoding"));
            return;
          }

          const contentLengthHeader = proxyResponse.headers["content-length"];
          const contentLengthValue = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader;
          const contentLength = Number.parseInt(contentLengthValue ?? "", 10);
          if (Number.isFinite(contentLength) && contentLength > MAX_BROWSER_PREVIEW_BODY_BYTES) {
            proxyResponse.destroy();
            fail(new Error(`Browser preview response exceeded ${MAX_BROWSER_PREVIEW_BODY_BYTES} bytes`));
            return;
          }

          const chunks: Buffer[] = [];
          let sourceBytes = 0;
          let decodedBytes = 0;
          let bodySettled = false;
          // Decoded preview bodies have no declared size to reserve up front, so
          // the aggregate ceiling is charged per chunk and returned once the
          // downstream response settles — the point at which both the chunk list
          // and the rewritten copy become unreachable.
          let acquiredPreviewBytes = 0;
          let previewBytesReleased = false;
          const releasePreviewBytes = () => {
            previewBytesReleased = true;
            // Zero the running total rather than guarding on the flag alone, so
            // a second call releases nothing and any byte charged between two
            // calls is still returned by the later one.
            const outstanding = acquiredPreviewBytes;
            acquiredPreviewBytes = 0;
            browserPreviewDecodeBudget.release(outstanding);
          };
          releaseReservationOnResponseSettled(response, releasePreviewBytes);
          const bodyStream: Readable = decoder ? proxyResponse.pipe(decoder) : proxyResponse;
          const abortBody = (error: Error) => {
            if (bodySettled) return;
            bodySettled = true;
            releasePreviewBytes();
            decoder?.destroy();
            proxyResponse.destroy();
            fail(error);
          };

          if (decoder) {
            proxyResponse.on("data", (chunk: Buffer | string) => {
              sourceBytes += Buffer.byteLength(chunk);
              if (sourceBytes > MAX_BROWSER_PREVIEW_BODY_BYTES) {
                abortBody(new Error(`Browser preview response exceeded ${MAX_BROWSER_PREVIEW_BODY_BYTES} bytes`));
              }
            });
            decoder.once("error", (error) => abortBody(error));
          }

          bodyStream.on("data", (chunk: Buffer | string) => {
            // A decoder can emit buffered output after the downstream response
            // has gone; charging the shared budget then would strand bytes that
            // nothing is left to release.
            if (bodySettled || previewBytesReleased) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (!canBufferBodyChunk(
              decodedBytes,
              chunks.length,
              buffer.byteLength,
              MAX_BROWSER_PREVIEW_BODY_BYTES,
            )) {
              abortBody(new Error(`Browser preview response exceeded ${MAX_BROWSER_PREVIEW_BODY_BYTES} decoded bytes`));
              return;
            }
            if (!browserPreviewDecodeBudget.tryAcquire(buffer.byteLength)) {
              abortBody(new Error(
                `Browser preview decoding exceeded the shared ${MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES} byte budget`,
              ));
              return;
            }
            acquiredPreviewBytes += buffer.byteLength;
            decodedBytes += buffer.byteLength;
            chunks.push(buffer);
          });
          bodyStream.once("end", () => {
            if (bodySettled) return;
            const rewritten = Buffer.from(rewriteBrowserPreviewBody(
              Buffer.concat(chunks).toString("utf8"),
              proxyPrefix,
              target,
              previewContentKind,
            ));
            if (rewritten.byteLength > MAX_BROWSER_PREVIEW_BODY_BYTES) {
              bodySettled = true;
              releasePreviewBytes();
              decoder?.destroy();
              proxyResponse.destroy();
              fail(new Error(`Browser preview response exceeded ${MAX_BROWSER_PREVIEW_BODY_BYTES} rewritten bytes`));
              return;
            }
            bodySettled = true;
            delete responseHeaders["content-encoding"];
            stripTransformedRepresentationHeaders(responseHeaders);
            settleRewrittenProxyBodyResponse(
              response,
              proxyResponse.statusCode ?? 502,
              responseHeaders,
              prepareCompressedBody(
                rewritten,
                contentType,
                compressionContext,
              ),
              () => settled,
              finish,
              fail,
            );
          });
          proxyResponse.once("error", (error) => abortBody(error));
          proxyResponse.once("aborted", () => abortBody(new Error("Browser preview response was aborted")));
          return;
        }

        const isEventStream = contentType
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() === "text/event-stream";
        const contentLengthValue = headerValueToString(proxyResponse.headers["content-length"]);
        const contentLength = parseStrictContentLengthHeader(contentLengthValue);
        const canTransform = upstreamIsIdentity
          && transformAllowed
          && compressionContext?.mode !== undefined
          && compressionContext.mode !== "off";
        const canTransformBody = canTransform && transformableRepresentation;
        const bodylessMetadataCouldDescribeCodedBytes = canTransform
          && (request.method === "HEAD" || responseStatus === 304)
          && !isEventStream
          && isCompressibleContentType(contentType)
          && contentLength !== null
          && isDynamicCompressionSizeEligible(contentLength)
          && negotiateEncoding(compressionContext.acceptEncoding) !== "identity";
        if (bodylessMetadataCouldDescribeCodedBytes) {
          // Nothing is transformed here, so the response keeps the metadata that
          // describes the identity representation its retained Content-Length
          // already describes — including `ETag`, which RFC 9110 requires a 304
          // to carry, and `Accept-Ranges`, because ranged GETs are passed
          // through untransformed (see canTransformProxyRepresentation). Only
          // the content-coded digests are dropped: a corresponding GET may
          // select a coded representation those values cannot describe.
          stripCodedContentHeaders(responseHeaders);
        }

        if (canTransformBody && isEventStream && compressionContext.mode === "on") {
          appendHeadersVary(responseHeaders, "Accept-Encoding");
          if (
            negotiateEncoding(
              compressionContext.acceptEncoding,
              ["gzip", "identity"],
            ) === "gzip"
          ) {
            delete responseHeaders["content-length"];
            stripTransformedRepresentationHeaders(responseHeaders);
            responseHeaders["content-encoding"] = "gzip";
            response.writeHead(responseStatus, responseHeaders);
            const compressor = createGzip({
              level: DYNAMIC_GZIP_LEVEL,
              flush: zlibConstants.Z_SYNC_FLUSH,
              finishFlush: zlibConstants.Z_SYNC_FLUSH,
              chunkSize: SSE_COMPRESSION_CHUNK_BYTES,
            });
            const destroyCompressor = () => compressor.destroy();
            response.once("close", destroyCompressor);
            pipeline(proxyResponse, compressor, response, (error) => {
              response.removeListener("close", destroyCompressor);
              if (error) {
                proxyRequest.destroy(error);
                fail(error);
                return;
              }
              finish();
            });
            return;
          }
        }

        const shouldBufferBody = canTransformBody
          && !isEventStream
          && isCompressibleContentType(contentType)
          && contentLength !== null
          && isDynamicCompressionSizeEligible(contentLength);

        if (canTransform && !isEventStream && isCompressibleContentType(contentType)) {
          appendHeadersVary(responseHeaders, "Accept-Encoding");
        }

        const releaseBufferReservation = shouldBufferBody
          ? dynamicProxyCompressionBufferBudget.tryReserve(contentLength!)
          : null;
        if (releaseBufferReservation) {
          // The declared length is validated before admission, and the aggregate
          // budget is reserved before allocating. A single contiguous source
          // buffer avoids retaining a chunk list and then duplicating it with
          // Buffer.concat while the codec is running.
          const sourceBuffer = allocateBufferedProxySource(contentLength!);
          if (!sourceBuffer) {
            releaseBufferReservation();
            proxyResponse.destroy();
            fail(new Error(`Could not allocate ${contentLength!} bytes for the proxied response`));
            return;
          }
          let bytes = 0;
          let bodySettled = false;
          let reservationReleased = false;
          let reservationOwnedByResponse = false;
          let idleTimer: ReturnType<typeof setTimeout> | null = null;
          const clearIdleTimer = () => {
            if (!idleTimer) return;
            clearTimeout(idleTimer);
            idleTimer = null;
          };
          const releaseReservation = () => {
            if (reservationReleased) return;
            reservationReleased = true;
            releaseBufferReservation();
          };
          const releaseWhileBuffering = () => {
            if (bodySettled) return;
            bodySettled = true;
            clearIdleTimer();
            releaseReservation();
          };
          response.once("close", releaseWhileBuffering);
          const abortBody = (error: Error) => {
            if (bodySettled) return;
            bodySettled = true;
            clearIdleTimer();
            response.removeListener("close", releaseWhileBuffering);
            releaseReservation();
            proxyResponse.destroy();
            fail(error);
          };
          // Reset on every chunk: a slow upstream is fine, a silent one is not.
          // Without this the reservation would be held until the downstream
          // client gave up, starving every other proxied response of a slot.
          const idleTimeoutMs = this.proxyBodyIdleTimeoutMs;
          const armIdleTimer = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => {
              idleTimer = null;
              abortBody(new Error(`Proxied response stalled for ${idleTimeoutMs} ms`));
            }, idleTimeoutMs);
            idleTimer.unref?.();
          };
          armIdleTimer();
          proxyResponse.on("data", (chunk: Buffer | string) => {
            if (bodySettled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (!canAppendToProxySourceBuffer(bytes, buffer.byteLength, sourceBuffer.byteLength)) {
              abortBody(new Error(
                `Proxied response exceeded its declared ${sourceBuffer.byteLength} bytes`,
              ));
              return;
            }
            buffer.copy(sourceBuffer, bytes);
            bytes += buffer.byteLength;
            armIdleTimer();
          });
          proxyResponse.once("end", () => {
            if (bodySettled) return;
            bodySettled = true;
            clearIdleTimer();
            response.removeListener("close", releaseWhileBuffering);
            if (shouldAbandonBufferedProxyBody(reservationReleased, settled, response.destroyed)) {
              releaseReservation();
              // Nothing downstream is left to write to, so resolve the proxy
              // promise here rather than depending on a close event that may
              // already have been consumed.
              finish();
              return;
            }
            const source = sourceBuffer.subarray(0, bytes);
            void prepareCompressedBody(
              source,
              contentType,
              compressionContext,
              upstreamContentEncoding,
            ).then((prepared) => {
              if (settled || response.destroyed) {
                // The client left while the codec ran. The upstream has already
                // ended, so settle here instead of waiting on a close event.
                finish();
                return;
              }
              responseHeaders["content-length"] = prepared.body.byteLength;
              if (prepared.encoding === "identity") {
                delete responseHeaders["content-encoding"];
              } else {
                responseHeaders["content-encoding"] = prepared.encoding;
                stripTransformedRepresentationHeaders(responseHeaders);
              }
              reservationOwnedByResponse = true;
              releaseReservationOnResponseSettled(response, releaseReservation);
              response.writeHead(responseStatus, responseHeaders);
              response.end(prepared.body);
              finish();
            }).catch((error: unknown) => {
              fail(error instanceof Error ? error : new Error(String(error)));
            }).finally(() => {
              if (!reservationOwnedByResponse) releaseReservation();
            });
          });
          proxyResponse.once("error", (error) => abortBody(error));
          proxyResponse.once("aborted", () => abortBody(new Error("Proxied response was aborted")));
          return;
        }

        response.writeHead(responseStatus, responseHeaders);
        pipeline(proxyResponse, response, (error) => {
          if (error) {
            proxyRequest.destroy(error);
            fail(error);
            return;
          }
          finish();
        });
      });
      this.proxyRequests.add(proxyRequest);
      proxyRequest.once("close", () => {
        this.proxyRequests.delete(proxyRequest);
      });

      proxyRequest.once("error", fail);

      const cancelProxyForDisconnect = () => {
        if (!settled && !response.writableFinished) {
          const disconnectError = new Error("Proxy client disconnected");
          this.logger.debug("[RemoteGateway] Proxy client disconnected; aborting upstream request");
          // Settle first: destroying the response re-enters this handler via
          // its own "close" event, and a throwing destroy must not leave the
          // proxy promise dangling.
          finish();
          activeProxyResponse?.socket.destroy(disconnectError);
          activeProxyResponse?.destroy(disconnectError);
          proxyRequest.socket?.destroy(disconnectError);
          proxyRequest.destroy(disconnectError);
          response.destroy(disconnectError);
        }
      };
      // "close" fires for premature client disconnects as well as normal
      // completion; the settled/writableFinished guard makes the latter a
      // no-op. The socket listener is required (response "close" alone is not
      // reliably emitted on abrupt disconnects) and is removed in finish().
      request.socket.once("close", cancelProxyForDisconnect);
      response.once("close", cancelProxyForDisconnect);

      // Piping an already-ended request stream suppresses client-socket
      // close events under Bun, which would leave disconnected proxy
      // requests streaming forever; only pipe when a body can exist.
      const hasRequestBody = request.headers["content-length"] !== undefined
        || request.headers["transfer-encoding"] !== undefined;
      if (hasRequestBody) {
        request.pipe(proxyRequest);
      } else {
        proxyRequest.end();
      }
    });
  }

  protected async serveStatic(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    allowCompression: boolean,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }

    if (this.rendererDevServerUrl) {
      const target = new URL(this.rendererDevServerUrl);
      target.pathname = url.pathname;
      target.search = url.search;
      await this.proxyToTarget(request, response, target);
      return;
    }

    const root = path.resolve(this.rendererRoot);
    const decodedPath = decodeURIComponent(url.pathname);
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    let filePath = path.resolve(root, relativePath);

    if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
      textResponse(response, 403, "Forbidden");
      return;
    }

    let fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.isDirectory()) {
      if (path.extname(relativePath)) {
        textResponse(response, 404, "Not found");
        return;
      }
      filePath = path.join(root, "index.html");
      fileStat = await stat(filePath).catch(() => null);
    }

    if (!fileStat?.isFile()) {
      textResponse(response, 404, "Renderer build not found");
      return;
    }

    const contentType = mimeType(filePath);
    const lastModified = httpDateFromMtimeMs(fileStat.mtimeMs);
    const cacheControl = isImmutableHashedAsset(url.pathname, filePath)
      ? IMMUTABLE_ASSET_CACHE_CONTROL
      : REVALIDATED_DOCUMENT_CACHE_CONTROL;
    const acceptEncoding = headerValueToString(request.headers["accept-encoding"]);
    const preferredEncodings = allowCompression && isCompressibleStaticContentType(contentType)
      ? preferredStaticCompressionEncodings(acceptEncoding)
      : [];
    const identityQuality = allowCompression
      ? staticEncodingQuality(acceptEncoding, "identity")
      : 1;
    let selectedEncoding: StaticContentEncoding = "identity";
    let bodyPath = filePath;
    let bodyLength = fileStat.size;
    let bodyBuffer: Buffer | null = null;
    let omitContentLength = false;
    let variantMtimeMs = fileStat.mtimeMs;
    let variantSize = fileStat.size;

    for (const encoding of preferredEncodings) {
      const siblingPath = compressedStaticSiblingPath(filePath, encoding);
      const siblingStat = await stat(siblingPath).catch(() => null);
      if (
        siblingStat?.isFile()
        && siblingStat.mtimeMs >= fileStat.mtimeMs
        && siblingStat.size < fileStat.size
      ) {
        selectedEncoding = encoding;
        bodyPath = siblingPath;
        bodyLength = siblingStat.size;
        variantMtimeMs = siblingStat.mtimeMs;
        variantSize = siblingStat.size;
        break;
      }
    }

    if (selectedEncoding === "identity" && request.method !== "HEAD") {
      const outcome = await compressStaticFileWithinLimits(
        filePath,
        fileStat.mtimeMs,
        fileStat.size,
        preferredEncodings,
        identityQuality <= 0,
      );
      if (outcome.status === "compressed") {
        selectedEncoding = outcome.encoding;
        bodyLength = outcome.buffer.byteLength;
        bodyBuffer = outcome.buffer;
      }
    }

    if (
      selectedEncoding === "identity"
      && request.method === "HEAD"
      && identityQuality <= 0
      && preferredEncodings[0]
      && fileStat.size <= MAX_STATIC_FALLBACK_SOURCE_BYTES
    ) {
      // Identity is forbidden, so GET necessarily answers with a coded form and
      // its encoding is known without generating the body. The coded length is
      // not, and HEAD must not pay that CPU/memory cost to learn it, so the one
      // field HTTP lets a HEAD omit is omitted. When identity *is* acceptable
      // the identity metadata below is already accurate for HEAD, so nothing is
      // withheld and the response stays usable for revalidation and sizing.
      selectedEncoding = preferredEncodings[0];
      omitContentLength = true;
    }

    if (selectedEncoding === "identity" && identityQuality <= 0) {
      if (preferredEncodings.length === 0) {
        response.writeHead(406, {
          "cache-control": "no-store",
          vary: "Accept-Encoding",
        });
        response.end();
        return;
      }
      // A coded representation was both acceptable and requested, but this
      // server declined to produce one (source over the fallback cap, the
      // compression pool saturated, or a codec failure). RFC 9110 §12.5.3
      // permits sending an unacceptable identity representation instead. A 406
      // here would claim the asset can never be represented acceptably, which
      // is false, and would make the status depend on unrelated load.
    }

    const headers: OutgoingHttpHeaders = {
      "cache-control": cacheControl,
      "content-type": contentType,
      "last-modified": lastModified,
      etag: etagForStaticVariant(
        fileStat.mtimeMs,
        fileStat.size,
        selectedEncoding,
        variantMtimeMs,
        variantSize,
      ),
    };
    if (!omitContentLength) headers["content-length"] = bodyLength;
    appendHeadersVary(headers, "Accept-Encoding");
    if (selectedEncoding !== "identity") {
      headers["content-encoding"] = selectedEncoding;
    }

    if (ifNoneMatchMatches(request.headers["if-none-match"], String(headers.etag))) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    if (
      request.headers["if-none-match"] === undefined
      && ifModifiedSinceMatches(request.headers["if-modified-since"], fileStat.mtimeMs)
    ) {
      response.writeHead(304, headers);
      response.end();
      return;
    }

    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      if (omitContentLength) response.flushHeaders();
      response.end();
      return;
    }
    if (bodyBuffer) {
      response.end(bodyBuffer);
      return;
    }
    const bodyStream = createReadStream(bodyPath);
    bodyStream.on("error", () => {
      // The framing was committed by writeHead above, so a read failure here
      // cannot be turned into an error status. Destroying the socket makes the
      // truncation visible to the client rather than letting it cache a short
      // body as a complete, immutable asset.
      bodyStream.destroy();
      response.destroy();
    });
    // pipe() only unpipes on client abort; it leaves the descriptor open until
    // GC. Close it eagerly so an aborting client cannot exhaust the table.
    response.on("close", () => bodyStream.destroy());
    bodyStream.pipe(response);
  }
}
