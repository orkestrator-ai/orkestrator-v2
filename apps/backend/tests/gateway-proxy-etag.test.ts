import { describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders } from "node:http";

import {
  derivedProxyEtag,
  mapIfNoneMatchForUpstream,
  restoreDerivedEtag,
} from "../src/gateway-proxy-etag.js";
import { auxiliaryServers, requestUrl, startGateway } from "./gateway-test-harness.js";

describe("derived proxy validators", () => {
  test("derive a weak tag that records the coding and the upstream's weakness", () => {
    expect(derivedProxyEtag('W/"abc"', "gzip")).toBe('W/"abc|ork:w:gzip"');
    expect(derivedProxyEtag('"abc"', "br")).toBe('W/"abc|ork:s:br"');
    // No usable upstream tag means no tag at all, never an invented one.
    expect(derivedProxyEtag(undefined, "gzip")).toBeNull();
    expect(derivedProxyEtag("unquoted", "gzip")).toBeNull();
    expect(derivedProxyEtag(`"${"x".repeat(300)}"`, "gzip")).toBeNull();
  });

  test("If-None-Match carries the upstream's own tags and drops rewritten ones", () => {
    const rewriteKey = "0".repeat(16);
    const headers: IncomingHttpHeaders = {
      "if-none-match": `W/"a|ork:w:gzip", W/"b|ork:s:br", "plain", W/"c|ork:w:gzip:${rewriteKey}"`,
    };
    const mapped = mapIfNoneMatchForUpstream(headers);
    expect(headers["if-none-match"]).toBe('W/"a", "b", "plain"');
    expect(Object.fromEntries(mapped.derived)).toEqual({
      'W/"a"': 'W/"a|ork:w:gzip"',
      '"b"': 'W/"b|ork:s:br"',
    });

    // A tag minted for rewritten bytes never revalidates.
    const rewritten: IncomingHttpHeaders = { "if-none-match": `W/"a|ork:w:gzip:${rewriteKey}"` };
    mapIfNoneMatchForUpstream(rewritten);
    expect(rewritten["if-none-match"]).toBeUndefined();
  });

  test("commas and backslashes inside strong and weak tags round-trip intact", () => {
    const upstream = ['"a,b"', 'W/"c,d"', '"back\\,slash"'];
    for (const tag of upstream) {
      const derived = derivedProxyEtag(tag, "gzip")!;
      const headers: IncomingHttpHeaders = { "if-none-match": derived };
      const mapped = mapIfNoneMatchForUpstream(headers);
      expect(headers["if-none-match"]).toBe(tag);
      const response = { etag: tag };
      restoreDerivedEtag(response, mapped);
      expect(response.etag).toBe(derived);
    }
    const headers: IncomingHttpHeaders = {
      "if-none-match": [
        ...upstream.map((tag) => derivedProxyEtag(tag, "gzip")),
        '"plain,tag"',
        'W/"weak,plain"',
      ].join(", "),
    };
    mapIfNoneMatchForUpstream(headers);
    expect(headers["if-none-match"]).toBe(
      [...upstream, '"plain,tag"', 'W/"weak,plain"'].join(", "),
    );
  });

  test("an upstream 304 answers with the tag the client holds", () => {
    const headers: IncomingHttpHeaders = { "if-none-match": 'W/"a|ork:w:gzip"' };
    const mapped = mapIfNoneMatchForUpstream(headers);
    const response: Record<string, string> = { etag: 'W/"a"' };
    restoreDerivedEtag(response, mapped);
    expect(response.etag).toBe('W/"a|ork:w:gzip"');
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

  test("a compressed loopback proxy body revalidates to 304", async () => {
    const app = await application('"strong,1"');
    const { info } = await startGateway({ compression: "body" });
    const url = `${info.url}__orkestrator/proxy/loopback/${app.port}/bundle.js`;
    const headers = { authorization: `Bearer ${info.token}`, "accept-encoding": "br" };

    const first = await requestUrl(url, { headers });
    expect(first.headers["content-encoding"]).toBe("br");
    expect(first.headers.etag).toBe('W/"strong,1|ork:s:br"');
    const again = await requestUrl(url, {
      headers: { ...headers, "if-none-match": String(first.headers.etag) },
    });
    expect(again.status).toBe(304);
    expect(again.headers.etag).toBe('W/"strong,1|ork:s:br"');
    expect(app.seen).toEqual([undefined, '"strong,1"']);
  });
});
