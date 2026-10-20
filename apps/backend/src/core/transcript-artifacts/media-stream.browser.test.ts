/**
 * Streamed media in a real Chromium: an application-origin page (127.0.0.1)
 * plays and seeks a `<video>` whose source is a media capability on the
 * content origin (localhost), through several single-range requests, with
 * no application cookie reaching the content origin. Skipped without
 * Chromium.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser } from "playwright-core";

import { resolveDesignChromiumPath } from "../design/index.js";
import { LoopbackArtifactContentServer } from "./content-server.js";
import { syntheticWav } from "./fixtures/synthetic-wav.js";

const CHROMIUM = resolveDesignChromiumPath();
if (!CHROMIUM) console.warn("[media-stream.browser.test] skipped: no Chromium executable");
const browserTest = CHROMIUM ? test : test.skip;
const COOKIE_CANARY = `canary-cookie-${Math.random().toString(36).slice(2)}`;
const RANGE_CAP = 4096;

function appServer(mediaUrl: () => string): Promise<{ server: Server; origin: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": `ork_session=${COOKIE_CANARY}; Path=/; SameSite=Lax`,
    });
    response.end(`<!doctype html><html><body>
      <video id="player" controls preload="metadata" muted src="${mediaUrl()}"></video>
      <script>
        window.events = [];
        const player = document.getElementById("player");
        for (const name of ["loadedmetadata", "seeked", "playing", "error"]) {
          player.addEventListener(name, () => window.events.push(name));
        }
      </script></body></html>`);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

describe("streamed media in Chromium", () => {
  let browser: Browser | undefined;
  let content: LoopbackArtifactContentServer | undefined;
  let app: Server | undefined;
  let directory: string | undefined;

  beforeAll(async () => {
    if (CHROMIUM) {
      browser = await chromium.launch({
        executablePath: CHROMIUM,
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
    }
  });
  afterAll(async () => {
    await browser?.close();
    await content?.close();
    app?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  browserTest(
    "an application page plays and seeks a ranged media capability on the content origin",
    async () => {
      directory = mkdtempSync(path.join(os.tmpdir(), "media-browser-"));
      const file = path.join(directory, "tone.wav");
      const wav = syntheticWav(2);
      writeFileSync(file, wav);
      const stats = statSync(file);
      const identity = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
      content = await LoopbackArtifactContentServer.start({
        frameAncestors: [],
        mediaRangeResponseMaxBytes: RANGE_CAP,
      });
      let authorizations = 0;
      const capability = content.mintMedia({
        ownerKey: "env-browser",
        mimeType: "audio/wav",
        byteLength: wav.byteLength,
        identity,
        resolve: async () => {
          const handle = await open(file, "r");
          const opened = await handle.stat();
          return {
            handle,
            size: opened.size,
            identity: `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}`,
          };
        },
        authorize: async () => {
          authorizations++;
          return true;
        },
      });
      const started = await appServer(() => capability.url);
      app = started.server;
      // The application origin and the content origin are different sites.
      expect(new URL(started.origin).hostname).toBe("127.0.0.1");
      expect(new URL(content.origin()!).hostname).toBe("localhost");

      const context = await browser!.newContext();
      const mediaRequests: Array<{ range: string; cookie: string }> = [];
      const statuses: number[] = [];
      context.on("request", (request) => {
        if (new URL(request.url()).origin !== content!.origin()) return;
        void request
          .allHeaders()
          .then((headers) =>
            mediaRequests.push({ range: headers.range ?? "", cookie: headers.cookie ?? "" }),
          )
          .catch(() => undefined);
      });
      context.on("response", (response) => {
        if (new URL(response.url()).origin === content!.origin()) statuses.push(response.status());
      });
      const page = await context.newPage();
      await page.goto(started.origin);
      await page.waitForFunction(
        () => (document.getElementById("player") as HTMLVideoElement).readyState >= 1,
        undefined,
        { timeout: 15_000 },
      );
      const duration = await page.evaluate(
        () => (document.getElementById("player") as HTMLVideoElement).duration,
      );
      expect(duration).toBeGreaterThan(1.9);
      expect(duration).toBeLessThan(2.1);

      // Seek near the end: the bytes come from a later range.
      await page.evaluate(() => {
        (document.getElementById("player") as HTMLVideoElement).currentTime = 1.6;
      });
      await page.waitForFunction(
        () => (window as unknown as { events: string[] }).events.includes("seeked"),
        undefined,
        { timeout: 15_000 },
      );
      await page.evaluate(() => (document.getElementById("player") as HTMLVideoElement).play());
      await page.waitForFunction(
        () => (document.getElementById("player") as HTMLVideoElement).currentTime > 1.7,
        undefined,
        { timeout: 15_000 },
      );
      const events = await page.evaluate(() => (window as unknown as { events: string[] }).events);
      expect(events).not.toContain("error");

      // Every request was a single range answered 206, spread over several requests.
      expect(mediaRequests.length).toBeGreaterThanOrEqual(2);
      expect(mediaRequests.every((entry) => /^bytes=\d+-\d*$/.test(entry.range))).toBe(true);
      expect(new Set(mediaRequests.map((entry) => entry.range)).size).toBeGreaterThanOrEqual(2);
      expect(statuses.length).toBeGreaterThanOrEqual(2);
      expect(statuses.every((status) => status === 206)).toBe(true);
      expect(authorizations).toBe(statuses.length);
      // The application's cookie never reached the content origin.
      expect((await context.cookies(started.origin)).map((cookie) => cookie.value)).toContain(
        COOKIE_CANARY,
      );
      expect(mediaRequests.map((entry) => entry.cookie).join(" ")).not.toContain(COOKIE_CANARY);

      // Revoking the capability stops further loads: a fresh page's element
      // errors (the same page may still play from Chromium's media cache).
      content.revokeMedia(capability.generation);
      await context.close();
      const fresh = await browser!.newContext();
      const freshPage = await fresh.newPage();
      await freshPage.goto(started.origin);
      const failed = await freshPage.evaluate(
        (url) =>
          new Promise<boolean>((resolve) => {
            const element = document.createElement("audio");
            element.preload = "metadata";
            element.addEventListener("loadedmetadata", () => resolve(false));
            element.addEventListener("error", () => resolve(true));
            element.src = url;
          }),
        capability.url,
      );
      expect(failed).toBe(true);
      await fresh.close();
    },
    60_000,
  );
});
