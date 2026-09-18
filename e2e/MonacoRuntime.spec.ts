import { expect, test } from "@playwright/test";

test("real Monaco defaults and every Vite worker route initialize in Chromium", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop coverage is sufficient");
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    const urls: string[] = [];
    const RecordingWorker = new Proxy(NativeWorker, {
      construct(target, args: ConstructorParameters<typeof Worker>) {
        urls.push(String(args[0]));
        return Reflect.construct(target, args);
      },
    });
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: RecordingWorker });
    Object.defineProperty(globalThis, "__monacoWorkerUrls", {
      configurable: true,
      value: urls,
    });
  });

  await page.goto("/monaco-runtime");
  const editor = page.getByTestId("monaco-runtime-editor");
  await expect(editor.locator(".monaco-editor")).toBeVisible();
  await expect(editor.getByText("Failed to load editor")).toHaveCount(0);

  const routes = await page.evaluate(async () => {
    const runtime = globalThis as typeof globalThis & {
      MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
      __monacoWorkerUrls?: string[];
    };
    if (!runtime.MonacoEnvironment) throw new Error("MonacoEnvironment was not installed");
    const labels = [
      "css",
      "less",
      "scss",
      "html",
      "handlebars",
      "razor",
      "javascript",
      "typescript",
      "json",
      "plaintext",
    ];
    const start = runtime.__monacoWorkerUrls?.length ?? 0;
    for (const label of labels) {
      const worker = await runtime.MonacoEnvironment.getWorker("browser-test", label);
      worker.terminate();
    }
    return {
      labels,
      urls: runtime.__monacoWorkerUrls?.slice(start) ?? [],
    };
  });

  expect(routes.urls).toHaveLength(routes.labels.length);
  const byLabel = Object.fromEntries(
    routes.labels.map((label, index) => [label, routes.urls[index]]),
  );
  expect(byLabel.less).toBe(byLabel.css);
  expect(byLabel.scss).toBe(byLabel.css);
  expect(byLabel.handlebars).toBe(byLabel.html);
  expect(byLabel.razor).toBe(byLabel.html);
  expect(byLabel.javascript).toBe(byLabel.typescript);
  expect(new Set(routes.urls).size).toBe(5);
});
