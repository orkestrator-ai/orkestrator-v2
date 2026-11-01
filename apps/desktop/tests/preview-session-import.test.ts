import { afterEach, describe, expect, mock, test } from "bun:test";

import { request as httpRequest } from "node:http";

import {
  parseBrowserCookies,
  startPreviewSessionImport,
  type ImportedCookie,
  type PreviewSessionImportHandle,
  type PreviewSessionImportResult,
  type SessionCookieWriteResult,
} from "../electron/preview-session-import";
import {
  PreviewTransportManager,
  type PreviewServiceSession,
} from "../electron/preview-transport-manager";

interface PageResponse {
  status: number;
  body: string;
  headers: Record<string, unknown>;
}

const BROWSER_NAVIGATION = {
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

/** A request as a browser sends it: `Host` and `Cookie` cannot be set through `fetch`. */
function visit(
  url: string,
  headers: Record<string, string>,
  options: { method?: string; address?: string } = {},
): Promise<PageResponse> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: options.address ?? "127.0.0.1",
        port: Number(parsed.port),
        path: parsed.pathname,
        method: options.method ?? "GET",
        agent: false,
        headers: { host: parsed.host, ...headers },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("parseBrowserCookies", () => {
  test("keeps names and raw values, so a signed value still verifies", () => {
    expect(
      parseBrowserCookies("a=1; better-auth.session_token=abc.def%3D; empty=").cookies,
    ).toEqual([
      { name: "a", value: "1" },
      { name: "better-auth.session_token", value: "abc.def%3D" },
      { name: "empty", value: "" },
    ]);
  });

  test("never copies Orkestrator's own cookies, whatever their case", () => {
    const result = parseBrowserCookies(
      "orkestrator_gateway_auth=x; ORKESTRATOR_GATEWAY_AUTH=x; __Host-orkestrator-preview=x; app=1",
    );
    expect(result.cookies).toEqual([{ name: "app", value: "1" }]);
    expect(result.skipped).toBe(3);
  });

  test("skips malformed pairs and bounds the count", () => {
    expect(parseBrowserCookies("=novalue; noequals; bad name=1; ok=1")).toEqual({
      cookies: [{ name: "ok", value: "1" }],
      skipped: 3,
    });
    const many = Array.from({ length: 70 }, (_, index) => `c${index}=1`).join("; ");
    const bounded = parseBrowserCookies(many);
    expect(bounded.cookies).toHaveLength(64);
    expect(bounded.skipped).toBe(6);
  });

  test("an absent header is empty", () => {
    expect(parseBrowserCookies(undefined)).toEqual({ cookies: [], skipped: 0 });
  });
});

describe("startPreviewSessionImport", () => {
  const handles: PreviewSessionImportHandle[] = [];
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.cancel();
  });

  async function start(
    options: {
      write?: (cookies: ImportedCookie[]) => Promise<SessionCookieWriteResult>;
      ttlMs?: number;
    } = {},
  ) {
    let url = "";
    const results: PreviewSessionImportResult[] = [];
    const write = mock(
      options.write ??
        (async (cookies: ImportedCookie[]) => ({ imported: cookies.length, skipped: 0 })),
    );
    const handle = await startPreviewSessionImport({
      openExternal: (opened) => {
        url = opened;
      },
      write,
      onSettled: (result) => results.push(result),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    });
    handles.push(handle);
    return { url, write, results, handle };
  }

  const refusesConnection = (url: string) =>
    expect(visit(url, BROWSER_NAVIGATION)).rejects.toThrow();

  test("opens a random localhost address, copies the cookies once, then closes", async () => {
    const first = await start();
    const second = await start();
    expect(new URL(first.url).hostname).toBe("localhost");
    expect(first.url).not.toBe(second.url);

    const page = await visit(first.url, {
      ...BROWSER_NAVIGATION,
      cookie: "session=secret-value; orkestrator_gateway_auth=gateway-value",
    });
    expect(page.status).toBe(200);
    expect(first.write).toHaveBeenCalledWith([{ name: "session", value: "secret-value" }]);
    expect(first.results).toEqual([{ kind: "imported", imported: 1, skipped: 1 }]);
    expect(page.body).not.toContain("secret-value");
    expect(page.body).not.toContain("gateway-value");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    await refusesConnection(first.url);
  });

  test("also answers on ::1, so localhost cannot resolve to another server", async () => {
    const { url, results } = await start();
    const page = await visit(
      url,
      { ...BROWSER_NAVIGATION, cookie: "a=1" },
      { address: "::1" },
    ).catch((error: NodeJS.ErrnoException) => {
      // A host without IPv6 loopback has nothing to shadow.
      if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") return null;
      throw error;
    });
    if (page) expect(results).toEqual([{ kind: "imported", imported: 1, skipped: 0 }]);
  });

  test.each([
    ["another host name", { host: "127.0.0.1:1" }],
    ["a rebound host name", { host: "attacker.example" }],
    ["another site's request", { "sec-fetch-site": "cross-site" }],
    ["a same-site request", { "sec-fetch-site": "same-site" }],
    ["a fetch", { "sec-fetch-mode": "cors" }],
    ["a frame", { "sec-fetch-dest": "iframe" }],
    ["a prefetch", { "sec-purpose": "prefetch" }],
    ["a legacy prefetch", { purpose: "prefetch" }],
  ] as Array<[string, Record<string, string>]>)(
    "%s is refused without using up the link",
    async (_name, headers) => {
      const { url, write, results } = await start();
      const refused = await visit(url, { ...BROWSER_NAVIGATION, cookie: "a=1", ...headers });
      expect(refused.status).toBe(403);
      expect(write).not.toHaveBeenCalled();
      expect(results).toEqual([]);

      await visit(url, { ...BROWSER_NAVIGATION, cookie: "a=1" });
      expect(results).toEqual([{ kind: "imported", imported: 1, skipped: 0 }]);
    },
  );

  test("a write is refused without using up the link", async () => {
    const { url, write } = await start();
    const refused = await visit(url, { cookie: "a=1" }, { method: "POST" });
    expect(refused.status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });

  test("another path, such as the favicon, neither copies nor uses up the link", async () => {
    const { url, write, results } = await start();
    const other = new URL(url);
    other.pathname = "/favicon.ico";
    expect((await visit(other.toString(), { cookie: "a=1" })).status).toBe(404);
    other.pathname = "/session-import/guess";
    expect((await visit(other.toString(), BROWSER_NAVIGATION)).status).toBe(404);
    expect(write).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  test("a browser without Fetch Metadata can still use its own link", async () => {
    const { url, results } = await start();
    await visit(url, { cookie: "a=1" });
    expect(results).toEqual([{ kind: "imported", imported: 1, skipped: 0 }]);
  });

  test("a browser with no cookies says so, and the link has ended", async () => {
    const { url, write, results } = await start();
    const page = await visit(url, BROWSER_NAVIGATION);
    expect(page.body).toContain("No sign-in found");
    expect(write).not.toHaveBeenCalled();
    expect(results).toEqual([{ kind: "empty" }]);
    await refusesConnection(url);
  });

  test("only reserved cookies count as no sign-in", async () => {
    const { url, results } = await start();
    await visit(url, { ...BROWSER_NAVIGATION, cookie: "orkestrator_gateway_auth=x" });
    expect(results).toEqual([{ kind: "empty" }]);
  });

  test("cookies the session refuses all count as nothing copied", async () => {
    const { url, results } = await start({
      write: async (cookies) => ({ imported: 0, skipped: cookies.length }),
    });
    const page = await visit(url, { ...BROWSER_NAVIGATION, cookie: "__Host-a=1" });
    expect(page.body).toContain("Nothing copied");
    expect(results).toEqual([{ kind: "empty" }]);
  });

  test("a failed write is reported without its error reaching the page", async () => {
    const { url, results } = await start({
      write: async () => {
        throw new Error("private detail");
      },
    });
    const page = await visit(url, { ...BROWSER_NAVIGATION, cookie: "a=1" });
    expect(page.status).toBe(500);
    expect(page.body).not.toContain("private detail");
    expect(results).toEqual([{ kind: "failed" }]);
  });

  test("an unopened link expires and closes", async () => {
    const { url, results } = await start({ ttlMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(results).toEqual([{ kind: "expired" }]);
    await refusesConnection(url);
  });

  test("a cancelled import reports nothing and closes", async () => {
    const { url, results, handle, write } = await start();
    handle.cancel();
    await refusesConnection(url);
    expect(results).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  test("a browser that fails to open leaves no listener behind", async () => {
    let opened = "";
    await expect(
      startPreviewSessionImport({
        openExternal: (url) => {
          opened = url;
          throw new Error("no browser");
        },
        write: async () => ({ imported: 0, skipped: 0 }),
        onSettled: () => undefined,
      }),
    ).rejects.toThrow("no browser");
    await refusesConnection(opened);
  });
});

describe("PreviewTransportManager session cookies", () => {
  function transport(options: { remote?: boolean; refuse?: string } = {}) {
    const set = mock(async (details: { name: string }) => {
      if (details.name === options.refuse) throw new Error("refused");
    });
    const partitions: string[] = [];
    const manager = new PreviewTransportManager({
      invoke: async () => undefined as never,
      tunnelUrl: () => null,
      isRemote: () => options.remote === true,
      partitionFor: (target) => `persist:${target.serviceId}`,
      sessionFor: (partition) => {
        partitions.push(partition);
        return { cookies: { set } } as unknown as PreviewServiceSession;
      },
      clientKey: "session-import",
    });
    return { manager, set, partitions };
  }
  const target = { backendInstanceId: "bk_backend_1", serviceId: "svc_aaaaaaaa" };

  test("is available only on a local connection", () => {
    expect(transport().manager.sessionImportAvailable()).toBe(true);
    expect(transport({ remote: true }).manager.sessionImportAvailable()).toBe(false);
  });

  test("stores HttpOnly host-only cookies in that service's partition, on any ingress port", async () => {
    const { manager, set, partitions } = transport();
    const before = Date.now() / 1000;
    await expect(
      manager.importSessionCookies(target, [{ name: "session", value: "abc.def%3D" }]),
    ).resolves.toEqual({ imported: 1, skipped: 0 });
    expect(partitions).toEqual(["persist:svc_aaaaaaaa"]);
    const details = set.mock.calls[0]![0] as unknown as Record<string, unknown> & {
      expirationDate: number;
    };
    expect(details).toMatchObject({
      url: "http://127.0.0.1/",
      name: "session",
      value: "abc.def%3D",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
    });
    expect(details).not.toHaveProperty("domain");
    expect(details.expirationDate).toBeGreaterThan(before);
  });

  test("a cookie the session refuses counts as skipped, not as a failure", async () => {
    const { manager } = transport({ refuse: "__Host-a" });
    await expect(
      manager.importSessionCookies(target, [
        { name: "__Host-a", value: "1" },
        { name: "b", value: "2" },
      ]),
    ).resolves.toEqual({ imported: 1, skipped: 1 });
  });
});
