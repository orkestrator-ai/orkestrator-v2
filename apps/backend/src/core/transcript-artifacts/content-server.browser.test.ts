/**
 * The served policy in a real Chromium iframe: the prepared document runs
 * only its hashed scripts inside an opaque-origin sandbox, reports readiness
 * to a permitted ancestor, makes no network requests, and refuses to render
 * inside a non-permitted ancestor. Skipped without Chromium.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { chromium, type Browser } from "playwright-core";

import { resolveDesignChromiumPath } from "../design/index.js";
import { LoopbackArtifactContentServer } from "./content-server.js";
import { TranscriptInteractivePreparer } from "./interactive-prepare.js";

const CHROMIUM = resolveDesignChromiumPath();
if (!CHROMIUM) console.warn("[content-server.browser.test] skipped: no Chromium executable");
const browserTest = CHROMIUM ? test : test.skip;
const COOKIE_CANARY = `canary-cookie-${Math.random().toString(36).slice(2)}`;

function parentServer(): Promise<{
  server: Server;
  origin: string;
  setFrame: (url: string) => void;
}> {
  let frame = "about:blank";
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // The application's session cookie: it must never reach the content origin.
      "set-cookie": `ork_session=${COOKIE_CANARY}; Path=/; SameSite=Lax`,
    });
    response.end(`<!doctype html><html><body><script>
      window.messages = [];
      window.addEventListener("message", (event) => {
        const frame = document.querySelector("iframe");
        window.messages.push({ fromFrame: event.source === frame.contentWindow, origin: event.origin, data: event.data });
      });
    </script><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${frame}"></iframe></body></html>`);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        setFrame: (url) => (frame = url),
      }),
    ),
  );
}

describe("served executable document in Chromium", () => {
  let browser: Browser | undefined;
  let content: LoopbackArtifactContentServer | undefined;
  const parents: Server[] = [];
  beforeAll(async () => {
    if (CHROMIUM) browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await content?.close();
    for (const server of parents) server.close();
  });

  browserTest(
    "runs inside a permitted ancestor's sandboxed iframe and is refused elsewhere",
    async () => {
      const allowed = await parentServer();
      const denied = await parentServer();
      parents.push(allowed.server, denied.server);
      const html = readFileSync(path.join(import.meta.dir, "fixtures", "calculator.html"), "utf8");
      const preparer = new TranscriptInteractivePreparer({ frameAncestors: [allowed.origin] });
      const prepared = await preparer.prepare({
        artifactId: "art_served0001",
        revision: 1,
        html,
        dependencyIds: [],
        assets: [],
      });
      if (!prepared.ok) throw new Error("preparation failed");
      content = await LoopbackArtifactContentServer.start({ frameAncestors: [allowed.origin] });
      const bytes = new TextEncoder().encode(prepared.prepared.document);
      const capability = content.mint({
        artifactId: "art_served0001",
        revision: 1,
        preparedSha256: prepared.prepared.documentSha256,
        contentSecurityPolicy: prepared.prepared.contentSecurityPolicy,
        load: async () => bytes,
      });
      allowed.setFrame(capability.url);
      denied.setFrame(capability.url);

      const context = await browser!.newContext();
      const requests: string[] = [];
      const contentCookies: string[] = [];
      context.on("request", (request) => {
        requests.push(new URL(request.url()).origin);
        if (new URL(request.url()).origin === content!.origin())
          void request
            .allHeaders()
            .then((headers) => contentCookies.push(headers.cookie ?? ""))
            .catch(() => undefined);
      });
      const page = await context.newPage();
      await page.goto(allowed.origin);
      await page.waitForFunction(
        () => (window as unknown as { messages: unknown[] }).messages.length > 0,
        undefined,
        { timeout: 10_000 },
      );
      const messages = (await page.evaluate(
        () => (window as unknown as { messages: unknown[] }).messages,
      )) as Array<{
        fromFrame: boolean;
        origin: string;
        data: { type: string; nonce: string };
      }>;
      expect(messages[0]).toMatchObject({
        fromFrame: true,
        origin: "null",
        data: { type: "ready", nonce: prepared.prepared.readinessNonce },
      });
      // The authored calculator ran under its hash: the frame computed 60.
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      expect((await frame.locator("#total").textContent())?.trim()).toBe("60");
      // Only the parent and the one capability request were made.
      expect(new Set(requests)).toEqual(new Set([allowed.origin, content.origin()!]));
      // The application origin (127.0.0.1) holds a session cookie; the content
      // origin is a different host name, so the browser never sent it there.
      expect((await context.cookies(allowed.origin)).map((cookie) => cookie.value)).toContain(
        COOKIE_CANARY,
      );
      expect(contentCookies.length).toBeGreaterThan(0);
      expect(contentCookies.join(" ")).not.toContain(COOKIE_CANARY);
      // Authored code cannot read the parent's cookie or its own (opaque origin).
      expect(
        await frame.evaluate(() => {
          const reads: string[] = [];
          try {
            reads.push(document.cookie);
          } catch {
            reads.push("denied");
          }
          try {
            reads.push(parent.document.cookie);
          } catch {
            reads.push("denied");
          }
          return reads.join(",");
        }),
      ).toBe("denied,denied");

      const deniedPage = await context.newPage();
      await deniedPage.goto(denied.origin);
      await deniedPage.waitForTimeout(1_500);
      expect(
        await deniedPage.evaluate(
          () => (window as unknown as { messages: unknown[] }).messages.length,
        ),
      ).toBe(0);
      await context.close();
    },
    60_000,
  );
});
