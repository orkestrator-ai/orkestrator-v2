import { chromium } from "@playwright/test";
import {
  collectStartupConsole,
  NETWORK_CHANGED,
  pageStartupWindow,
  STARTUP_FAILED_TEXT,
  waitForRendererStart,
} from "./electron-startup-recovery";
import {
  churnLoadUntilAborted,
  enterPrivateNetwork,
  serveModuleFanOut,
} from "./electron-startup-recovery-live-support";

// Run only by electron-startup-recovery.integration.test.ts, inside
// `unshare --user --map-root-user --net`.
enterPrivateNetwork(process.argv[2]);

const title = "Startup recovered";
const server = await serveModuleFanOut(title);
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
    await server.started;
    // Change only this child's interfaces while Chromium has modules in flight.
    // A burst that aborted nothing starts the load over, before any recovery.
    const churn = await churnLoadUntilAborted(
      () => networkChanged,
      async () => {
        const nextLoad = server.nextModuleRequest();
        // The held responses fill every connection Chromium allows to the
        // server, so a reload could not even send its request. Leaving for
        // about:blank cancels them and frees those connections first.
        await page.goto("about:blank");
        await page.goto(server.url.href, { waitUntil: "commit" });
        await nextLoad;
      },
    );
    if (!networkChanged) {
      throw new Error(
        `No actual ERR_NETWORK_CHANGED module failure observed (${JSON.stringify({
          ...churn,
          moduleRequests: server.moduleRequests(),
        })})`,
      );
    }
    await page.getByText(STARTUP_FAILED_TEXT).waitFor({ timeout: 5_000 });
    server.release();
    const reloads = await waitForRendererStart(pageStartupWindow(page, console), title, {
      timeoutMs: 15_000,
      pollMs: 25,
    });

    process.stdout.write(
      JSON.stringify({
        networkChanged,
        reloads,
        moduleRequests: server.moduleRequests(),
        bursts: churn.bursts,
        interfaceChanges: churn.interfaceChanges,
      }),
    );
  } finally {
    console.dispose();
    await context.close();
  }
} finally {
  await browser.close();
  await server.stop();
}
