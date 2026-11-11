import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import {
  dismissDialogs,
  loadScript,
  measureStatus,
  parseOptions,
  STOP_FILE,
  stopLoadScript,
  watchWindow,
} from "../../e2e/perf/multi-environment-ui-perf";

describe("probe options", () => {
  const parse = (...args: string[]) => parseOptions(["--profile", "test", ...args]);
  test("retains repeated phases and accepts boundary values", () => {
    expect(parse("--phases", "busy,busy,idle").phases).toEqual(["busy", "busy", "idle"]);
    for (const flag of ["--workers", "--memory-mib", "--status-cycles", "--settle-seconds"]) {
      expect(() => parse(flag, "0")).not.toThrow();
      expect(() => parse(flag, "-1")).toThrow("at least 0");
    }
    for (const flag of ["--environments", "--switches", "--watch-seconds"]) {
      expect(() => parse(flag, "1")).not.toThrow();
      expect(() => parse(flag, "0")).toThrow("at least 1");
    }
  });
  test("rejects unknown, missing, fractional and invalid phase values", () => {
    expect(() => parse("--wat")).toThrow("Unknown option");
    expect(() => parse("--workers")).toThrow("needs a value");
    for (const value of ["1.5", "NaN", "Infinity"])
      expect(() => parse("--workers", value)).toThrow();
    expect(() => parse("--phases", "")).toThrow("at least one phase");
    expect(() => parse("--phases", "idle,wat")).toThrow("expects idle,busy");
  });
});

test("generated workload waits for CPU, memory and churn workers before a consecutive phase", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ui-load-test-"));
  const token = path.join(root, "stop");
  const rewrite = (script: string) => script.replaceAll(STOP_FILE, token);
  try {
    for (let phase = 0; phase < 2; phase++) {
      rmSync(token, { force: true });
      rmSync(token + ".done", { force: true });
      const child = spawn("sh", ["-c", rewrite(loadScript(1, 1))], { cwd: root, stdio: "ignore" });
      const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
      try {
        const deadline = Date.now() + 3000;
        while (!existsSync(path.join(root, "ui-load-churn.txt"))) {
          if (Date.now() > deadline) throw new Error("churn did not start");
          await Bun.sleep(10);
        }
        expect(spawnSync("sh", ["-c", rewrite(stopLoadScript())], { timeout: 15000 }).status).toBe(
          0,
        );
        expect(await exit).toBe(0);
        expect(existsSync(path.join(root, "ui-load-churn.txt"))).toBe(false);
        expect(existsSync(token + ".done")).toBe(true);
      } finally {
        // Ensure even a failed assertion tells every generated worker to stop.
        await Bun.write(token, "");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

// CI's test job installs no Playwright browsers (the runner image has Google
// Chrome), so launch whichever Chromium is present, as
// private-tmpdir-playwright.integration.test.ts does.
const CHROMIUM = [
  chromium.executablePath(),
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((candidate) => existsSync(candidate));

describe.skipIf(!CHROMIUM)("in-page deadlines", () => {
  let browser: Browser;
  // On a loaded CI runner Chromium's first page can take longer than Bun's
  // five-second test timeout, which then tears the browser down for every
  // later case. Pay that start-up cost here, under a hook budget.
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: CHROMIUM });
    await (await browser.newPage()).close();
  }, 60_000);
  // Bun gives a hook without an explicit budget the five-second default, and
  // closing Chromium (every page, the browser process and its profile) can take
  // longer than that on a loaded host; the timeout is then reported as the
  // unnamed hook of this describe block (cases 2711 and 2882).
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  test("dismisses dialogs that open over the workspace and reports their titles", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <button id="row">row</button>
        <div role="alertdialog" aria-labelledby="t1" id="first">
          <h2 id="t1">Claude Code Is Not Logged In</h2>
          <button onclick="document.getElementById('first').remove()">Continue Without Claude</button>
        </div>
        <div role="dialog" id="second"><h2>Notice</h2></div>
        <script>
          document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") document.getElementById("second")?.remove();
          });
        </script>`);
      const dismissed: string[] = [];
      expect(await dismissDialogs(page, dismissed)).toBe(2);
      expect(dismissed).toEqual(["Claude Code Is Not Logged In", "Notice"]);
      expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0);
      // Nothing open: no work, nothing reported.
      expect(await dismissDialogs(page, dismissed)).toBe(0);
      expect(dismissed).toHaveLength(2);
      // A dialog that will not close is reported a bounded number of times.
      await page.setContent(`<div role="alertdialog"><h2>Stuck</h2></div>`);
      const stuck: string[] = [];
      expect(await dismissDialogs(page, stuck, 50)).toBe(5);
      expect(new Set(stuck)).toEqual(new Set(["Stuck"]));
    } finally {
      await page.close();
    }
  }, 60_000);
  for (const stalled of ["headers", "body", "failure"] as const) {
    test(`cleans up watch and status observers for stalled ${stalled}`, async () => {
      const page = await browser.newPage();
      try {
        await page.evaluate((stalled) => {
          const probe = {
            longTasks: [],
            slowEvents: [],
            aborted: 0,
            pendingFrames: new Set<number>(),
          };
          const request = window.requestAnimationFrame.bind(window);
          const cancel = window.cancelAnimationFrame.bind(window);
          window.requestAnimationFrame = (callback) => {
            const id = request((time) => {
              probe.pendingFrames.delete(id);
              callback(time);
            });
            probe.pendingFrames.add(id);
            return id;
          };
          window.cancelAnimationFrame = (id) => {
            probe.pendingFrames.delete(id);
            cancel(id);
          };
          Object.assign(window, { __uiLoadProbe: probe });
          window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            const signal = init!.signal!;
            const pending = () =>
              new Promise<never>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    probe.aborted++;
                    reject(new Error("aborted"));
                  },
                  { once: true },
                );
              });
            if (stalled === "failure") throw new Error("network failed");
            if (stalled === "headers") return pending();
            return { ok: true, text: pending } as unknown as Response;
          }) as typeof window.fetch;
        }, stalled);
        const start = Date.now();
        const watch = await watchWindow(page, 80, "project");
        expect(watch.invokeMs).toContain(null);
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { __uiLoadProbe: { pendingFrames: Set<number> } }).__uiLoadProbe
                .pendingFrames.size,
          ),
        ).toBe(0);
        const result = await measureStatus(
          page,
          { id: "env", name: "env" },
          "stop_environment",
          80,
        );
        expect(result.ok).toBe(false);
        expect(result.visibleMs).toBeNull();
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { __uiLoadProbe: { pendingFrames: Set<number> } }).__uiLoadProbe
                .pendingFrames.size,
          ),
        ).toBe(0);
        expect(Date.now() - start).toBeLessThan(3000);
        if (stalled !== "failure") {
          expect(
            await page.evaluate(
              () =>
                (window as unknown as { __uiLoadProbe: { aborted: number } }).__uiLoadProbe.aborted,
            ),
          ).toBe(2);
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
