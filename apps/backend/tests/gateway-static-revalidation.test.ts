import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { stat } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";

import * as gatewaySupport from "../src/gateway-support-core.js";

import {
  etagForStaticVariant,
  MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS,
  MAX_STATIC_FALLBACK_SOURCE_BYTES,
  type StaticCompressionOutcome,
  staticFallbackCompressions,
} from "../src/gateway-internals.js";
import {
  createRendererRoot,
  createTempDir,
  decodeResponseBody,
  requestUrl,
  startGateway,
  writeCompressedSibling,
  writeRendererAsset,
} from "./gateway-test-harness.js";

const ASSET = "assets/app-12345678.js";
const SOURCE = "console.log('revalidate');".repeat(256);
const ALL_ENCODINGS = "br, gzip";

async function servedAsset(source: string | Buffer = SOURCE) {
  const dataDir = await createTempDir("ork-static-revalidation-");
  const rendererRoot = await createRendererRoot(dataDir);
  const assetPath = await writeRendererAsset(rendererRoot, ASSET, source);
  const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
  const get = (headers: Record<string, string>, method = "GET") =>
    requestUrl(`${info.url}${ASSET}`, {
      method,
      headers: { authorization: `Bearer ${info.token}`, ...headers },
    });
  return { assetPath, get };
}

/** Every started compression registers here, so this counts compressions run. */
function countCompressions() {
  return spyOn(staticFallbackCompressions, "set");
}

/** A full pool makes the real fallback decline, whatever it was asked to compress. */
function saturateCompressionPool() {
  const keys = Array.from(
    { length: MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS },
    (_, index) => `saturated-${index}`,
  );
  const pending = new Promise<StaticCompressionOutcome>(() => {});
  for (const key of keys) staticFallbackCompressions.set(key, pending);
  return () => {
    for (const key of keys) staticFallbackCompressions.delete(key);
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("revalidating a static file with no precompressed sibling", () => {
  test("a matching tag gets a 304 with no compression run", async () => {
    const { get } = await servedAsset();
    const compressions = countCompressions();
    cleanups.push(() => compressions.mockRestore());

    const first = await get({ "accept-encoding": ALL_ENCODINGS });
    expect(first.status).toBe(200);
    // The control: a full response does compress, so the count below can fail.
    expect(compressions).toHaveBeenCalledTimes(1);

    compressions.mockClear();
    const again = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-none-match": String(first.headers.etag),
    });
    expect(again.status).toBe(304);
    expect(again.rawBody.byteLength).toBe(0);
    expect(compressions).not.toHaveBeenCalled();
  });

  test("a matching tag is found among several, in either weak or strong form", async () => {
    const { get } = await servedAsset();
    const first = await get({ "accept-encoding": ALL_ENCODINGS });
    const compressions = countCompressions();
    cleanups.push(() => compressions.mockRestore());

    const strong = String(first.headers.etag).replace(/^W\//, "");
    const again = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-none-match": `"unrelated", ${strong}`,
    });
    expect(again.status).toBe(304);
    expect(again.headers.etag).toBe(first.headers.etag);
    expect(compressions).not.toHaveBeenCalled();
  });

  test("a 304 carries the Vary, Content-Encoding and validators of the 200", async () => {
    const { get } = await servedAsset();
    for (const acceptEncoding of ["br", "gzip", ALL_ENCODINGS]) {
      const first = await get({ "accept-encoding": acceptEncoding });
      expect(first.status, acceptEncoding).toBe(200);
      expect(first.headers["content-encoding"], acceptEncoding).toBeOneOf(["br", "gzip"]);

      const again = await get({
        "accept-encoding": acceptEncoding,
        "if-none-match": String(first.headers.etag),
      });
      expect(again.status, acceptEncoding).toBe(304);
      for (const header of [
        "vary",
        "content-encoding",
        "etag",
        "cache-control",
        "last-modified",
        "content-type",
      ]) {
        expect(again.headers[header], `${acceptEncoding} ${header}`).toBe(first.headers[header]);
      }
    }
  });

  test("a 304 never states a length it did not measure", async () => {
    const { get } = await servedAsset();
    const coded = await get({ "accept-encoding": "gzip" });
    const notModified = await get({
      "accept-encoding": "gzip",
      "if-none-match": String(coded.headers.etag),
    });
    expect(notModified.status).toBe(304);
    // A cache copies a 304's fields onto its stored response, so the identity
    // size here would describe the wrong bytes.
    expect(notModified.headers["content-length"]).toBeUndefined();
  });

  test("a tag held from an uncompressed answer matches without compressing", async () => {
    const { get } = await servedAsset("x");
    const first = await get({ "accept-encoding": ALL_ENCODINGS });
    expect(first.headers["content-encoding"]).toBeUndefined();
    const compressions = countCompressions();
    cleanups.push(() => compressions.mockRestore());

    const again = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-none-match": String(first.headers.etag),
    });
    expect(again.status).toBe(304);
    expect(again.headers["content-encoding"]).toBeUndefined();
    expect(again.headers.vary).toBe(first.headers.vary);
    expect(again.headers["content-length"]).toBe("1");
    expect(compressions).not.toHaveBeenCalled();
  });

  test("a client holding an encoded tag gets a 304 even when compressing would decline", async () => {
    const { get } = await servedAsset();
    const first = await get({ "accept-encoding": ALL_ENCODINGS });
    cleanups.push(saturateCompressionPool());

    const again = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-none-match": String(first.headers.etag),
    });
    expect(again.status).toBe(304);
    expect(again.headers["content-encoding"]).toBe(first.headers["content-encoding"]);
    expect(again.headers.etag).toBe(first.headers.etag);
  });

  test("a client holding the second choice keeps it, with that coding's headers", async () => {
    const { get } = await servedAsset();
    const gzip = await get({ "accept-encoding": "gzip" });
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    const compressions = countCompressions();
    cleanups.push(() => compressions.mockRestore());

    const again = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-none-match": String(gzip.headers.etag),
    });
    expect(again.status).toBe(304);
    expect(again.headers["content-encoding"]).toBe("gzip");
    expect(again.headers.etag).toBe(gzip.headers.etag);
    expect(compressions).not.toHaveBeenCalled();
  });

  test("a wildcard takes the normal path, so its coding is the one a 200 would have", async () => {
    const { get } = await servedAsset("x");
    const compressible = await servedAsset();
    const wildcard = { "accept-encoding": ALL_ENCODINGS, "if-none-match": "*" };

    const tiny = await get(wildcard);
    expect(tiny.status).toBe(304);
    expect(tiny.headers["content-encoding"]).toBeUndefined();

    const large = await compressible.get(wildcard);
    expect(large.status).toBe(304);
    expect(large.headers["content-encoding"]).toBe("br");
  });
});

// To-do 6160 kept this path as it is: a date names no variant, so the 304 can
// only describe what a 200 would send now, and that takes the compression.
// Browsers send the tag as well (`scripts/static-revalidation-probe.ts`).
describe("revalidating a static file by date alone", () => {
  test("a date-only 304 carries the headers a 200 would send now", async () => {
    const { get } = await servedAsset();
    const first = await get({ "accept-encoding": ALL_ENCODINGS });
    expect(first.headers["content-encoding"]).toBe("br");
    const compressions = countCompressions();
    cleanups.push(() => compressions.mockRestore());

    const again = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-modified-since": String(first.headers["last-modified"]),
    });
    expect(again.status).toBe(304);
    expect(again.rawBody.byteLength).toBe(0);
    for (const header of ["vary", "content-encoding", "etag", "last-modified"]) {
      expect(again.headers[header], header).toBe(first.headers[header]);
    }
    // The cost the to-do accepted: one compression per date-only revalidation.
    expect(compressions).toHaveBeenCalledTimes(1);
  });

  test("a date-only 304 names the coding this request would get, not a held one", async () => {
    const { get } = await servedAsset();
    const gzip = await get({ "accept-encoding": "gzip" });
    expect(gzip.headers["content-encoding"]).toBe("gzip");

    const again = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-modified-since": String(gzip.headers["last-modified"]),
    });
    expect(again.status).toBe(304);
    expect(again.headers["content-encoding"]).toBe("br");
    expect(again.headers.etag).not.toBe(gzip.headers.etag);
  });

  test("a date is ignored when a tag is sent, so a stale tag still gets the body", async () => {
    const { get } = await servedAsset();
    const first = await get({ "accept-encoding": ALL_ENCODINGS });

    const response = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-none-match": `W/"stale"`,
      "if-modified-since": String(first.headers["last-modified"]),
    });
    expect(response.status).toBe(200);
    expect(decodeResponseBody(response)).toBe(SOURCE);
  });

  test("a date before the file changed gets the body", async () => {
    const { get } = await servedAsset();
    const response = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-modified-since": new Date(0).toUTCString(),
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(decodeResponseBody(response)).toBe(SOURCE);
  });
});

describe("a request that does not match still gets the right representation", () => {
  test("a stale tag gets the coded body", async () => {
    const { get } = await servedAsset();
    const response = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-none-match": `W/"stale"`,
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers.vary).toBe("Accept-Encoding");
    expect(decodeResponseBody(response)).toBe(SOURCE);
  });

  test("a tag from before the file changed does not match", async () => {
    const { assetPath, get } = await servedAsset();
    const first = await get({ "accept-encoding": ALL_ENCODINGS });
    const replacement = `${SOURCE}// changed`;
    await Bun.write(assetPath, replacement);

    const after = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-none-match": String(first.headers.etag),
    });
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(first.headers.etag);
    expect(decodeResponseBody(after)).toBe(replacement);
  });

  test("a coded tag the request no longer accepts gets a coding it does accept", async () => {
    const { get } = await servedAsset();
    const brotli = await get({ "accept-encoding": "br" });
    expect(brotli.headers["content-encoding"]).toBe("br");

    const gzip = await get({
      "accept-encoding": "gzip",
      "if-none-match": String(brotli.headers.etag),
    });
    expect(gzip.status).toBe(200);
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(gzip)).toBe(SOURCE);

    const identity = await get({
      "accept-encoding": "identity",
      "if-none-match": String(brotli.headers.etag),
    });
    expect(identity.status).toBe(200);
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.body).toBe(SOURCE);
  });

  test("an identity tag is not a match where identity is forbidden", async () => {
    const { get } = await servedAsset();
    const identity = await get({ "accept-encoding": "identity" });
    expect(identity.headers["content-encoding"]).toBeUndefined();

    const response = await get({
      "accept-encoding": "gzip, identity;q=0",
      "if-none-match": String(identity.headers.etag),
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(response)).toBe(SOURCE);
  });

  test("a declined compression serves identity, with the identity tag", async () => {
    const { get } = await servedAsset();
    const coded = await get({ "accept-encoding": ALL_ENCODINGS });
    cleanups.push(saturateCompressionPool());

    const response = await get({
      "accept-encoding": ALL_ENCODINGS,
      "if-none-match": `W/"stale"`,
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary).toBe("Accept-Encoding");
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(SOURCE)));
    expect(response.headers.etag).not.toBe(coded.headers.etag);
    expect(response.body).toBe(SOURCE);
  });

  test("a failed compression serves identity, with the identity tag", async () => {
    const { get } = await servedAsset();
    const identity = await get({ "accept-encoding": "identity" });
    // Exercise the codec catch with a real zlib rejection, rather than seeding
    // the outcome map. A one-byte output budget forces the codec to throw.
    const codec = spyOn(gatewaySupport, "brotliCompressAsync").mockImplementation(async (source) =>
      brotliCompressSync(source, { maxOutputLength: 1 }),
    );
    cleanups.push(() => codec.mockRestore());

    const response = await get({
      "accept-encoding": "br",
      "if-none-match": `W/"stale"`,
    });
    expect(codec).toHaveBeenCalledTimes(1);
    await expect(codec.mock.results[0]?.value).rejects.toMatchObject({
      code: "ERR_BUFFER_TOO_LARGE",
    });
    expect(staticFallbackCompressions.size).toBe(0);
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary).toBe("Accept-Encoding");
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(SOURCE)));
    expect(response.headers.etag).toBe(identity.headers.etag);
    expect(response.body).toBe(SOURCE);
  });

  test("a client holding a coded copy of a file over the cap is not answered by it", async () => {
    const source = Buffer.alloc(MAX_STATIC_FALLBACK_SOURCE_BYTES + 1, 0x61);
    const { assetPath, get } = await servedAsset(source);
    const file = await stat(assetPath);
    const coded = etagForStaticVariant(file.mtimeMs, file.size, "br");

    const response = await get({ "accept-encoding": ALL_ENCODINGS, "if-none-match": coded });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.rawBody.byteLength).toBe(source.byteLength);
  });

  test("a precompressed sibling still takes precedence over the on-the-fly tags", async () => {
    const dataDir = await createTempDir("ork-static-revalidation-sibling-");
    const rendererRoot = await createRendererRoot(dataDir);
    const assetPath = await writeRendererAsset(rendererRoot, ASSET, SOURCE);
    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const get = (headers: Record<string, string>) =>
      requestUrl(`${info.url}${ASSET}`, {
        headers: { authorization: `Bearer ${info.token}`, ...headers },
      });

    const onTheFly = await get({ "accept-encoding": "br" });
    await writeCompressedSibling(assetPath, "br", "sibling");
    const compressions = countCompressions();
    cleanups.push(() => compressions.mockRestore());

    const response = await get({
      "accept-encoding": "br",
      "if-none-match": String(onTheFly.headers.etag),
    });
    expect(response.status).toBe(200);
    expect(response.headers.etag).not.toBe(onTheFly.headers.etag);
    expect(decodeResponseBody(response)).toBe("sibling");
    expect(compressions).not.toHaveBeenCalled();
  });

  test("a HEAD revalidation still reports the identity metadata it always did", async () => {
    const { get } = await servedAsset();
    const coded = await get({ "accept-encoding": ALL_ENCODINGS });
    const head = await get(
      { "accept-encoding": ALL_ENCODINGS, "if-none-match": String(coded.headers.etag) },
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBeUndefined();
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(SOURCE)));
  });
});
