import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * What the gateway's cookie fixes rely on browsers to do, which its backend
 * tests can only assume (security report H1, §8):
 *
 * - H1: cookie scope across ports.
 * - H1: `SameSite=Strict` on a typed navigation and on a cross-site one.
 *
 * The M1 and M2 checks covered the legacy gateway preview route, which was
 * removed with it.
 *
 * Playwright's WebKit is engine coverage, not shipping Safari.
 *
 * Run: `bunx playwright test --config e2e/preview/playwright.preview.config.ts gateway-browser-security`
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const COOKIE_NAME = "orkestrator_gateway_auth";

interface Ready {
  gatewayPort: number;
  token: string;
  otherPort: number;
}

let harness: ChildProcessByStdio<Writable, Readable, null>;
let ready: Ready;
let gateway: string;
const waiting: Array<{ type: string; resolve: (message: unknown) => void }> = [];

function next<T>(type: string, command?: string): Promise<T> {
  return new Promise((resolve) => {
    waiting.push({ type, resolve: resolve as (message: unknown) => void });
    if (command) harness.stdin.write(`${command}\n`);
  });
}

const invokes = async () => (await next<{ invokes: string[] }>("invokes", "invokes")).invokes;

test.beforeAll(async () => {
  harness = spawn("bun", ["apps/backend/src/gateway-browser-harness.ts"], {
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
  gateway = `http://127.0.0.1:${ready.gatewayPort}`;
});

test.afterAll(() => {
  harness?.stdin.end();
});

/** Signs in through the real login form, as a person would. */
async function signIn(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${gateway}/__orkestrator/login`);
  await page.locator('input[name="token"]').fill(ready.token);
  await Promise.all([page.waitForURL(`${gateway}/`), page.locator("button").click()]);
  await expect(page.locator("#root")).toHaveText("signed-in-app");
  return page;
}

test("H1: the cookie holds a session, and reaches another port on the host", async ({
  context,
}) => {
  const page = await signIn(context);
  const [cookie] = (await context.cookies(gateway)).filter((c) => c.name === COOKIE_NAME);
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
  expect(cookie!.value).not.toBe(ready.token);
  expect(await page.evaluate(() => document.cookie)).not.toContain(COOKIE_NAME);

  // The exposure `remote-gateway.md` accepts: cookies ignore ports, so another
  // service here receives the session. It never receives the durable token.
  await page.goto(`http://127.0.0.1:${ready.otherPort}/`);
  const received = await page.locator("body").innerText();
  expect(received).toContain(`${COOKIE_NAME}=${cookie!.value}`);
  expect(received).not.toContain(ready.token);
});

test("H1: a typed navigation stays signed in", async ({ context }) => {
  const page = await signIn(context);
  const typed = await context.newPage();
  const response = await typed.goto(`${gateway}/`);
  // A browser may revalidate its copy; the gateway authenticates before either.
  expect([200, 304]).toContain(response?.status());
  await expect(typed.locator("#root")).toHaveText("signed-in-app");
  await page.close();
});

test("H1: a link from another site arrives without the cookie", async ({ context }) => {
  await signIn(context);
  const page = await context.newPage();
  // `localhost` and `127.0.0.1` are different sites, whatever their ports.
  const target = encodeURIComponent(`${gateway}/`);
  await page.goto(`http://localhost:${ready.otherPort}/link?to=${target}`);
  const [response] = await Promise.all([page.waitForNavigation(), page.locator("#go").click()]);
  expect(response?.status()).toBe(401);
  await expect(page.locator('input[name="token"]')).toBeVisible();
});

test("H1: a form posted from another site cannot invoke a command", async ({ context }) => {
  await signIn(context);
  const before = await invokes();
  const page = await context.newPage();
  const target = encodeURIComponent(`${gateway}/__orkestrator/invoke`);
  await page.goto(`http://localhost:${ready.otherPort}/link?to=${target}`);
  const [response] = await Promise.all([
    page.waitForNavigation(),
    page.evaluate(() => (document.querySelector("#post") as HTMLFormElement).submit()),
  ]);
  // The origin is refused before credentials are looked at.
  expect(response?.status()).toBe(403);
  expect(await invokes()).toEqual(before);
});
