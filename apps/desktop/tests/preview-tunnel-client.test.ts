import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  encodePreviewTunnelFrame,
  parsePreviewTunnelClientFrame,
  PREVIEW_TUNNEL_SUBPROTOCOL,
} from "@orkestrator/protocol/preview-access";
import { PREVIEW_LIMITS } from "@orkestrator/protocol/preview-services";
import {
  acceptPreviewWebSocket,
  type PreviewWebSocket,
} from "@orkestrator/protocol/node/preview-websocket";

import { openPreviewTunnel, type PreviewTunnelStream } from "../electron/preview-tunnel-client";

describe("PreviewTunnelStream slow browser reader", () => {
  test.each([true, false])(
    "drains buffered response bytes on normal close (EOF: %s)",
    async (eof) => {
      let backend: PreviewWebSocket | undefined;
      const server = createServer();
      server.on("upgrade", (request, socket, head) => {
        backend =
          acceptPreviewWebSocket(request, socket, head, {
            protocol: PREVIEW_TUNNEL_SUBPROTOCOL,
            maxPayload: PREVIEW_LIMITS.tunnelFrameMaxBytes,
          }) ?? undefined;
        backend?.on("message", (data, binary) => {
          if (binary) return;
          const frame = parsePreviewTunnelClientFrame(data.toString());
          if (frame?.type === "open") backend!.send(encodePreviewTunnelFrame({ type: "open-ok" }));
        });
        backend?.start();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      let stream: PreviewTunnelStream | undefined;
      try {
        stream = await openPreviewTunnel({
          url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`,
          attachmentId: "att_test",
          credential: "test-credential",
        });
        const errors: Error[] = [];
        stream.on("error", (error) => errors.push(error));
        const closed = new Promise<void>((resolve) => stream!.once("close", resolve));
        const body = Buffer.alloc(512 * 1024);
        for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
        for (let offset = 0; offset < body.length; offset += PREVIEW_LIMITS.tunnelFrameMaxBytes)
          backend!.send(body.subarray(offset, offset + PREVIEW_LIMITS.tunnelFrameMaxBytes), true);
        if (eof) backend!.send(encodePreviewTunnelFrame({ type: "eof" }), false);
        backend!.close(1000);
        // The browser has not started consuming the response. Its unread bytes
        // must survive the backend's EOF/normal close and the socket's shutdown.
        const deadline = Date.now() + 2_000;
        while (stream.readableLength === 0 && Date.now() < deadline) await Bun.sleep(5);
        await Bun.sleep(50);
        expect(stream.readableLength).toBeGreaterThan(0);
        expect(stream.destroyed).toBe(false);
        expect(stream.readableEnded).toBe(false);
        const received: Buffer[] = [];
        for await (const chunk of stream) {
          received.push(chunk as Buffer);
          await Bun.sleep(5);
        }
        await closed;
        expect(Buffer.concat(received)).toEqual(body);
        expect(errors).toEqual([]);
        expect(stream.readableEnded).toBe(true);
        expect(stream.writableFinished).toBe(true);
        expect(stream.destroyed).toBe(true);
      } finally {
        stream?.destroy();
        backend?.terminate();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  test("pings the backend while its reader has stopped, and stops pinging once closed", async () => {
    let backend: PreviewWebSocket | undefined;
    let pings = 0;
    const server = createServer();
    server.on("upgrade", (request, socket, head) => {
      backend =
        acceptPreviewWebSocket(request, socket, head, {
          protocol: PREVIEW_TUNNEL_SUBPROTOCOL,
          maxPayload: PREVIEW_LIMITS.tunnelFrameMaxBytes,
        }) ?? undefined;
      backend?.on("ping", () => (pings += 1));
      backend?.on("message", (data, binary) => {
        if (binary) return;
        const frame = parsePreviewTunnelClientFrame(data.toString());
        if (frame?.type === "open") backend!.send(encodePreviewTunnelFrame({ type: "open-ok" }));
      });
      backend?.start();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let stream: PreviewTunnelStream | undefined;
    try {
      stream = await openPreviewTunnel({
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        attachmentId: "att_test",
        credential: "test-credential",
        pingIntervalMs: 20,
      });
      // Fill the stream past its high-water mark without reading: the socket pauses.
      const chunk = Buffer.alloc(PREVIEW_LIMITS.tunnelFrameMaxBytes, 0x61);
      for (let index = 0; index < 64; index += 1) backend!.send(chunk, true);
      const deadline = Date.now() + 2_000;
      while (pings < 3 && Date.now() < deadline) await Bun.sleep(10);
      expect(pings).toBeGreaterThanOrEqual(3);
      expect(stream.readableLength).toBeGreaterThan(0);
      stream.destroy();
      await Bun.sleep(30);
      const after = pings;
      await Bun.sleep(80);
      expect(pings).toBe(after);
    } finally {
      stream?.destroy();
      backend?.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
