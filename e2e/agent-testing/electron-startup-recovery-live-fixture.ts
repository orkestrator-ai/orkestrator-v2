import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  collectStartupConsole,
  NETWORK_CHANGED,
  pageStartupWindow,
  STARTUP_FAILED_TEXT,
  waitForRendererStart,
} from "./electron-startup-recovery";

// Refuse to change interfaces unless unshare gave us a private network namespace.
if (!process.argv[2] || readlinkSync("/proc/self/ns/net") === process.argv[2]) {
  throw new Error("Startup qualification requires a private network namespace");
}
const ip = (...args: string[]) => execFileSync("ip", args, { stdio: "pipe" });
ip("link", "set", "lo", "up");

let moduleRequests = 0;
let allowModules = false;
let moduleStarted!: () => void;
const started = new Promise<void>((resolve) => (moduleStarted = resolve));
const title = "Startup recovered";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/entry.js") {
      moduleRequests += 1;
      moduleStarted();
      if (!allowModules) await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("export const ready = true", {
        headers: { "Content-Type": "text/javascript" },
      });
    }
    return new Response(
      `<title>Starting</title><script type="module">
        Promise.all(Array.from({length: 1000}, (_, i) => import('/entry.js?i=' + i)))
        .then(() => { document.title = ${JSON.stringify(title)}; }).catch(error => {
          console.error(error.message);
          document.body.textContent = ${JSON.stringify(STARTUP_FAILED_TEXT)};
        });
      </script><body></body>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
});
const browser = await chromium.launch({ channel: "chromium" });
try {
  const context = await browser.newContext();
  const console = collectStartupConsole(context);
  try {
    const page = await context.newPage();
    let networkChanged = false;

    page.on("requestfailed", (request) => {
      if (request.url().includes("/entry.js")) {
        networkChanged ||= request.failure()?.errorText === NETWORK_CHANGED;
      }
    });
    await page.goto(server.url.href, { waitUntil: "commit" });
    await started;
    // Change only this child's interfaces while Chromium has a module in flight.
    for (let attempt = 0; attempt < 200 && !networkChanged; attempt += 1) {
      if (attempt % 2 === 0) {
        ip("link", "add", "churn-test", "type", "bridge");
        ip("addr", "add", "192.0.3.1/24", "dev", "churn-test");
        ip("link", "set", "churn-test", "up");
      } else {
        ip("link", "del", "churn-test");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!networkChanged) throw new Error("No actual ERR_NETWORK_CHANGED module failure observed");
    await page.getByText(STARTUP_FAILED_TEXT).waitFor({ timeout: 5_000 });
    allowModules = true;
    const reloads = await waitForRendererStart(pageStartupWindow(page, console), title, {
      timeoutMs: 15_000,
      pollMs: 25,
    });

    process.stdout.write(JSON.stringify({ networkChanged, reloads, moduleRequests }));
  } finally {
    console.dispose();
    await context.close();
  }
} finally {
  await browser.close();
  await server.stop(true);
}
