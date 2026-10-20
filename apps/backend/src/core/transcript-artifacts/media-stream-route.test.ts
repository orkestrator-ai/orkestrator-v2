import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

import { LoopbackArtifactContentServer } from "./content-server.js";
import { syntheticWav } from "./fixtures/synthetic-wav.js";
import {
  MEDIA_CONTENT_SECURITY_POLICY,
  MEDIA_MAX_RESPONSES_PER_CAPABILITY,
  MEDIA_RANGE_RESPONSE_MAX_BYTES,
  parseMediaRange,
  type MintMediaInput,
} from "./media-stream-route.js";
import { sniffServedMediaMime } from "./media-stream-sniff.js";

const WAV = syntheticWav(1); // 16,044 bytes
let server: LoopbackArtifactContentServer | undefined;
let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "media-route-"));
  file = path.join(directory, "clip.wav");
  writeFileSync(file, WAV);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function identity(target: string): string {
  const stats = statSync(target);
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

async function start(options: { now?: () => number; mediaRangeResponseMaxBytes?: number } = {}) {
  server = await LoopbackArtifactContentServer.start({ frameAncestors: [], ...options });
  return server;
}

function mint(target: LoopbackArtifactContentServer, overrides: Partial<MintMediaInput> = {}) {
  return target.mintMedia({
    ownerKey: "env-1",
    mimeType: "audio/wav",
    byteLength: WAV.byteLength,
    identity: identity(file),
    resolve: async () => {
      const handle = await open(file, "r");
      const stats = await handle.stat();
      return {
        handle,
        size: stats.size,
        identity: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
      };
    },
    authorize: async () => true,
    ...overrides,
  });
}

function get(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers: { host: target.host, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("parseMediaRange", () => {
  test("single ranges: first bytes, suffix, open-ended, clamped and capped", () => {
    expect(parseMediaRange(undefined, 100)).toEqual({ kind: "none" });
    expect(parseMediaRange("bytes=0-9", 100)).toEqual({ kind: "range", start: 0, end: 9 });
    expect(parseMediaRange("bytes=-10", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseMediaRange("bytes=-500", 100)).toEqual({ kind: "range", start: 0, end: 99 });
    expect(parseMediaRange("bytes=40-", 100)).toEqual({ kind: "range", start: 40, end: 99 });
    expect(parseMediaRange("bytes=90-500", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseMediaRange(" bytes=5-5 ", 100)).toEqual({ kind: "range", start: 5, end: 5 });
    // Capped spans: an open-ended request gets the first `maxBytes`.
    expect(parseMediaRange("bytes=0-", 100, 16)).toEqual({ kind: "range", start: 0, end: 15 });
    expect(parseMediaRange("bytes=10-80", 100, 16)).toEqual({ kind: "range", start: 10, end: 25 });
    expect(parseMediaRange("bytes=0-", 64 * 1024 * 1024)).toEqual({
      kind: "range",
      start: 0,
      end: MEDIA_RANGE_RESPONSE_MAX_BYTES - 1,
    });
  });

  test("malformed, multiple, other-unit and unsatisfiable ranges", () => {
    for (const header of [
      "bytes=",
      "bytes=-",
      "bytes=abc",
      "bytes=5-1",
      "bytes=100-",
      "bytes=100-200",
      "bytes=-0",
      "bytes=0-1,4-5",
      "items=0-1",
      "bytes=0x10-",
      "bytes=99999999999999999-",
      "",
    ]) {
      expect(parseMediaRange(header, 100)).toEqual({ kind: "unsatisfiable" });
    }
    expect(parseMediaRange("bytes=-5", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("media MIME sniffing", () => {
  test("recognises media containers from bytes and refuses everything else", () => {
    const ascii = (text: string) => new Uint8Array(Array.from(text, (char) => char.charCodeAt(0)));
    expect(sniffServedMediaMime(WAV)).toBe("audio/wav");
    expect(sniffServedMediaMime(ascii("\u0000\u0000\u0000\u0018ftypisom\u0000\u0000"))).toBe(
      "video/mp4",
    );
    expect(sniffServedMediaMime(ascii("\u0000\u0000\u0000\u0018ftypM4A \u0000\u0000"))).toBe(
      "audio/mp4",
    );
    expect(
      sniffServedMediaMime(
        new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, ...ascii("webm")]),
      ),
    ).toBe("video/webm");
    expect(sniffServedMediaMime(ascii("OggS\u0000\u0002"))).toBe("audio/ogg");
    expect(sniffServedMediaMime(ascii("ID3\u0004\u0000"))).toBe("audio/mpeg");
    expect(sniffServedMediaMime(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe("audio/mpeg");
    expect(
      sniffServedMediaMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
    // An HTML document named .mp4, SVG, PDF and plain text are never media.
    expect(
      sniffServedMediaMime(ascii("<!doctype html><video></video><script>1</script>")),
    ).toBeNull();
    expect(
      sniffServedMediaMime(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).toBeNull();
    expect(sniffServedMediaMime(ascii("%PDF-1.7\n"))).toBeNull();
    expect(sniffServedMediaMime(ascii("hello world"))).toBeNull();
    expect(sniffServedMediaMime(ascii("\u0000\u0000\u0000\u0018ftypheic\u0000\u0000"))).toBeNull();
  });
});

describe("media capability route", () => {
  test("serves single ranges with the required headers and never redirects", async () => {
    const target = await start();
    const capability = mint(target);
    expect(capability.url).toMatch(/^http:\/\/localhost:\d+\/m\/[A-Za-z0-9_-]{43}$/);

    const first = await get(capability.url, { headers: { range: "bytes=0-99" } });
    expect(first.status).toBe(206);
    expect(first.headers["content-range"]).toBe(`bytes 0-99/${WAV.byteLength}`);
    expect(first.headers["content-length"]).toBe("100");
    expect(first.body.equals(Buffer.from(WAV.subarray(0, 100)))).toBe(true);
    expect(first.headers["accept-ranges"]).toBe("bytes");
    expect(first.headers["content-type"]).toBe("audio/wav");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    expect(first.headers["content-security-policy"]).toBe(MEDIA_CONTENT_SECURITY_POLICY);
    expect(first.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(first.headers.location).toBeUndefined();
    expect(first.headers["set-cookie"]).toBeUndefined();

    const suffix = await get(capability.url, { headers: { range: "bytes=-10" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers["content-range"]).toBe(
      `bytes ${WAV.byteLength - 10}-${WAV.byteLength - 1}/${WAV.byteLength}`,
    );
    expect(suffix.body.equals(Buffer.from(WAV.subarray(WAV.byteLength - 10)))).toBe(true);

    const open = await get(capability.url, { headers: { range: "bytes=16000-" } });
    expect(open.status).toBe(206);
    expect(open.body.equals(Buffer.from(WAV.subarray(16_000)))).toBe(true);

    const whole = await get(capability.url);
    expect(whole.status).toBe(200);
    expect(whole.headers["content-length"]).toBe(String(WAV.byteLength));
    expect(whole.body.equals(Buffer.from(WAV))).toBe(true);

    const head = await get(capability.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(WAV.byteLength));
    expect(head.headers["accept-ranges"]).toBe("bytes");
    expect(head.body.byteLength).toBe(0);
    const rangedHead = await get(capability.url, {
      method: "HEAD",
      headers: { range: "bytes=0-1" },
    });
    expect(rangedHead.status).toBe(206);
    expect(rangedHead.body.byteLength).toBe(0);

    for (const range of ["bytes=99999-", "bytes=5-1", "bytes=0-1,4-5", "bytes=abc"]) {
      const refused = await get(capability.url, { headers: { range } });
      expect(refused.status).toBe(416);
      expect(refused.headers["content-range"]).toBe(`bytes */${WAV.byteLength}`);
      expect(refused.body.toString()).not.toContain("RIFF");
    }

    const token = new URL(capability.url).pathname.slice(3);
    for (const pathname of [
      `/m/${token}/x`,
      `/m/${token}?r=https://evil.example`,
      "/m/",
      `/M/${token}`,
    ]) {
      const response = await get(`${new URL(capability.url).origin}${pathname}`);
      expect(response.status).toBe(404);
      expect(response.headers.location).toBeUndefined();
    }
    expect((await get(capability.url, { method: "POST" })).status).toBe(405);
  });

  test("open-ended ranges are answered with a capped span media elements continue from", async () => {
    const target = await start({ mediaRangeResponseMaxBytes: 4096 });
    const capability = mint(target);
    const first = await get(capability.url, { headers: { range: "bytes=0-" } });
    expect(first.status).toBe(206);
    expect(first.headers["content-range"]).toBe(`bytes 0-4095/${WAV.byteLength}`);
    expect(first.body.byteLength).toBe(4096);
    const next = await get(capability.url, { headers: { range: "bytes=4096-" } });
    expect(next.headers["content-range"]).toBe(`bytes 4096-8191/${WAV.byteLength}`);
    expect(next.body.equals(Buffer.from(WAV.subarray(4096, 8192)))).toBe(true);
  });

  test("expiry, revocation and a failed authorization answer without serving bytes", async () => {
    let now = Date.now();
    const target = await start({ now: () => now });
    const expiring = mint(target, { idleTtlMs: 5_000 });
    expect((await get(expiring.url, { headers: { range: "bytes=0-1" } })).status).toBe(206);
    now += 4_000;
    // A served request extends the idle lifetime.
    expect((await get(expiring.url, { headers: { range: "bytes=0-1" } })).status).toBe(206);
    now += 4_000;
    expect((await get(expiring.url, { headers: { range: "bytes=0-1" } })).status).toBe(206);
    now += 5_001;
    expect((await get(expiring.url)).status).toBe(410);
    expect(target.mediaLive(expiring.generation)).toBe(false);

    const revoked = mint(target);
    target.revokeMedia(revoked.generation);
    expect((await get(revoked.url)).status).toBe(404);

    const owned = mint(target);
    target.revokeMediaOwner("env-1");
    expect((await get(owned.url)).status).toBe(404);

    let allowed = true;
    let resolves = 0;
    const checked = mint(target, {
      authorize: async () => allowed,
      resolve: async () => {
        resolves++;
        const handle = await open(file, "r");
        const stats = await handle.stat();
        return { handle, size: stats.size, identity: identity(file) };
      },
    });
    expect((await get(checked.url, { headers: { range: "bytes=0-3" } })).status).toBe(206);
    allowed = false;
    const denied = await get(checked.url);
    expect(denied.status).toBe(404);
    expect(denied.body.toString()).not.toContain("RIFF");
    expect(resolves).toBe(1);
    // The denial revoked it: re-allowing does not resurrect it.
    allowed = true;
    expect((await get(checked.url)).status).toBe(404);

    const throwing = mint(target, {
      authorize: async () => {
        throw new Error("environment gone");
      },
    });
    expect((await get(throwing.url)).status).toBe(404);
  });

  test("a file changed or replaced after minting is never served under the capability", async () => {
    const target = await start();
    const capability = mint(target);
    expect((await get(capability.url, { headers: { range: "bytes=0-3" } })).status).toBe(206);
    await Bun.sleep(5);
    writeFileSync(file, "<!doctype html><script>alert(1)</script>".padEnd(WAV.byteLength, " "));
    const changed = await get(capability.url);
    expect(changed.status).toBe(404);
    expect(changed.body.toString()).not.toContain("script");
    // Revoked by the mismatch.
    writeFileSync(file, WAV);
    expect(target.mediaLive(capability.generation)).toBe(false);
  });

  test("refuses non-media types at minting and bounds concurrent responses", async () => {
    const target = await start();
    expect(() => mint(target, { mimeType: "text/html" })).toThrow();
    expect(() => mint(target, { mimeType: "image/svg+xml" })).toThrow();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = mint(target, {
      authorize: async () => {
        await gate;
        return true;
      },
    });
    const pending = Array.from({ length: MEDIA_MAX_RESPONSES_PER_CAPABILITY }, () =>
      get(slow.url, { headers: { range: "bytes=0-0" } }),
    );
    await Bun.sleep(50);
    const busy = await get(slow.url, { headers: { range: "bytes=0-0" } });
    expect(busy.status).toBe(503);
    expect(busy.headers["retry-after"]).toBe("1");
    release();
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual(
      Array(MEDIA_MAX_RESPONSES_PER_CAPABILITY).fill(206),
    );
    expect((await get(slow.url, { headers: { range: "bytes=0-0" } })).status).toBe(206);
  });

  test("changing the content origin and closing revoke media capabilities", async () => {
    const target = await start();
    const capability = mint(target);
    target.configureApplicationOrigins(["http://localhost:4100"]);
    expect(target.mediaLive(capability.generation)).toBe(false);
    const fresh = mint(target);
    expect(fresh.url.startsWith("http://127.0.0.1:")).toBe(true);
    await target.close();
    expect(target.mediaSize()).toBe(0);
    expect(() => mint(target)).toThrow();
  });
});
