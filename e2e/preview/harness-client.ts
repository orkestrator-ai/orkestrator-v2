import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { startLoopbackProxy } from "./loopback-proxy";

/**
 * Starts the isolated backend preview stack (`preview-browser-harness.ts`) and
 * a browser routed to it, for preview specs that do not need the hostile-site
 * fixtures of `private-origin.spec.ts`.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export interface HarnessReady {
  port: number;
  domain: string;
  spki: string;
  services: string[];
  gateway: string;
  /** Ports the legacy `/__orkestrator/browser/loopback/<port>/` route can reach. */
  loopbackPorts: Record<string, number>;
  redirectPort: number;
}

export interface HarnessGrant {
  action: string;
  attachmentId: string;
  grant: string;
  origin: string;
}

export interface PreviewHarnessClient {
  ready: HarnessReady;
  browser: Browser;
  engine: string;
  /** Wait for the harness's next `type` message, optionally sending a command first. */
  next<T>(type: string, command?: string): Promise<T>;
  newContext(options?: BrowserContextOptions): ReturnType<Browser["newContext"]>;
  /** Sign a page in to a service through the real bootstrap form POST. */
  signIn(page: Page, service: string, appPath?: string): Promise<HarnessGrant>;
  close(): Promise<void>;
}

export async function startPreviewHarnessClient(
  browserName: string,
  env: Record<string, string> = {},
): Promise<PreviewHarnessClient> {
  const harness: ChildProcessByStdio<Writable, Readable, null> = spawn(
    "bun",
    ["apps/backend/src/preview-browser-harness.ts"],
    {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...env, NODE_ENV: "test" },
    },
  );
  const waiting: Array<{ type: string; resolve: (message: unknown) => void }> = [];
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
  const next = <T>(type: string, command?: string): Promise<T> =>
    new Promise((resolve) => {
      waiting.push({ type, resolve: resolve as (message: unknown) => void });
      if (command) harness.stdin.write(`${command}\n`);
    });

  const ready = await next<HarnessReady>("ready");
  const proxy = await startLoopbackProxy(ready);
  const browser = await { chromium, firefox, webkit }[
    browserName as "chromium" | "firefox" | "webkit"
  ].launch({
    proxy: { server: proxy.server, bypass: "127.0.0.1" },
    // Trust exactly the throwaway test leaf; certificate verification stays on.
    args: browserName === "chromium" ? [`--ignore-certificate-errors-spki-list=${ready.spki}`] : [],
  });

  return {
    ready,
    browser,
    engine: browserName,
    next,
    // Firefox/WebKit bypass validation only in this throwaway context.
    newContext: (options = {}) =>
      browser.newContext({ ...options, ignoreHTTPSErrors: browserName !== "chromium" }),
    async signIn(page, service, appPath = "/") {
      const grant = await next<HarnessGrant>("grant", `grant ${service} ${appPath}`);
      // The same form POST the web client submits (`submitPreviewBootstrap`).
      await page.setContent(
        `<!doctype html><meta name="referrer" content="no-referrer">
         <form method="POST" action="${grant.action}" referrerpolicy="no-referrer">
           <input type="hidden" name="attachment" value="${grant.attachmentId}">
           <input type="hidden" name="grant" value="${grant.grant}">
         </form>`,
      );
      await Promise.all([
        page.waitForURL((url) => url.href === `${grant.origin}${appPath}`),
        page.evaluate(() => document.querySelector("form")!.submit()),
      ]);
      return grant;
    },
    async close() {
      await browser.close();
      await proxy.close();
      // Wait for the harness to stop its applications, so the next project's
      // harness does not start a dev server over one that is still exiting.
      const exited =
        harness.exitCode !== null || harness.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => harness.once("exit", () => resolve()));
      harness.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 30_000);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
