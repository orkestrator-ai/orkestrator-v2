/**
 * The in-container relay, as plain JavaScript that runs under node or bun.
 *
 * It is started by `docker exec -i` inside an owned container's network
 * namespace, so `127.0.0.1:<port>` is the application even when the port is
 * not published or the app listens only on container loopback. Its only
 * channel is the exec's stdio, which only the backend holds — no listener, no
 * credential on a command line. It opens only ports the backend allows, uses
 * per-channel credit windows so one slow channel cannot stall the others, and
 * exits when stdin closes (backend exit, container stop, or explicit stop).
 *
 * Frame: type(1) channel(4, BE) length(4, BE) payload.
 */
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";

export const RELAY_FRAME = {
  hello: 1,
  ready: 2,
  open: 3,
  opened: 4,
  openFailed: 5,
  data: 6,
  eof: 7,
  close: 8,
  credit: 9,
  allow: 10,
} as const;

export const RELAY_PROTOCOL_VERSION = 1;

export const PREVIEW_RELAY_SCRIPT = String.raw`
"use strict";
const net = require("node:net");
// The shared guard, reporting to stderr: stdout carries only relay frames.
(${installFatalRejectionGuard.toString()})({ label: "[preview-relay]" });
const HEADER = 9;
const MAX_PAYLOAD = 32 * 1024;
let buffer = Buffer.alloc(0);
let allowed = new Set();
let window = 256 * 1024;
let maxChannels = 64;
let ready = false;
const channels = new Map();
let stdoutBlocked = false;
const blockedSockets = new Set();

function frame(type, channel, payload) {
  const body = payload || Buffer.alloc(0);
  const header = Buffer.alloc(HEADER);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(channel >>> 0, 1);
  header.writeUInt32BE(body.length, 5);
  if (!process.stdout.write(Buffer.concat([header, body]))) stdoutBlocked = true;
}

process.stdout.on("drain", () => {
  stdoutBlocked = false;
  for (const socket of Array.from(blockedSockets)) {
    blockedSockets.delete(socket);
    const state = socket.__state;
    if (state && state.sendCredit > 0) socket.resume();
  }
});

function closeChannel(id, notify) {
  const state = channels.get(id);
  if (!state) return;
  channels.delete(id);
  state.socket.destroy();
  if (notify) frame(8, id);
}

function open(id, port) {
  if (!ready || channels.has(id) || channels.size >= maxChannels) return frame(5, id, Buffer.from("ECAPACITY"));
  if (!allowed.has(port)) return frame(5, id, Buffer.from("EACCES"));
  const attempt = (host, fallback) => {
    const socket = net.connect({ host, port });
    const state = { socket, sendCredit: window, pendingAck: 0 };
    socket.__state = state;
    socket.once("connect", () => {
      if (!channels.has(id)) channels.set(id, state);
      frame(4, id);
      socket.on("data", (chunk) => {
        for (let offset = 0; offset < chunk.length; offset += MAX_PAYLOAD) {
          const part = chunk.subarray(offset, offset + MAX_PAYLOAD);
          state.sendCredit -= part.length;
          frame(6, id, part);
        }
        if (state.sendCredit <= 0 || stdoutBlocked) {
          socket.pause();
          if (stdoutBlocked) blockedSockets.add(socket);
        }
      });
      socket.on("end", () => frame(7, id));
      socket.on("close", () => {
        if (channels.get(id) === state) {
          channels.delete(id);
          frame(8, id);
        }
      });
    });
    socket.once("error", (error) => {
      if (!channels.has(id)) {
        if (fallback && error.code === "ECONNREFUSED") return attempt(fallback, null);
        frame(5, id, Buffer.from(String(error.code || "ECONNREFUSED")));
      }
    });
  };
  attempt("127.0.0.1", "::1");
}

function handle(type, id, payload) {
  switch (type) {
    case 1: {
      const hello = JSON.parse(payload.toString("utf8"));
      if (hello.version !== 1) process.exit(3);
      allowed = new Set(hello.allow);
      window = hello.window || window;
      maxChannels = hello.maxChannels || maxChannels;
      ready = true;
      return frame(2, 0, Buffer.from(String(hello.nonce)));
    }
    case 10:
      allowed = new Set(JSON.parse(payload.toString("utf8")));
      return;
    case 3:
      return open(id, payload.readUInt16BE(0));
    case 6: {
      const state = channels.get(id);
      if (!state) return;
      state.socket.write(payload, () => {
        const credit = Buffer.alloc(4);
        credit.writeUInt32BE(payload.length, 0);
        frame(9, id, credit);
      });
      return;
    }
    case 7: {
      const state = channels.get(id);
      if (state) state.socket.end();
      return;
    }
    case 8:
      return closeChannel(id, false);
    case 9: {
      const state = channels.get(id);
      if (!state) return;
      state.sendCredit += payload.readUInt32BE(0);
      if (state.sendCredit > 0 && !stdoutBlocked) state.socket.resume();
      return;
    }
    default:
      process.exit(2);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  while (buffer.length >= HEADER) {
    const length = buffer.readUInt32BE(5);
    if (length > MAX_PAYLOAD + 1024) process.exit(4);
    if (buffer.length < HEADER + length) break;
    const type = buffer.readUInt8(0);
    const id = buffer.readUInt32BE(1);
    const payload = buffer.subarray(HEADER, HEADER + length);
    buffer = buffer.subarray(HEADER + length);
    handle(type, id, payload);
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
`;
