import {
  chromium,
  firefox,
  webkit,
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { previewFixtureSourceMap } from "../../test-fixtures/preview-app/server.ts";
import { startLoopbackProxy } from "./loopback-proxy";

/**
 * Real Chromium, Firefox and WebKit against the real private-origin listener:
 * top-level bootstrap,
 * app scripts/assets/WebSockets at the service's own origin, grant replay,
 * per-service isolation, cross-site writes between sibling services,
 * revocation, and (with a Vite fixture installed) HMR in the page.
 *
 * Run: `bunx playwright test --config e2e/preview/playwright.preview.config.ts`
 * Vite: add `ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite`.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

interface Ready {
  port: number;
  domain: string;
  spki: string;
  services: string[];
  /** Why the `ipv6` service (a fixture bound only to `::1`) is absent, if it is. */
  ipv6Unavailable: string | null;
  gateway: string;
  redirectPort: number;
}
interface Grant {
  action: string;
  attachmentId: string;
  grant: string;
  origin: string;
}

let harness: ChildProcessByStdio<Writable, Readable, null>;
let ready: Ready;
let browser: Browser;
let proxy: Awaited<ReturnType<typeof startLoopbackProxy>>;
let engine: string;

function newContext(options: BrowserContextOptions = {}) {
  // Chromium trusts the exact test leaf; Firefox/WebKit bypass validation only
  // in this throwaway context. No system trust store or browser profile changes.
  return browser.newContext({ ...options, ignoreHTTPSErrors: engine !== "chromium" });
}
const waiting: Array<{ type: string; resolve: (message: unknown) => void }> = [];

/** Wait for the harness's next `type` message, optionally sending a command first. */
function next<T>(type: string, command?: string): Promise<T> {
  return new Promise((resolve) => {
    waiting.push({ type, resolve: resolve as (message: unknown) => void });
    if (command) harness.stdin.write(`${command}\n`);
  });
}

test.beforeAll(async ({ browserName }) => {
  engine = browserName;
  harness = spawn("bun", ["apps/backend/src/preview-browser-harness.ts"], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, NODE_ENV: "test" },
  });
  createInterface({ input: harness.stdout }).on("line", (line) => {
    let message: { type?: string };
    try {
      message = JSON.parse(line) as { type?: string };
    } catch {
      return;
    }
    const index = waiting.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) waiting.splice(index, 1)[0]!.resolve(message);
  });
  ready = await next<Ready>("ready");
  proxy = await startLoopbackProxy(ready);
  browser = await { chromium, firefox, webkit }[browserName].launch({
    proxy: { server: proxy.server, bypass: "127.0.0.1" },
    args:
      browserName === "chromium"
        ? [
            // Trust exactly the throwaway test leaf; certificate verification stays on.
            `--ignore-certificate-errors-spki-list=${ready.spki}`,
          ]
        : [],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await proxy?.close();
  harness?.stdin.end();
});

async function signIn(page: Page, service: string, path = "/"): Promise<Grant> {
  const grant = await next<Grant>("grant", `grant ${service} ${path}`);
  // The same form POST the web client submits (`submitPreviewBootstrap`).
  await page.setContent(
    `<!doctype html><meta name="referrer" content="no-referrer">
     <form method="POST" action="${grant.action}" referrerpolicy="no-referrer">
       <input type="hidden" name="attachment" value="${grant.attachmentId}">
       <input type="hidden" name="grant" value="${grant.grant}">
     </form>`,
  );
  await Promise.all([
    page.waitForURL((url) => url.href === `${grant.origin}${path}`),
    page.evaluate(() => document.querySelector("form")!.submit()),
  ]);
  return grant;
}

test("bootstrap signs in top-level and the app runs unchanged at its own origin", async () => {
  const context = await newContext();
  const page = await context.newPage();
  const grant = await signIn(page, "app");
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "browser-app");
  expect(
    await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--marker")),
  ).toBe('"browser-app"');
  // Neither the grant nor the session code remains in the address.
  expect(page.url()).toBe(`${grant.origin}/`);
  expect(page.url()).not.toContain(grant.grant);
  // The transport session is HttpOnly and host-only; application script cannot read it.
  expect(await page.evaluate(() => document.cookie)).not.toContain("orkestrator-preview");
  const cookies = await context.cookies(grant.origin);
  const session = cookies.find((cookie) => cookie.name === "__Host-orkestrator-preview");
  expect(session).toMatchObject({ httpOnly: true, secure: true, path: "/" });
  await context.close();
});

test("the application's WebSocket connects through its origin with its subprotocol", async () => {
  const context = await newContext();
  const page = await context.newPage();
  await signIn(page, "app");
  const received = await page.evaluate(
    () =>
      new Promise<{ protocol: string; data: string }>((resolve, reject) => {
        const socket = new WebSocket(`wss://${location.host}/ws`, "fixture.v1");
        socket.onmessage = (event) => {
          resolve({ protocol: socket.protocol, data: String(event.data) });
          socket.close();
        };
        socket.onerror = () => reject(new Error("websocket failed"));
      }),
  );
  expect(received.protocol).toBe("fixture.v1");
  expect(received.data).toContain("browser-app");
  await context.close();
});

test("a grant works once; replaying the form is refused", async () => {
  const context = await newContext();
  const page = await context.newPage();
  const grant = await signIn(page, "app");
  const replay = await context.newPage();
  await replay.setContent(
    `<form method="POST" action="${grant.action}">
       <input type="hidden" name="attachment" value="${grant.attachmentId}">
       <input type="hidden" name="grant" value="${grant.grant}">
     </form>`,
  );
  await Promise.all([
    replay.waitForURL(grant.action),
    replay.evaluate(() => document.querySelector("form")!.submit()),
  ]);
  await expect(replay.locator("body")).toContainText(/expired|refused/i);
  await context.close();
});

test("sibling services have separate storage and cannot write to each other", async () => {
  const context = await newContext();
  const app = await context.newPage();
  const appGrant = await signIn(app, "app");
  const other = await context.newPage();
  const otherGrant = await signIn(other, "other");
  expect(new URL(appGrant.origin).host).not.toBe(new URL(otherGrant.origin).host);

  await app.evaluate(() => {
    localStorage.setItem("shared-name", "app");
    document.cookie = "shared=app; path=/";
  });
  expect(await other.evaluate(() => localStorage.getItem("shared-name"))).toBeNull();
  expect(await other.evaluate(() => document.cookie)).not.toContain("shared=app");

  // A same-site sibling POST carries the other service's session cookie, so the
  // backend must refuse it before forwarding.
  type Counters = { counters: Record<string, number> };
  const before = (await next<Counters>("metrics", "metrics")).counters;
  const status = await app.evaluate(async (target) => {
    try {
      await fetch(`${target}/echo`, {
        method: "POST",
        body: "from-app",
        credentials: "include",
        mode: "no-cors",
      });
      return "sent";
    } catch {
      return "blocked";
    }
  }, otherGrant.origin);
  expect(status).toBe("sent");
  const otherRequests = await next<{ requests: Array<{ method: string; path: string }> }>(
    "fixture-requests",
    "fixture-requests other",
  );
  expect(otherRequests.requests.filter((request) => request.method === "POST")).toEqual([]);
  // The browser sent it and the backend refused it (not a browser-side block).
  const after = (await next<Counters>("metrics", "metrics")).counters;
  const refused = (counters: Record<string, number>) => counters["http.rejected{forbidden}"] ?? 0;
  expect(refused(after)).toBe(refused(before) + 1);
  await context.close();
});

test("sibling services cannot read each other in the background; links between them still open", async () => {
  const context = await newContext();
  const app = await context.newPage();
  await signIn(app, "app");
  const otherGrant = await signIn(await context.newPage(), "other");

  type Counters = { counters: Record<string, number> };
  const refused = (counters: Record<string, number>) => counters["http.rejected{forbidden}"] ?? 0;
  const before = refused((await next<Counters>("metrics", "metrics")).counters);
  const otherBefore = (await next<FixtureRequests>("fixture-requests", "fixture-requests other"))
    .requests.length;
  // A fetch, an image and a frame: each carries the sibling's session cookie.
  const outcome = await app.evaluate(async (target) => {
    const fetched = await fetch(`${target}/echo`, { credentials: "include", mode: "no-cors" })
      .then((response) => response.type)
      .catch(() => "blocked");
    const image = await new Promise<string>((resolve) => {
      const element = new Image();
      element.onload = () => resolve("loaded");
      element.onerror = () => resolve("error");
      element.src = `${target}/assets/small.png`;
    });
    const framed = await new Promise<string>((resolve) => {
      const frame = document.createElement("iframe");
      frame.onload = () => resolve("settled");
      frame.src = `${target}/`;
      document.body.append(frame);
    });
    return { fetched, image, framed };
  }, otherGrant.origin);
  expect(outcome).toEqual({ fetched: "opaque", image: "error", framed: "settled" });
  const otherAfter = (
    await next<FixtureRequests>("fixture-requests", "fixture-requests other")
  ).requests.slice(otherBefore);
  expect(otherAfter).toEqual([]);
  expect(refused((await next<Counters>("metrics", "metrics")).counters)).toBe(before + 3);

  // A top-level link from one service to its sibling is a document
  // navigation and opens it with the sibling's session.
  await app.evaluate((target) => {
    const link = document.createElement("a");
    link.href = `${target}/`;
    link.textContent = "sibling";
    link.id = "sibling-link";
    document.body.append(link);
  }, otherGrant.origin);
  await Promise.all([app.waitForURL(`${otherGrant.origin}/`), app.click("#sibling-link")]);
  await expect(app.locator("body")).toHaveAttribute("data-loaded", "browser-other");
  await context.close();
});

test("same-service frames work directly but external redirect returns are refused", async () => {
  const context = await newContext();
  const page = await context.newPage();
  const grant = await signIn(page, "app");
  const direct = `${grant.origin}/echo?frame=direct`;
  const returned = `${grant.origin}/echo?frame=returned`;
  const frameStatus = async (url: string, expectedUrl: string) => {
    const response = page.waitForResponse((answer) => answer.url() === expectedUrl);
    await page.evaluate((src) => {
      const frame = document.createElement("iframe");
      frame.src = src;
      document.body.append(frame);
    }, url);
    return response;
  };
  expect((await frameStatus(direct, direct)).status()).toBe(200);
  const before = (await next<FixtureRequests>("fixture-requests", "fixture-requests app")).requests
    .length;
  type Counters = { counters: Record<string, number> };
  const refused = (counters: Record<string, number>) => counters["http.rejected{forbidden}"] ?? 0;
  const deniedBefore = refused((await next<Counters>("metrics", "metrics")).counters);
  const redirect = `https://idp.identity.test:${ready.redirectPort}/?return=${encodeURIComponent(returned)}`;
  const response = await frameStatus(redirect, returned);
  const headers = await response.request().allHeaders();
  if (engine === "chromium") {
    expect(response.status()).toBe(403);
    expect(headers["cookie"]?.includes("__Host-orkestrator-preview=")).toBe(true);
    expect(headers["sec-fetch-site"]).toBe("cross-site");
    expect(headers["sec-fetch-mode"]).toBe("navigate");
    expect(headers["sec-fetch-dest"]).toBe("iframe");
  } else {
    // Firefox/WebKit drop the Lax session cookie on the redirected frame,
    // so authentication refuses it before the Fetch Metadata policy runs.
    expect(response.status()).toBe(401);
    expect("cookie" in headers).toBe(false);
  }
  expect(
    (await next<FixtureRequests>("fixture-requests", "fixture-requests app")).requests.slice(
      before,
    ),
  ).toEqual([]);
  expect(refused((await next<Counters>("metrics", "metrics")).counters)).toBe(deniedBefore + 1);

  // A visible top-level return through the same external redirect still works.
  await page.goto(redirect);
  expect(page.url()).toBe(returned);
  expect(await page.locator("body").innerText()).toContain("browser-app");
  await context.close();
});

test("revocation ends the browser session", async () => {
  const context = await newContext();
  const page = await context.newPage();
  await signIn(page, "app");
  await next("revoked", "revoke");
  const response = await page.reload();
  expect(response?.status()).toBeGreaterThanOrEqual(400);
  await expect(page.locator("body")).not.toHaveAttribute("data-loaded", "browser-app");
  await context.close();
});

interface HostileReport {
  worker: string;
  captured: { url: string; method: string; mode: string; destination: string; code: string | null };
  attempts: Array<{
    kind: string;
    url: string;
    type?: string;
    status?: number;
    body?: string | null;
    error?: string;
  }>;
}
type AccessStats = { stats: { denied: number; pendingSessionCodes: number } };
type FixtureRequests = {
  requests: Array<{ method: string; path: string; authorization: string | null }>;
};
type GatewayRequests = {
  requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    cookieNames: string[];
    status: number | null;
  }>;
  invokes: string[];
};

/** The bootstrap form POST from a fresh top-level page, without assuming where it lands. */
async function submitBootstrap(page: Page, grant: Grant): Promise<void> {
  await page.setContent(
    `<!doctype html><meta name="referrer" content="no-referrer">
     <form method="POST" action="${grant.action}" referrerpolicy="no-referrer">
       <input type="hidden" name="attachment" value="${grant.attachmentId}">
       <input type="hidden" name="grant" value="${grant.grant}">
     </form>`,
  );
  await Promise.all([
    page.waitForURL(`${grant.origin}/__orkestrator_preview/session?**`),
    page.evaluate(() => document.querySelector("form")!.submit()),
  ]);
}

test("a hostile service worker blocks re-sign-in until site data is cleared and reaches no other authority", async () => {
  test.setTimeout(120_000);
  const context = await newContext();
  // Worst case: the same profile is signed in to the control gateway and to a
  // sibling service before the hostile worker runs.
  const { token } = await next<{ token: string }>("gateway-token", "gateway-token");
  const login = await context.request.post(`${ready.gateway}/__orkestrator/login`, {
    form: { token },
    maxRedirects: 0,
  });
  expect(login.status()).toBe(303);
  expect((await context.cookies(ready.gateway)).map((cookie) => cookie.name)).toContain(
    "orkestrator_gateway_auth",
  );
  const otherGrant = await signIn(await context.newPage(), "other");
  const page = await context.newPage();
  const first = await signIn(page, "app");
  const appSession = async () =>
    (await context.cookies(first.origin)).find(
      (cookie) => cookie.name === "__Host-orkestrator-preview",
    )?.value ?? null;
  const firstSession = await appSession();
  expect(firstSession?.startsWith(`${first.attachmentId}.`)).toBe(true);

  // 1. Install the worker. It is told every other authority it could try.
  const bootstrapOrigin = new URL(first.action).origin;
  const targets = new URLSearchParams([
    ["probe", `${otherGrant.origin}/echo`],
    ["probe", `${ready.gateway}/__orkestrator/invoke`],
    ["probe", `${ready.gateway}/__orkestrator/status`],
    ["session", otherGrant.origin],
    ["session", bootstrapOrigin],
  ]);
  await page.goto(`${first.origin}/sw-hostile/install?${targets}`);
  await expect(page.locator("body")).toHaveAttribute("data-hostile-worker", "active");

  const otherBefore = (await next<FixtureRequests>("fixture-requests", "fixture-requests other"))
    .requests.length;
  const gatewayBefore = (await next<GatewayRequests>("gateway-requests", "gateway-requests"))
    .requests.length;
  const statsBefore = (await next<AccessStats>("access-stats", "access-stats")).stats;

  // 2. Re-bootstrap with the worker installed: the grant reaches the bootstrap
  // host (no worker can run there), but the worker answers the session-code
  // redirect itself, so the code never reaches the backend from this browser.
  const second = await next<Grant>("grant", "grant app");
  const resign = await context.newPage();
  await submitBootstrap(resign, second);
  await expect(resign.locator("body")).toHaveAttribute("data-hostile-session", "intercepted");
  const report = JSON.parse(
    (await resign.locator("#hostile-report").textContent()) ?? "",
  ) as HostileReport;
  expect(report.captured).toMatchObject({ method: "GET", mode: "navigate" });
  // The worker sees the one-use session code in the URL, never the grant.
  expect(report.captured.code?.startsWith(`${second.attachmentId}.`)).toBe(true);
  expect(JSON.stringify(report)).not.toContain(second.grant);
  // Re-sign-in is blocked: the browser still holds the first session only.
  expect(await appSession()).toBe(firstSession);

  // Nothing the worker sent anywhere else was readable to it.
  for (const attempt of report.attempts) {
    expect(attempt.type === "basic" || attempt.type === "cors").toBe(false);
    expect(attempt.body ?? null).toBeNull();
  }
  // The code was presented to the sibling's session path and refused there,
  // which also consumed it; the bootstrap host never accepts it.
  const statsAfter = (await next<AccessStats>("access-stats", "access-stats")).stats;
  expect(statsAfter.denied).toBe(statsBefore.denied + 1);
  expect(statsAfter.pendingSessionCodes).toBe(statsBefore.pendingSessionCodes);
  const replay = await newContext();
  const replayPage = await replay.newPage();
  const replayed = await replayPage.goto(report.captured.url);
  expect(replayed?.status()).toBe(403);
  await replay.close();

  // The sibling service: nothing the worker sent reached it. Same-site
  // siblings share `SameSite=Lax` cookies, so the backend refuses the
  // credentialed `no-cors` GET by its Fetch Metadata, and the write and the
  // bearer request as before.
  const otherAfter = (
    await next<FixtureRequests>("fixture-requests", "fixture-requests other")
  ).requests.slice(otherBefore);
  expect(otherAfter).toEqual([]);

  // Control authority: every worker request arrived at the gateway without
  // its cookie or any credential, was refused, and no command ran.
  const gateway = await next<GatewayRequests>("gateway-requests", "gateway-requests");
  const fromWorker = gateway.requests.slice(gatewayBefore);
  if (engine === "webkit") {
    // WebKit refuses these HTTPS-worker -> HTTP-loopback fetches in the
    // browser. Pin both attempted probes and zero gateway traffic.
    const blocked = report.attempts.filter((attempt) => attempt.url.startsWith(ready.gateway));
    expect(blocked).toHaveLength(6);
    expect(blocked.every((attempt) => typeof attempt.error === "string")).toBe(true);
    expect(fromWorker).toEqual([]);
  } else {
    expect(fromWorker.length).toBeGreaterThan(0);
  }
  for (const request of fromWorker) {
    expect(request.cookieNames).not.toContain("orkestrator_gateway_auth");
    expect(request.authorization).toBeNull();
    expect([401, 403]).toContain(request.status);
  }
  expect(gateway.invokes).toEqual([]);

  // 3. A worker that only keeps the code: the code it captured is usable
  // elsewhere, but only as a session for this same service.
  await page.goto(`${first.origin}/sw-hostile/install`);
  await expect(page.locator("body")).toHaveAttribute("data-hostile-worker", "active");
  const third = await next<Grant>("grant", "grant app");
  await submitBootstrap(resign, third);
  await expect(resign.locator("body")).toHaveAttribute("data-hostile-session", "intercepted");
  const kept = JSON.parse(
    (await resign.locator("#hostile-report").textContent()) ?? "",
  ) as HostileReport;
  expect(kept.attempts).toEqual([]);
  expect(await appSession()).toBe(firstSession);
  const elsewhere = await newContext();
  const elsewherePage = await elsewhere.newPage();
  await elsewherePage.goto(kept.captured.url);
  expect(elsewherePage.url()).toBe(`${first.origin}/`);
  await expect(elsewherePage.locator("body")).toHaveAttribute("data-loaded", "browser-app");
  expect((await elsewhere.cookies()).map((cookie) => `${cookie.name}@${cookie.domain}`)).toEqual([
    `__Host-orkestrator-preview@${new URL(first.origin).hostname}`,
  ]);
  expect((await elsewherePage.goto(`${otherGrant.origin}/`))?.status()).toBe(401);
  await elsewhere.close();

  // 4. Clearing this site's data removes the worker and its cookies only; a
  // fresh bootstrap then signs in normally.
  if (engine === "chromium") {
    const cdp = await context.newCDPSession(resign);
    await cdp.send("Storage.clearDataForOrigin", { origin: first.origin, storageTypes: "all" });
  } else {
    // CDP is Chromium-only. Exercise recovery with the portable site APIs.
    await resign.evaluate(async () => {
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        await registration.unregister();
      }
      for (const key of await caches.keys()) await caches.delete(key);
      localStorage.clear();
      sessionStorage.clear();
    });
    await context.clearCookies({ domain: new URL(first.origin).hostname });
  }
  expect(
    await resign.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
  expect(await appSession()).toBeNull();
  expect(
    (await context.cookies(otherGrant.origin)).some(
      (cookie) => cookie.name === "__Host-orkestrator-preview",
    ),
  ).toBe(true);
  const fresh = await context.newPage();
  const recovered = await signIn(fresh, "app");
  await expect(fresh.locator("body")).toHaveAttribute("data-loaded", "browser-app");
  expect(await fresh.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  expect((await appSession())?.startsWith(`${recovered.attachmentId}.`)).toBe(true);
  expect((await next<GatewayRequests>("gateway-requests", "gateway-requests")).invokes).toEqual([]);
  await context.close();
});

/** Requests the named fixture received since `before` (a previous length). */
async function fixtureRequestsSince(name: string, before: number) {
  return (
    await next<FixtureRequests>("fixture-requests", `fixture-requests ${name}`)
  ).requests.slice(before);
}
async function fixtureRequestCount(name: string): Promise<number> {
  return (await next<FixtureRequests>("fixture-requests", `fixture-requests ${name}`)).requests
    .length;
}

test("the page's srcset picks the candidate for the pixel ratio and it decodes through the service origin", async () => {
  for (const [scale, chosen] of [
    [1, "small.png"],
    [2, "large.png"],
  ] as const) {
    const context = await newContext({ deviceScaleFactor: scale });
    const page = await context.newPage();
    const before = await fixtureRequestCount("app");
    const grant = await signIn(page, "app");
    const image = page.locator("img[srcset]");
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.complete))
      .toBe(true);
    expect(
      await image.evaluate((element: HTMLImageElement) => ({
        currentSrc: element.currentSrc,
        naturalWidth: element.naturalWidth,
        naturalHeight: element.naturalHeight,
      })),
    ).toEqual({
      currentSrc: `${grant.origin}/assets/${chosen}`,
      // Density-corrected: 2 px at 1x and 4 px at 2x are both 2 CSS px.
      naturalWidth: 2,
      naturalHeight: 2,
    });
    const paths = (await fixtureRequestsSince("app", before)).map((request) => request.path);
    expect(paths).toContain(`/assets/${chosen}`);
    await context.close();
  }
});

test("a script's source map is served from the page's own origin unchanged", async () => {
  const context = await newContext();
  const page = await context.newPage();
  const grant = await signIn(page, "app");
  const scriptUrl = `${grant.origin}/assets/mapped.js`;
  const mapUrl = `${grant.origin}/assets/mapped.js.map`;
  // Chromium only: DevTools Protocol reports the map URL the engine parsed.
  const cdp = engine === "chromium" ? await context.newCDPSession(page) : null;
  const parsed = cdp
    ? new Promise<{ url: string; sourceMapURL?: string }>((resolve) => {
        cdp.on("Debugger.scriptParsed", (event) => {
          if (event.url === scriptUrl) resolve(event);
        });
      })
    : null;
  await cdp?.send("Debugger.enable");
  const before = await fixtureRequestCount("app");
  await page.addScriptTag({ url: scriptUrl });
  expect(
    await page.evaluate(() => (window as unknown as { mappedMarker?: string }).mappedMarker),
  ).toBe("browser-app");
  // What a debugger does: resolve the comment against the script URL and fetch it.
  const fetched = await page.evaluate(async (url) => {
    const script = await (await fetch(url)).text();
    const reference = /\/\/# sourceMappingURL=(\S+)/.exec(script)?.[1] ?? "";
    const resolved = new URL(reference, url).href;
    const response = await fetch(resolved);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return {
      resolved,
      status: response.status,
      contentType: response.headers.get("content-type"),
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      text: new TextDecoder().decode(bytes),
    };
  }, scriptUrl);
  const expected = previewFixtureSourceMap("browser-app");
  expect(fetched).toEqual({
    resolved: mapUrl,
    status: 200,
    contentType: "application/json",
    sha256: createHash("sha256").update(expected).digest("hex"),
    text: expected,
  });
  const paths = (await fixtureRequestsSince("app", before)).map((request) => request.path);
  expect(paths).toContain("/assets/mapped.js.map");
  if (parsed) {
    const event = await parsed;
    expect(new URL(event.sourceMapURL ?? "", event.url).href).toBe(mapUrl);
    await cdp!.detach();
  }
  await context.close();
});

test("an SPA deep link opens after sign-in and history survives reloads without a sign-in code", async () => {
  const context = await newContext();
  const page = await context.newPage();
  const deep = "/app/deep/route?x=1#h";
  const requestsBefore = await fixtureRequestCount("app");
  const grant = await signIn(page, "app", deep);
  expect(page.url()).toBe(`${grant.origin}${deep}`);
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "browser-app");
  expect(await page.evaluate(() => document.referrer)).toBe("");
  // The bootstrap and session-code redirects add no history entries: only the
  // page that submitted the form precedes the deep link. Firefox replaces
  // that initial `about:blank` entry on the first navigation.
  const before = engine === "firefox" ? 0 : 1;
  expect(await page.evaluate(() => history.length)).toBe(before + 1);

  // Client-side route change, then a full reload of the pushed address.
  const pushed = "/app/next/view?tab=2";
  await page.evaluate((path) => history.pushState({ step: 2 }, "", path), pushed);
  expect(page.url()).toBe(`${grant.origin}${pushed}`);
  const reloaded = await page.reload();
  expect(reloaded?.status()).toBe(200);
  expect(page.url()).toBe(`${grant.origin}${pushed}`);
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "browser-app");
  expect(await page.evaluate(() => history.state)).toEqual({ step: 2 });

  await page.goBack();
  expect(page.url()).toBe(`${grant.origin}${deep}`);
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "browser-app");
  await page.goForward();
  expect(page.url()).toBe(`${grant.origin}${pushed}`);
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "browser-app");

  const paths = (await fixtureRequestsSince("app", requestsBefore)).map((request) => request.path);
  expect(paths).toContain("/app/deep/route");
  expect(paths).toContain("/app/next/view");
  expect(paths.some((path) => path.startsWith("/__orkestrator_preview/"))).toBe(false);

  // Walking Back from the deep link reaches the form page (or nothing)
  // without passing a sign-in URL.
  const visited: string[] = [];
  await page.goBack();
  visited.push(page.url());
  await page.goBack();
  visited.push(page.url());
  expect(visited).toEqual([
    `${grant.origin}${deep}`,
    before ? "about:blank" : `${grant.origin}${deep}`,
  ]);
  for (const url of visited) {
    expect(url).not.toContain("__orkestrator_preview");
    expect(url).not.toContain(grant.grant);
    expect(url).not.toContain(grant.attachmentId);
  }
  await context.close();
});

test("sibling services do not share IndexedDB, BroadcastChannel, Cache Storage or service workers", async () => {
  const context = await newContext();
  const app = await context.newPage();
  const appGrant = await signIn(app, "app");
  const other = await context.newPage();
  const otherGrant = await signIn(other, "other");
  // A second page of the same service is the positive control for each channel.
  const sameService = await context.newPage();
  await sameService.goto(`${appGrant.origin}/app/second`);
  await expect(sameService.locator("body")).toHaveAttribute("data-loaded", "browser-app");

  // IndexedDB: a database written by `app` does not exist for `other`.
  const openDatabase = (page: Page, write: string | null) =>
    page.evaluate(
      (value) =>
        new Promise<{ oldVersion: number; stores: string[]; value: unknown }>((resolve, reject) => {
          let oldVersion = -1;
          const request = indexedDB.open("preview-shared", 1);
          request.onupgradeneeded = (event) => {
            oldVersion = event.oldVersion;
            if (value !== null) request.result.createObjectStore("items");
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const stores = Array.from(db.objectStoreNames);
            if (!stores.includes("items")) {
              db.close();
              resolve({ oldVersion, stores, value: null });
              return;
            }
            const transaction = db.transaction("items", "readwrite");
            const store = transaction.objectStore("items");
            if (value !== null) store.put(value, "owner");
            const read = store.get("owner");
            transaction.oncomplete = () => {
              db.close();
              resolve({ oldVersion, stores, value: read.result });
            };
          };
        }),
      write,
    );
  expect(await openDatabase(app, "app")).toEqual({
    oldVersion: 0,
    stores: ["items"],
    value: "app",
  });
  expect(await openDatabase(sameService, null)).toEqual({
    oldVersion: -1,
    stores: ["items"],
    value: "app",
  });
  expect(await openDatabase(other, null)).toEqual({ oldVersion: 0, stores: [], value: null });

  // BroadcastChannel: same-origin pages hear each other; the sibling does not.
  for (const page of [sameService, other]) {
    await page.evaluate(() => {
      const received: unknown[] = [];
      const channel = new BroadcastChannel("preview-shared");
      channel.onmessage = (event) => received.push(event.data);
      Object.assign(window, { previewChannel: channel, previewReceived: received });
    });
  }
  const receivedOn = (page: Page) =>
    page.evaluate(() => (window as unknown as { previewReceived: unknown[] }).previewReceived);
  await app.evaluate(() => new BroadcastChannel("preview-shared").postMessage("from-app"));
  await expect.poll(() => receivedOn(sameService)).toEqual(["from-app"]);
  await other.waitForTimeout(500);
  expect(await receivedOn(other)).toEqual([]);

  // Cache Storage.
  await app.evaluate(async () => {
    const cache = await caches.open("preview-shared");
    await cache.put("/cached", new Response("app"));
  });
  expect(
    await sameService.evaluate(async () => (await caches.match("/cached"))?.text() ?? null),
  ).toBe("app");
  expect(
    await other.evaluate(async () => ({
      keys: await caches.keys(),
      match: (await caches.match("/cached")) ?? null,
    })),
  ).toEqual({ keys: [], match: null });

  // Service worker: `/sw.js` registered and controlling `app` answers
  // `/sw/marker` there; `other` has no registration and reaches its own app.
  await app.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => app.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  expect(await app.evaluate(async () => (await fetch("/sw/marker")).json())).toEqual({
    worker: "browser-app",
  });
  await other.reload();
  await expect(other.locator("body")).toHaveAttribute("data-loaded", "browser-other");
  expect(
    await other.evaluate(async () => {
      const response = await fetch("/sw/marker");
      return {
        controlled: navigator.serviceWorker.controller !== null,
        registrations: (await navigator.serviceWorker.getRegistrations()).length,
        status: response.status,
        body: await response.text(),
      };
    }),
  ).toEqual({ controlled: false, registrations: 0, status: 404, body: "not found: browser-other" });
  expect(new URL(otherGrant.origin).host).not.toBe(new URL(appGrant.origin).host);
  await context.close();
});

test("preview sign-in and refusal pages cannot be framed; popups open top-level", async () => {
  const context = await newContext();
  const signedIn = await context.newPage();
  const grant = await signIn(signedIn, "app");
  const bootstrapOrigin = new URL(grant.action).origin;
  // A cross-site parent page, and a frameable page on a third origin as the
  // control that a rendered cross-origin frame's text is readable here.
  const framer = "https://framer.example";
  const control = "https://frameable.example";
  for (const origin of [framer, control]) {
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          origin === control
            ? "<!doctype html><body>control frame rendered</body>"
            : "<!doctype html><title>framer</title><body></body>",
      }),
    );
  }
  const page = await context.newPage();
  await page.goto(`${framer}/`);
  const before = await fixtureRequestCount("app");

  const frame = async (name: string, src: string) => {
    const response = page.waitForResponse((answer) => answer.url() === src);
    await page.evaluate(
      ({ name, src }) =>
        new Promise<void>((resolve) => {
          const element = document.createElement("iframe");
          element.name = name;
          element.onload = () => resolve();
          // Some engines fire no load event for a blocked frame.
          setTimeout(resolve, 3_000);
          element.src = src;
          document.body.append(element);
        }),
      { name, src },
    );
    const answer = await response;
    const child = page.frames().find((candidate) => candidate.name() === name);
    const text = child
      ? await child.evaluate(() => document.body?.innerText ?? "").catch(() => "")
      : "";
    return {
      status: answer.status(),
      frameOptions: answer.headers()["x-frame-options"],
      csp: answer.headers()["content-security-policy"],
      text,
    };
  };

  expect((await frame("control", `${control}/`)).text).toContain("control frame rendered");
  // Bootstrap authority (GET: the sign-in explanation page), a session-code
  // URL with a bad code, and the signed-in service itself from a cross-site
  // parent: each answer forbids framing and does not render.
  const bootstrap = await frame("bootstrap", `${bootstrapOrigin}/__orkestrator_preview/bootstrap`);
  const session = await frame(
    "session",
    `${grant.origin}/__orkestrator_preview/session?code=not-a-code`,
  );
  const service = await frame("service", `${grant.origin}/app/framed`);
  expect(bootstrap.status).toBe(405);
  expect(session.status).toBe(403);
  // Cross-site frames carry no Lax session cookie, so authentication refuses
  // them before the Fetch Metadata check (403 from a same-site sibling).
  expect(service.status).toBe(401);
  for (const outcome of [bootstrap, session, service]) {
    expect(outcome.frameOptions).toBe("DENY");
    expect(outcome.csp).toContain("frame-ancestors 'none'");
    expect(outcome.text).not.toMatch(/preview|sign-in|browser-app/i);
  }
  expect(await fixtureRequestsSince("app", before)).toEqual([]);

  // The web client's popup: a blank window, opener cut, then the form POST
  // (`submitPreviewBootstrap` in apps/web/src/lib/preview-external.ts).
  const popupGrant = await next<Grant>("grant", "grant app /app/popup");
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.evaluate((descriptor) => {
      const target = window.open("about:blank", "_blank")!;
      target.opener = null;
      target.document.open();
      target.document.write('<!doctype html><meta name="referrer" content="no-referrer">');
      target.document.close();
      const form = target.document.createElement("form");
      form.method = "POST";
      form.action = descriptor.action;
      form.referrerPolicy = "no-referrer";
      for (const [name, value] of [
        ["attachment", descriptor.attachmentId],
        ["grant", descriptor.grant],
      ]) {
        const input = target.document.createElement("input");
        input.type = "hidden";
        input.name = name!;
        input.value = value!;
        form.append(input);
      }
      target.document.body.append(form);
      form.submit();
    }, popupGrant),
  ]);
  await popup.waitForURL((url) => url.href === `${popupGrant.origin}/app/popup`);
  await expect(popup.locator("body")).toHaveAttribute("data-loaded", "browser-app");
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(popup.url()).not.toContain(popupGrant.grant);

  // A plain cross-site `window.open` is a top-level navigation and opens the
  // signed-in service. The transport adds no Cross-Origin-Opener-Policy (the
  // application's own headers pass through), so that popup keeps its opener.
  const openedUrl = `${grant.origin}/app/opened`;
  const [opened, openedResponse] = await Promise.all([
    context.waitForEvent("page"),
    context.waitForEvent("response", (answer) => answer.url() === openedUrl),
    page.evaluate((url) => void window.open(url, "_blank"), openedUrl),
  ]);
  expect(openedResponse.status()).toBe(200);
  expect(openedResponse.headers()["cross-origin-opener-policy"]).toBeUndefined();
  await expect(opened.locator("body")).toHaveAttribute("data-loaded", "browser-app");
  expect(await opened.evaluate(() => window.opener !== null)).toBe(true);
  await context.close();
});

test("an IPv6-only service loads through its private origin", async () => {
  test.skip(ready.ipv6Unavailable !== null, ready.ipv6Unavailable ?? "");
  const context = await newContext();
  const page = await context.newPage();
  const before = await fixtureRequestCount("ipv6");
  const grant = await signIn(page, "ipv6");
  await expect(page.locator("body")).toHaveAttribute("data-loaded", "browser-ipv6");
  const received = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`wss://${location.host}/ws`, "fixture.v1");
        socket.onmessage = (event) => {
          resolve(String(event.data));
          socket.close();
        };
        socket.onerror = () => reject(new Error("websocket failed"));
      }),
  );
  expect(received).toContain("browser-ipv6");
  expect(page.url()).toBe(`${grant.origin}/`);
  const paths = (await fixtureRequestsSince("ipv6", before)).map((request) => request.path);
  expect(paths).toEqual(expect.arrayContaining(["/", "/assets/app.js", "/ws"]));
  await context.close();
});

test("Vite HMR updates the page in the browser without a reload", async () => {
  test.skip(!ready.services.includes("vite"), "Set ORKESTRATOR_TEST_PREVIEW_VITE_DIR");
  const labelFile = path.join(process.env.ORKESTRATOR_TEST_PREVIEW_VITE_DIR!, "src/label.js");
  const original = await readFile(labelFile, "utf8");
  const context = await newContext();
  const page = await context.newPage();
  try {
    await signIn(page, "vite");
    await expect(page.locator("#app")).toHaveText("preview-vite v1");
    await page.evaluate(() => ((window as unknown as { marker: string }).marker = "same-document"));
    await writeFile(labelFile, 'export const label = "preview-vite v2";\n');
    await expect(page.locator("#app")).toHaveText("preview-vite v2");
    await expect(page.locator("body")).toHaveAttribute("data-hmr-updates", "1");
    // No full reload: the page-scoped marker survived.
    expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe(
      "same-document",
    );
  } finally {
    await writeFile(labelFile, original);
    await context.close();
  }
});
