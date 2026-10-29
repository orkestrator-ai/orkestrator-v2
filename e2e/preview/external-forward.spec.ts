import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

let harness: ChildProcess;
let urls: Array<{ preferred: number; url: string }>;
let exited: Promise<void>;

test.beforeAll(async () => {
  harness = spawn("bun", ["apps/desktop/tests/preview-external-browser-harness.ts"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, NODE_ENV: "test" },
  });
  exited = new Promise((resolve) => harness.once("exit", () => resolve()));
  urls = await new Promise((resolve, reject) => {
    harness.once("error", reject);
    harness.once("exit", (code) => reject(new Error(`Forward harness exited: ${code}`)));
    createInterface({ input: harness.stdout! }).once("line", (line) => {
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
  });
});

test.afterAll(async () => {
  harness?.stdin?.end();
  await exited;
});

test("restricted application ports produce URLs a real browser can navigate", async ({ page }) => {
  for (const { preferred, url } of urls) {
    expect(Number(new URL(url).port)).not.toBe(preferred);
    const response = await page.goto(url);
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toHaveAttribute("data-port", String(preferred));
    await expect(page.locator("body")).toHaveText("browser-safe forward");
  }
});
