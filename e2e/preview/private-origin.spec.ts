import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Real Chromium against the real private-origin listener: top-level bootstrap,
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
const waiting: Array<{ type: string; resolve: (message: unknown) => void }> = [];

/** Wait for the harness's next `type` message, optionally sending a command first. */
function next<T>(type: string, command?: string): Promise<T> {
  return new Promise((resolve) => {
    waiting.push({ type, resolve: resolve as (message: unknown) => void });
    if (command) harness.stdin.write(`${command}\n`);
  });
}

test.beforeAll(async () => {
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
  browser = await chromium.launch({
    args: [
      `--host-resolver-rules=MAP *.${ready.domain} 127.0.0.1`,
      // Trust exactly the throwaway test leaf; certificate verification stays on.
      `--ignore-certificate-errors-spki-list=${ready.spki}`,
    ],
  });
});

test.afterAll(async () => {
  await browser?.close();
  harness?.stdin.end();
});

async function signIn(page: Page, service: string): Promise<Grant> {
  const grant = await next<Grant>("grant", `grant ${service}`);
  // The same form POST the web client submits (`submitPreviewBootstrap`).
  await page.setContent(
    `<!doctype html><meta name="referrer" content="no-referrer">
     <form method="POST" action="${grant.action}" referrerpolicy="no-referrer">
       <input type="hidden" name="attachment" value="${grant.attachmentId}">
       <input type="hidden" name="grant" value="${grant.grant}">
     </form>`,
  );
  await Promise.all([
    page.waitForURL(`${grant.origin}/`),
    page.evaluate(() => document.querySelector("form")!.submit()),
  ]);
  return grant;
}

test("bootstrap signs in top-level and the app runs unchanged at its own origin", async () => {
  const context = await browser.newContext();
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
  const context = await browser.newContext();
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
  const context = await browser.newContext();
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
  const context = await browser.newContext();
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

test("revocation ends the browser session", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, "app");
  await next("revoked", "revoke");
  const response = await page.reload();
  expect(response?.status()).toBeGreaterThanOrEqual(400);
  await expect(page.locator("body")).not.toHaveAttribute("data-loaded", "browser-app");
  await context.close();
});

test("Vite HMR updates the page in the browser without a reload", async () => {
  test.skip(!ready.services.includes("vite"), "Set ORKESTRATOR_TEST_PREVIEW_VITE_DIR");
  const labelFile = path.join(process.env.ORKESTRATOR_TEST_PREVIEW_VITE_DIR!, "src/label.js");
  const original = await readFile(labelFile, "utf8");
  const context = await browser.newContext();
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
