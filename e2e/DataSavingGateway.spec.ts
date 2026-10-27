import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { watchEventStream } from "./agent-testing/event-stream-outage";

// Session cookies and one-shot bootstrap links must never enter traces.
test.use({ trace: "off" });

async function visibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** Real setting, persisted uiStore, shared coordinator, HTTP reads and SSE invalidations. */
test("data saving survives reload, stays client-local and preserves event latency through resume and reconnect", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000);
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "fixture/data-saving-gateway-server.ts"), baseURL!],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise<void>((resolve, reject) =>
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Disposable gateway failed")),
    ),
  );
  void exited.catch(() => undefined);
  const contextOptions = {
    viewport: testInfo.project.use.viewport,
    hasTouch: testInfo.project.use.hasTouch,
  };
  const contexts = [
    await browser.newContext(contextOptions),
    await browser.newContext(contextOptions),
  ];
  try {
    const manifest = await new Promise<{ url: string; logins: string[] }>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(
        () => reject(new Error("Disposable gateway startup timed out")),
        10_000,
      );
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Gateway exited during startup"));
      });
      child.stdout.on("data", (chunk) => {
        text += String(chunk);
        if (!text.includes("\n")) return;
        clearTimeout(timer);
        resolve(JSON.parse(text.split("\n")[0]!));
      });
    });
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const reads = [0, 0];
    const bytes = [0, 0];
    for (const [index, page] of pages.entries()) {
      page.on("response", async (response) => {
        if (!response.url().endsWith("/__orkestrator/invoke")) return;
        if (response.request().postDataJSON()?.command !== "baseline_read") return;
        const sizes = await response
          .request()
          .sizes()
          .catch(() => null);
        reads[index]! += 1;
        bytes[index]! += sizes?.responseBodySize ?? 0;
      });
      await page.goto(manifest.logins[index]!);
      await page.goto(`${manifest.url}/data-saving-gateway`);
      await expect(page.getByTestId("gateway-state")).toContainText('"revision":0');
    }
    const [saving, normal] = pages as [Page, Page];
    await saving.getByRole("switch", { name: "Data saving", exact: true }).click();
    await expect(saving.getByRole("switch")).toBeChecked();
    await saving.reload();
    await expect(saving.getByRole("switch")).toBeChecked();
    await expect(normal.getByRole("switch")).not.toBeChecked();
    await expect(saving.getByTestId("gateway-state")).toContainText('"revision":0');
    const beforeReads = [...reads];
    const beforeBytes = [...bytes];
    await saving.waitForTimeout(4_200);
    const deltaReads = reads.map((count, i) => count - beforeReads[i]!);
    const deltaBytes = bytes.map((count, i) => count - beforeBytes[i]!);
    expect(deltaReads[0]).toBeGreaterThanOrEqual(3);
    expect(deltaReads[1]!).toBeGreaterThan(deltaReads[0]!);
    expect(deltaBytes[0]).toBeGreaterThan(0);
    expect(deltaBytes[1]!).toBeGreaterThan(deltaBytes[0]!);

    const publish = async (state: string) => {
      const response = await normal.request.post(`${manifest.url}/__orkestrator/invoke`, {
        data: { command: "baseline_publish", args: { state } },
      });
      return (await response.json()).result as { revision: number; emittedAt: number };
    };
    const latencies: Record<string, number[]> = {};
    for (const [state, budget] of [
      ["approval", 2_000],
      ["complete", 3_000],
    ] as const) {
      const emitted = await publish(state);
      latencies[state] = [];
      for (const page of [saving, normal]) {
        await expect(page.getByTestId("gateway-state")).toContainText(
          `"revision":${emitted.revision}`,
          { timeout: budget },
        );
        const elapsed = Date.now() - emitted.emittedAt;
        latencies[state]!.push(elapsed);
        expect(elapsed).toBeLessThan(budget);
      }
    }
    await visibility(saving, "hidden");
    await saving.waitForTimeout(200);
    const hiddenReads = reads[0];
    const emitted = await publish("complete-in-background");
    await saving.waitForTimeout(1_500);
    expect(reads[0]).toBe(hiddenReads);
    await visibility(saving, "visible");
    await expect(saving.getByTestId("gateway-state")).toContainText(
      `"revision":${emitted.revision}`,
      { timeout: 2_000 },
    );

    const stream = watchEventStream(saving);
    // Observe a stream before cutting it.
    await saving.reload();
    await expect(saving.getByRole("switch")).toBeChecked();
    await expect.poll(() => stream.connects).toBeGreaterThan(0);
    await stream.cut(contexts[0]!);
    const missed = await publish("complete-while-disconnected");
    await contexts[0]!.setOffline(false);
    await stream.expectReconnected(10_000);
    await expect(saving.getByTestId("gateway-state")).toContainText(
      `"revision":${missed.revision}`,
      { timeout: 3_000 },
    );
    await saving.reload();
    await expect(saving.getByRole("switch")).toBeChecked();
    await expect(saving.getByTestId("gateway-state")).toContainText(
      `"revision":${missed.revision}`,
    );
    await expect(normal.getByRole("switch")).not.toBeChecked();
    const measurementsPath = testInfo.outputPath("data-saving-measurements.json");
    await writeFile(
      measurementsPath,
      JSON.stringify(
        {
          observationMs: 4_200,
          clients: ["data-saving", "normal"],
          reads: deltaReads,
          responseBodyBytes: deltaBytes,
          latencyMs: latencies,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("data-saving-measurements", {
      path: measurementsPath,
      contentType: "application/json",
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    child.stdin.end();
    await exited;
  }
});
