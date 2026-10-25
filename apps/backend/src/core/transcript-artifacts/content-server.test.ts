import { afterEach, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";

import {
  LoopbackArtifactContentServer,
  approximateSite,
  hostsShareSite,
} from "./content-server.js";
import { sha256Hex } from "./dependency-manifest.js";
import {
  DESKTOP_ARTIFACT_SHELL_ORIGIN,
  buildInteractiveCsp,
  inlineScriptHash,
} from "./interactive-csp.js";

const DOCUMENT = "<!doctype html><html><head><script>1</script></head><body>hi</body></html>";
const BYTES = new TextEncoder().encode(DOCUMENT);
const CSP = buildInteractiveCsp([inlineScriptHash("1")], ["http://127.0.0.1:*"]);

let server: LoopbackArtifactContentServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Raw request so the Host header and redirect handling are fully controlled. */
function get(
  url: string,
  options: { method?: string; host?: string; headers?: Record<string, string> } = {},
) {
  const target = new URL(url);
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers: { host: options.host ?? target.host, ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function start(now?: () => number) {
  server = await LoopbackArtifactContentServer.start({
    frameAncestors: ["http://127.0.0.1:34121"],
    ...(now ? { now } : {}),
  });
  return server;
}

function mint(
  target: LoopbackArtifactContentServer,
  overrides: Partial<Parameters<LoopbackArtifactContentServer["mint"]>[0]> = {},
) {
  return target.mint({
    artifactId: "art_content001",
    revision: 3,
    preparedSha256: sha256Hex(BYTES),
    contentSecurityPolicy: CSP,
    load: async () => BYTES,
    ...overrides,
  });
}

describe("artifact content server", () => {
  test("serves exactly the capability's document with the required headers", async () => {
    const target = await start();
    expect(target.origin()).toMatch(/^http:\/\/localhost:\d+$/);
    const capability = mint(target);
    expect(capability.url.startsWith(`${target.origin()}/a/`)).toBe(true);
    const response = await get(capability.url);
    expect(response.status).toBe(200);
    expect(response.body).toBe(DOCUMENT);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-dns-prefetch-control"]).toBe("off");
    expect(capability.url).not.toContain("#");
    const csp = String(response.headers["content-security-policy"]);
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain(inlineScriptHash("1"));
    // Ancestors come from server configuration, not the minted policy.
    expect(csp).toContain("frame-ancestors http://127.0.0.1:34121");
    expect(csp).not.toContain("127.0.0.1:*");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers.location).toBeUndefined();
    const head = await get(capability.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    // Cookies are neither required nor honoured.
    expect(
      (await get(capability.url, { headers: { cookie: "orkestrator_session=x" } })).status,
    ).toBe(200);
  });

  test("rejects other paths, tampered, revoked and expired capabilities without redirecting", async () => {
    let now = Date.now();
    const target = await start(() => now);
    const capability = mint(target, { ttlMs: 5_000 });
    const url = new URL(capability.url);
    const token = url.pathname.slice(3);
    const tampered = `${url.origin}/a/${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    for (const path of [
      "/",
      "/a",
      "/a/",
      `/a/${token}/x`,
      `/a/${token}?u=https://evil.example`,
      "/api/state",
      "/favicon.ico",
      `/A/${token}`,
    ]) {
      const response = await get(`${url.origin}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.location).toBeUndefined();
    }
    expect((await get(tampered)).status).toBe(404);
    expect((await get(capability.url, { method: "POST" })).status).toBe(405);
    expect((await get(capability.url, { host: "evil.example" })).status).toBe(421);
    expect((await get(capability.url, { host: `127.0.0.1:${url.port}` })).status).toBe(421);

    target.revoke(capability.generation);
    expect((await get(capability.url)).status).toBe(404);

    const second = mint(target, { ttlMs: 5_000 });
    target.revokeArtifact("art_content001");
    expect((await get(second.url)).status).toBe(404);

    const third = mint(target, { ttlMs: 5_000 });
    now += 5_001;
    expect((await get(third.url)).status).toBe(410);
  });

  test("re-verifies the bytes' hash on every request", async () => {
    const target = await start();
    let bytes = BYTES;
    const capability = mint(target, { load: async () => bytes });
    expect((await get(capability.url)).status).toBe(200);
    bytes = new TextEncoder().encode(DOCUMENT.replace("hi", "changed"));
    const response = await get(capability.url);
    expect(response.status).toBe(500);
    expect(response.body).not.toContain("changed");
    // The mismatch revokes the capability.
    bytes = BYTES;
    expect((await get(capability.url)).status).toBe(404);
  });

  test("refuses policies it did not generate and bounds its table", async () => {
    const target = await start();
    expect(() => mint(target, { contentSecurityPolicy: "default-src *" })).toThrow();
    expect(() =>
      mint(target, { contentSecurityPolicy: CSP.replace("connect-src 'none'", "connect-src *") }),
    ).toThrow();
    expect(() => mint(target, { preparedSha256: "abc" })).toThrow();
    await target.close();
    server = await LoopbackArtifactContentServer.start({ frameAncestors: [], maxEntries: 3 });
    const minted = Array.from({ length: 5 }, () => mint(server!));
    expect(server.size()).toBe(3);
    expect((await get(minted[0]!.url)).status).toBe(404);
    expect((await get(minted[4]!.url)).status).toBe(200);
  });

  test("the desktop trusted shell origin is a permitted frame ancestor", async () => {
    server = await LoopbackArtifactContentServer.start({
      frameAncestors: [DESKTOP_ARTIFACT_SHELL_ORIGIN, "http://127.0.0.1:*"],
    });
    const response = await get(mint(server).url);
    expect(String(response.headers["content-security-policy"])).toContain(
      `frame-ancestors ${DESKTOP_ARTIFACT_SHELL_ORIGIN} http://127.0.0.1:*`,
    );
    expect(() => buildInteractiveCsp([], ["other-scheme://viewer"])).toThrow();
  });

  test("hosted mode uses the configured different-site origin", async () => {
    server = await LoopbackArtifactContentServer.start({
      frameAncestors: ["https://app.example.com"],
      publicOrigin: "https://artifacts.example-usercontent.net",
    });
    const capability = mint(server);
    expect(capability.url.startsWith("https://artifacts.example-usercontent.net/a/")).toBe(true);
    const local = `http://127.0.0.1:${server.port()}${new URL(capability.url).pathname}`;
    expect((await get(local, { host: "artifacts.example-usercontent.net" })).status).toBe(200);
    expect((await get(local)).status).toBe(421);
    await expect(
      LoopbackArtifactContentServer.start({
        frameAncestors: [],
        publicOrigin: "https://x.example/path",
      }),
    ).rejects.toThrow();
  });

  test("re-checks authorization on every request and fails closed", async () => {
    const target = await start();
    let allowed = true;
    let calls = 0;
    let loads = 0;
    const capability = mint(target, {
      authorize: async () => {
        calls++;
        return allowed;
      },
      load: async () => {
        loads++;
        return BYTES;
      },
    });
    expect((await get(capability.url)).status).toBe(200);
    expect((await get(capability.url, { method: "HEAD" })).status).toBe(200);
    expect(calls).toBe(2);
    // The publication was revoked (or its owner/environment deleted) after minting.
    allowed = false;
    const denied = await get(capability.url);
    expect(denied.status).toBe(404);
    expect(denied.body).not.toContain("hi");
    expect(loads).toBe(2);
    // The denial revoked the capability: re-allowing does not resurrect it.
    allowed = true;
    expect((await get(capability.url)).status).toBe(404);
    expect(target.size()).toBe(0);

    // A throwing check denies too.
    const throwing = mint(target, {
      authorize: async () => {
        throw new Error("environment gone");
      },
    });
    expect((await get(throwing.url)).status).toBe(404);
    // Without a check, behaviour is unchanged (expiry and revocation only).
    expect((await get(mint(target).url)).status).toBe(200);
  });

  test("the loopback content host never matches an application host", async () => {
    server = await LoopbackArtifactContentServer.start({ frameAncestors: [] });
    expect(server.origin()).toMatch(/^http:\/\/localhost:\d+$/);
    const stale = mint(server);
    // The application turns out to be served on localhost: the content origin moves to 127.0.0.1.
    expect(server.configureApplicationOrigins(["http://localhost:4100/"])).toMatchObject({
      available: true,
      origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    });
    expect((await get(stale.url)).status).toBe(421);
    const fresh = mint(server);
    expect(fresh.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect((await get(fresh.url)).status).toBe(200);
    // Application on 127.0.0.1 only: localhost again.
    server.configureApplicationOrigins(["http://127.0.0.1:4100", "http://100.101.102.103:4100"]);
    expect(server.origin()).toMatch(/^http:\/\/localhost:\d+$/);
    // Both loopback names in use: there is no separate loopback origin, so live viewing is off.
    const status = server.configureApplicationOrigins([
      "http://127.0.0.1:4100",
      "http://localhost:1420",
    ]);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN");
    expect(server.origin()).toBeNull();
    expect(() => mint(server!)).toThrow();
  });

  test("a hosted content origin on the application's site disables live viewing", async () => {
    server = await LoopbackArtifactContentServer.start({
      frameAncestors: ["https://app.example.com"],
      publicOrigin: "https://artifacts.example.com",
      applicationOrigins: ["https://app.example.com"],
    });
    expect(server.status()).toMatchObject({ available: false, origin: null });
    expect(server.status().reason).toContain("same site");
    expect(() => mint(server!)).toThrow();
    // A different registrable site is accepted.
    expect(
      server.configureApplicationOrigins(["https://app.example.org", "http://127.0.0.1:4100"]),
    ).toMatchObject({ available: true, origin: "https://artifacts.example.com" });
    expect(mint(server).url.startsWith("https://artifacts.example.com/a/")).toBe(true);
  });

  test("frame ancestors can be narrowed after start and apply to new responses", async () => {
    server = await LoopbackArtifactContentServer.start({
      frameAncestors: [DESKTOP_ARTIFACT_SHELL_ORIGIN],
    });
    server.setFrameAncestors([DESKTOP_ARTIFACT_SHELL_ORIGIN, "http://127.0.0.1:4100"]);
    const csp = String((await get(mint(server).url)).headers["content-security-policy"]);
    expect(csp).toContain(`frame-ancestors ${DESKTOP_ARTIFACT_SHELL_ORIGIN} http://127.0.0.1:4100`);
    expect(() => server!.setFrameAncestors(["*"])).toThrow();
  });

  test("the browser viewer shell frames exactly its document and shares the capability's checks", async () => {
    const target = await start();
    let allowed = true;
    let authorizations = 0;
    let loads = 0;
    const capability = mint(target, {
      authorize: async () => {
        authorizations++;
        return allowed;
      },
      load: async () => {
        loads++;
        return BYTES;
      },
    });
    const documentUrl = new URL(capability.url);
    const shellUrl = new URL(capability.shellUrl);
    expect(shellUrl.origin).toBe(documentUrl.origin);
    expect(shellUrl.pathname).toBe(documentUrl.pathname.replace(/^\/a\//, "/s/"));

    const response = await get(capability.shellUrl);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers.location).toBeUndefined();
    // The shell never loads (or leaks) the document's bytes; it is authorized like it.
    expect(loads).toBe(0);
    expect(authorizations).toBe(1);
    expect(response.body).not.toContain("hi</body>");
    const directives = String(response.headers["content-security-policy"])
      .split(";")
      .map((part) => part.trim());
    const scripts = Array.from(response.body.matchAll(/<script>([\s\S]*?)<\/script>/g));
    expect(scripts).toHaveLength(1);
    expect(directives).toEqual([
      "default-src 'none'",
      `script-src ${inlineScriptHash(scripts[0]![1]!)}`,
      "script-src-attr 'none'",
      expect.stringMatching(/^style-src 'sha256-[A-Za-z0-9+/]{43}='$/),
      "img-src 'none'",
      "font-src 'none'",
      "media-src 'none'",
      "connect-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "object-src 'none'",
      // Path-exact: only this capability's document, nothing else on the origin.
      `frame-src ${capability.url}`,
      `child-src ${capability.url}`,
      "base-uri 'none'",
      "form-action 'none'",
      "sandbox allow-scripts allow-same-origin",
      "frame-ancestors http://127.0.0.1:34121",
    ]);
    expect(scripts[0]![1]).toContain(JSON.stringify(capability.url));
    expect(scripts[0]![1]).not.toContain("</");
    const head = await get(capability.shellUrl, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");

    // The document may be framed by the shell (the content origin) under the application.
    const documentCsp = String((await get(capability.url)).headers["content-security-policy"]);
    expect(documentCsp).toContain(
      `frame-ancestors http://127.0.0.1:34121 ${documentUrl.origin.toLowerCase()}`,
    );

    const token = shellUrl.pathname.slice(3);
    for (const path of [
      "/s",
      "/s/",
      `/s/${token}/x`,
      `/s/${token}?u=https://evil.example`,
      `/S/${token}`,
      `/s/${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
    ]) {
      const other = await get(`${shellUrl.origin}${path}`);
      expect(other.status).toBe(404);
      expect(other.headers.location).toBeUndefined();
    }
    expect((await get(capability.shellUrl, { method: "POST" })).status).toBe(405);
    expect((await get(capability.shellUrl, { host: "evil.example" })).status).toBe(421);

    // A denied authorization revokes the capability for both routes.
    allowed = false;
    expect((await get(capability.shellUrl)).status).toBe(404);
    allowed = true;
    expect((await get(capability.shellUrl)).status).toBe(404);
    expect((await get(capability.url)).status).toBe(404);
  });

  test("the shell is revoked and expires with its capability", async () => {
    let now = Date.now();
    const target = await start(() => now);
    const first = mint(target, { ttlMs: 5_000 });
    expect((await get(first.shellUrl)).status).toBe(200);
    target.revoke(first.generation);
    expect((await get(first.shellUrl)).status).toBe(404);
    const second = mint(target, { ttlMs: 5_000 });
    target.revokeArtifact("art_content001");
    expect((await get(second.shellUrl)).status).toBe(404);
    const third = mint(target, { ttlMs: 5_000 });
    now += 5_001;
    expect((await get(third.shellUrl)).status).toBe(410);
    expect((await get(third.url)).status).toBe(404);
  });

  test("the shell's ancestors are snapshotted at mint like the document's", async () => {
    server = await LoopbackArtifactContentServer.start({
      frameAncestors: [DESKTOP_ARTIFACT_SHELL_ORIGIN, "http://127.0.0.1:4100"],
    });
    const capability = mint(server);
    server.setFrameAncestors([DESKTOP_ARTIFACT_SHELL_ORIGIN]);
    const csp = String((await get(capability.shellUrl)).headers["content-security-policy"]);
    expect(csp).toContain(`frame-ancestors ${DESKTOP_ARTIFACT_SHELL_ORIGIN} http://127.0.0.1:4100`);
    const later = String((await get(mint(server).shellUrl)).headers["content-security-policy"]);
    expect(later).toContain(`frame-ancestors ${DESKTOP_ARTIFACT_SHELL_ORIGIN}`);
    expect(later).not.toContain("127.0.0.1:4100");
  });

  test("site approximation errs towards 'same site'", () => {
    expect(approximateSite("app.example.com")).toBe("example.com");
    expect(approximateSite("a.b.example.co.uk")).toBe("example.co.uk");
    expect(approximateSite("127.0.0.1")).toBe("127.0.0.1");
    expect(hostsShareSite("artifacts.example.com", "app.example.com")).toBe(true);
    expect(hostsShareSite("example.com", "x.example.com")).toBe(true);
    expect(hostsShareSite("usercontent.example.net", "app.example.com")).toBe(false);
    expect(hostsShareSite("localhost", "127.0.0.1")).toBe(false);
    expect(hostsShareSite("a.example.co.uk", "b.example.co.uk")).toBe(true);
  });
});
