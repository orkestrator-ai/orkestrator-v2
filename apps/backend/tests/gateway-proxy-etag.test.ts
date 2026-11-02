import { describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders } from "node:http";

import {
  browserPreviewRewriteKey,
  derivedProxyEtag,
  mapIfNoneMatchForUpstream,
  restoreDerivedEtag,
} from "../src/gateway-proxy-etag.js";
import {
  auxiliaryServers,
  decodeResponseBody,
  requestUrl,
  startGateway,
} from "./gateway-test-harness.js";

describe("derived proxy validators", () => {
  const key = browserPreviewRewriteKey(
    "/__orkestrator/browser/loopback/5173",
    new URL("http://127.0.0.1:5173/"),
  );

  test("derive a weak tag that records the coding, the rewrite and the upstream's weakness", () => {
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(derivedProxyEtag('W/"abc"', "gzip", key)).toBe(`W/"abc|ork:w:gzip:${key}"`);
    expect(derivedProxyEtag('"abc"', "br", null)).toBe('W/"abc|ork:s:br"');
    // No usable upstream tag means no tag at all, never an invented one.
    expect(derivedProxyEtag(undefined, "gzip", null)).toBeNull();
    expect(derivedProxyEtag("unquoted", "gzip", null)).toBeNull();
    expect(derivedProxyEtag(`"${"x".repeat(300)}"`, "gzip", null)).toBeNull();
  });

  test("a rewrite key belongs to one route prefix and port", () => {
    expect(
      browserPreviewRewriteKey(
        "/__orkestrator/browser/loopback/5174",
        new URL("http://127.0.0.1:5174/"),
      ),
    ).not.toBe(key);
  });

  test("If-None-Match carries the upstream's own tags and drops another route's", () => {
    const headers: IncomingHttpHeaders = {
      "if-none-match": `W/"a|ork:w:gzip:${key}", W/"b|ork:s:br", "plain", W/"c|ork:w:gzip:${"0".repeat(16)}"`,
    };
    const mapped = mapIfNoneMatchForUpstream(headers, key);
    expect(headers["if-none-match"]).toBe('W/"a", "b", "plain"');
    expect(Object.fromEntries(mapped.derived)).toEqual({
      'W/"a"': `W/"a|ork:w:gzip:${key}"`,
      '"b"': 'W/"b|ork:s:br"',
    });

    // On a route without rewriting, a rewritten tag never revalidates.
    const plain: IncomingHttpHeaders = { "if-none-match": `W/"a|ork:w:gzip:${key}"` };
    mapIfNoneMatchForUpstream(plain, null);
    expect(plain["if-none-match"]).toBeUndefined();
  });

  test("an upstream 304 answers with the tag the client holds", () => {
    const headers: IncomingHttpHeaders = { "if-none-match": `W/"a|ork:w:gzip:${key}"` };
    const mapped = mapIfNoneMatchForUpstream(headers, key);
    const response: Record<string, string> = { etag: 'W/"a"' };
    restoreDerivedEtag(response, mapped);
    expect(response.etag).toBe(`W/"a|ork:w:gzip:${key}"`);
    const other: Record<string, string> = { etag: '"z"' };
    restoreDerivedEtag(other, mapped);
    expect(other.etag).toBe('"z"');
  });
});

describe("gateway proxy revalidation", () => {
  async function application(etag: string) {
    const seen: Array<string | undefined> = [];
    const script = `import "/src/dependency.js";\n${"// padding to compress\n".repeat(256)}`;
    const target = createServer((request, response) => {
      seen.push(request.headers["if-none-match"]);
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/javascript",
        "content-length": Buffer.byteLength(script),
        "cache-control": "no-cache",
        etag,
      });
      response.end(script);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    return { port: address.port, seen };
  }

  test("a rewritten, compressed preview script revalidates to 304", async () => {
    // Vite's own tag, which it compares as a plain string.
    const app = await application('W/"1a2b-vite"');
    const { info } = await startGateway({ compression: "body" });
    const prefix = `/__orkestrator/browser/loopback/${app.port}`;
    const url = new URL(`${prefix}/src/main.js`, info.url).toString();
    const headers = {
      authorization: `Bearer ${info.token}`,
      origin: "null",
      "accept-encoding": "gzip",
    };

    const first = await requestUrl(url, { headers });
    expect(first.status).toBe(200);
    expect(first.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(first)).toContain(`import "${prefix}/src/dependency.js"`);
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^W\/"1a2b-vite\|ork:w:gzip:[0-9a-f]{16}"$/);

    const again = await requestUrl(url, { headers: { ...headers, "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.etag).toBe(etag);
    expect(again.rawBody.byteLength).toBe(0);
    // The application saw its own tag, exactly.
    expect(app.seen).toEqual([undefined, 'W/"1a2b-vite"']);
  });

  test("a compressed loopback proxy body revalidates to 304", async () => {
    const app = await application('"strong-1"');
    const { info } = await startGateway({ compression: "body" });
    const url = `${info.url}__orkestrator/proxy/loopback/${app.port}/bundle.js`;
    const headers = { authorization: `Bearer ${info.token}`, "accept-encoding": "br" };

    const first = await requestUrl(url, { headers });
    expect(first.headers["content-encoding"]).toBe("br");
    expect(first.headers.etag).toBe('W/"strong-1|ork:s:br"');
    const again = await requestUrl(url, {
      headers: { ...headers, "if-none-match": String(first.headers.etag) },
    });
    expect(again.status).toBe(304);
    expect(again.headers.etag).toBe('W/"strong-1|ork:s:br"');
    expect(app.seen).toEqual([undefined, '"strong-1"']);
  });

  test("a tag minted for another preview port is not sent upstream", async () => {
    const app = await application('W/"shared"');
    const { info } = await startGateway({ compression: "body" });
    const foreignKey = browserPreviewRewriteKey(
      "/__orkestrator/browser/loopback/1",
      new URL("http://127.0.0.1:1/"),
    );
    const result = await requestUrl(
      new URL(`/__orkestrator/browser/loopback/${app.port}/src/main.js`, info.url).toString(),
      {
        headers: {
          authorization: `Bearer ${info.token}`,
          origin: "null",
          "if-none-match": `W/"shared|ork:w:gzip:${foreignKey}"`,
        },
      },
    );
    expect(result.status).toBe(200);
    expect(app.seen).toEqual([undefined]);
  });
});
