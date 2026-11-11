/**
 * Bun preload for the E10 baseline (`conditional-reads-live.spec.ts`). It is
 * loaded into a real bridge by a `bun` wrapper the spec puts in the profile's
 * own toolchain directory, and counts what the bridge answers: requests and
 * bytes per route, with session ids and query values removed.
 *
 * For each v2 transcript snapshot it also records what a delta from the
 * previous snapshot of that session would have carried: the encoded bytes of
 * the rows that changed or arrived, plus the id order. Only sizes and digests
 * are kept; no row content leaves the hook.
 *
 * Totals are written to `$E10_BRIDGE_COUNTER_DIR/bridge-<pid>.json` once a
 * second, off the request path.
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export type RouteTotals = {
  count: number;
  bytes: number;
  decodedBytes: number;
  /** Time from the request reaching the server to the response ending. */
  ms: number;
  maxMs: number;
  /** State routes only: bodies byte-identical to that session's previous one. */
  repeats: number;
};
export type DeltaTotals = {
  snapshots: number;
  snapshotBytes: number;
  estimatedDeltaBytes: number;
  changedRows: number;
  rows: number;
  /** v2 snapshots whose head row was part-trimmed (`messageWindow.omittedParts`). */
  trimmedHeads: number;
};

export type CounterSample = { at: number; label: string; route: RouteTotals; delta: DeltaTotals };
export type CounterFile = { samples: CounterSample[]; droppedThrough: number; flushedAt: number };

const directory = process.env.E10_BRIDGE_COUNTER_DIR;
/** Bounds: route labels are normalized, so this only guards against a surprise. */
const MAX_ROUTES = 256;
const MAX_SESSIONS = 64;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

const STATE_ROUTES = new Set(["GET /session/:id", "GET /session/:id/status"]);

const digest = (value: string) => createHash("sha1").update(value).digest("hex").slice(0, 16);

export function createCounter() {
  const routes = new Map<string, RouteTotals>();
  const delta: DeltaTotals = {
    snapshots: 0,
    snapshotBytes: 0,
    estimatedDeltaBytes: 0,
    changedRows: 0,
    rows: 0,
    trimmedHeads: 0,
  };
  /** Per session (hashed), the last snapshot's row digests by row id digest. */
  const lastRows = new Map<string, Map<string, string>>();
  /** Per state route and session (hashed), the digest of the last body. */
  const lastState = new Map<string, string>();
  function recordSnapshot(sessionKey: string, body: Buffer, gzip: boolean): number {
    const text = (gzip ? gunzipSync(body) : body).toString("utf8");
    const parsed = JSON.parse(text) as {
      status?: string;
      value?: { messages?: unknown[]; messageWindow?: { omittedParts?: unknown } };
    };
    if (parsed.status !== "snapshot" || !Array.isArray(parsed.value?.messages)) return text.length;
    const messages = parsed.value.messages;
    const omittedParts = parsed.value.messageWindow?.omittedParts;
    if (typeof omittedParts === "number" && omittedParts > 0) delta.trimmedHeads += 1;
    const previous = lastRows.get(sessionKey);
    const current = new Map<string, string>();
    let changedBytes = 0;
    let changedRows = 0;
    let idBytes = 0;
    for (const message of messages) {
      const encoded = JSON.stringify(message);
      const id = digest(String((message as { id?: unknown }).id ?? encoded));
      const rowDigest = digest(encoded);
      current.set(id, rowDigest);
      idBytes += Buffer.byteLength(String((message as { id?: unknown }).id ?? "")) + 3;
      if (previous?.get(id) !== rowDigest) {
        changedRows += 1;
        changedBytes += Buffer.byteLength(encoded);
      }
    }
    lastRows.delete(sessionKey);
    lastRows.set(sessionKey, current);
    if (lastRows.size > MAX_SESSIONS) lastRows.delete(lastRows.keys().next().value!);
    if (previous) {
      delta.snapshots += 1;
      delta.snapshotBytes += Buffer.byteLength(text);
      // The changed rows, the id order and an envelope the size of the snapshot's own.
      delta.estimatedDeltaBytes += changedBytes + idBytes + 512;
      delta.changedRows += changedRows;
      delta.rows += messages.length;
    }
    return Buffer.byteLength(text);
  }

  function record(
    label: string,
    bytes: number,
    decodedBytes: number,
    ms: number,
    repeated: boolean,
  ): void {
    let totals = routes.get(label);
    if (!totals) {
      if (routes.size >= MAX_ROUTES) label = "other";
      totals = routes.get(label) ?? {
        count: 0,
        bytes: 0,
        decodedBytes: 0,
        ms: 0,
        maxMs: 0,
        repeats: 0,
      };
      routes.set(label, totals);
    }
    totals.count += 1;
    totals.bytes += bytes;
    totals.decodedBytes += decodedBytes;
    totals.ms += ms;
    totals.maxMs = Math.max(totals.maxMs, ms);
    if (repeated) totals.repeats += 1;
  }

  function stateRepeated(label: string, sessionKey: string, body: Buffer, gzip: boolean): boolean {
    const key = `${label} ${sessionKey}`;
    const bodyDigest = digest((gzip ? gunzipSync(body) : body).toString("utf8"));
    const repeated = lastState.get(key) === bodyDigest;
    lastState.delete(key);
    lastState.set(key, bodyDigest);
    if (lastState.size > MAX_SESSIONS) lastState.delete(lastState.keys().next().value!);
    return repeated;
  }

  return { recordSnapshot, stateRepeated, record, delta, routes };
}

export function routeLabel(method: string | undefined, url: string | undefined): string {
  const parsed = new URL(url ?? "/", "http://bridge.invalid");
  const segments = parsed.pathname.split("/").map((segment, index, all) => {
    const previous = all[index - 1];
    return previous === "session" || previous === "sessions" ? ":id" : segment;
  });
  // `/sessions/activity` is a fixed route, not a session id.
  const pathname = segments.join("/").replace("/sessions/:id", (match) => {
    return parsed.pathname.startsWith("/sessions/activity") ? "/sessions/activity" : match;
  });
  const names = [...new Set(parsed.searchParams.keys())].sort().map((name) => {
    return name === "version" ? `version=${parsed.searchParams.get(name)}` : name;
  });
  return `${method ?? "GET"} ${pathname}${names.length ? `?${names.join("&")}` : ""}`;
}

function chunkLength(chunk: unknown, encoding?: unknown): number {
  if (typeof chunk === "string")
    return Buffer.byteLength(
      chunk,
      typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
    );
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function toBuffer(chunk: unknown, encoding?: unknown): Buffer | undefined {
  if (typeof chunk === "string")
    return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return undefined;
}

if (directory) {
  const { recordSnapshot, stateRepeated, record, delta, routes } = createCounter();
  const samples: CounterSample[] = [];
  const sampleSizes: number[] = [];
  let sampleBytes = 0;
  const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
  let droppedThrough = 0;
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `bridge-${process.pid}.json`);
  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (this: http.Server, event: string, ...args: unknown[]) {
    if (event === "request") {
      const [request, response] = args as [http.IncomingMessage, http.ServerResponse];
      const label = routeLabel(request.method, request.url);
      const transcript = /\/session\/:id\/transcript\?.*version=2/.test(label);
      const state = STATE_ROUTES.has(label);
      const started = performance.now();
      const sessionKey = digest(request.url?.split("/")[2] ?? "");
      const captured: Buffer[] = [];
      let capturedBytes = 0;
      let bytes = 0;
      const capture = (chunk: unknown, encoding?: unknown) => {
        bytes += chunkLength(chunk, encoding);
        if ((!transcript && !state) || capturedBytes > MAX_CAPTURE_BYTES) return;
        const buffer = toBuffer(chunk, encoding);
        if (buffer) {
          captured.push(buffer);
          capturedBytes += buffer.byteLength;
        }
      };
      const write = response.write;
      const end = response.end;
      response.write = function (this: http.ServerResponse, chunk: unknown, ...rest: unknown[]) {
        capture(chunk, rest[0]);
        return (write as (...values: unknown[]) => boolean).call(this, chunk, ...rest);
      } as typeof response.write;
      response.end = function (this: http.ServerResponse, chunk?: unknown, ...rest: unknown[]) {
        if (chunk !== undefined && typeof chunk !== "function") capture(chunk, rest[0]);
        const gzip = String(response.getHeader("content-encoding") ?? "") === "gzip";
        const total = bytes;
        const ms = performance.now() - started;
        const at = Date.now();
        setImmediate(() => {
          const before = { ...delta };
          let decoded = total;
          let repeated = false;
          const complete = captured.length > 0 && capturedBytes <= MAX_CAPTURE_BYTES;
          try {
            if (transcript && complete)
              decoded = recordSnapshot(sessionKey, Buffer.concat(captured), gzip);
            if (state && complete)
              repeated = stateRepeated(label, sessionKey, Buffer.concat(captured), gzip);
          } catch {
            decoded = total;
          }
          record(label, total, decoded, ms, repeated);
          const change = { ...delta };
          for (const key of Object.keys(change) as Array<keyof DeltaTotals>)
            change[key] -= before[key];
          samples.push({
            at,
            label,
            route: {
              count: 1,
              bytes: total,
              decodedBytes: decoded,
              ms,
              maxMs: ms,
              repeats: Number(repeated),
            },
            delta: change,
          });
          const size = Buffer.byteLength(JSON.stringify(samples[samples.length - 1]));
          sampleSizes.push(size);
          sampleBytes += size;
          while (samples.length > 20_000 || sampleBytes > MAX_SAMPLE_BYTES) {
            droppedThrough = samples.shift()!.at;
            sampleBytes -= sampleSizes.shift()!;
          }
        });
        return (end as (...values: unknown[]) => http.ServerResponse).call(this, chunk, ...rest);
      } as typeof response.end;
    }
    return originalEmit.call(this, event, ...args);
  } as typeof originalEmit;
  setInterval(() => {
    const temporary = `${file}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({
        pid: process.pid,
        routes: Object.fromEntries(routes),
        delta,
        samples,
        droppedThrough,
        flushedAt: Date.now(),
      }),
    );
    renameSync(temporary, file);
  }, 1_000).unref();
}
