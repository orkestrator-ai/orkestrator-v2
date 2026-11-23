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

test("dotenv highlights comments and recovers unfinished quotes in real Monaco", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "tokenization is viewport independent");
  await page.goto("/monaco-runtime");
  await expect(page.getByTestId("monaco-runtime-editor").locator(".monaco-editor")).toBeVisible();
  const source = [
    "INLINE=bar#comment",
    "EMPTY=#comment",
    String.raw`SINGLE='a\'#inside' #outside`,
    'BROKEN="unfinished',
    "NEXT=value",
    "EMPTY_VALUE=",
    "LAST=$HOME/${USER}",
  ].join("\n");
  const tokens = await page.evaluate(
    async ({ source }) => {
      // The editor's own instance: its model is the one the page created.
      const monaco = await window.__fixtureModules!["monaco-editor"]();
      const { registerDotenvLanguage } = await window.__fixtureModules!["lib/monaco-dotenv"]();
      registerDotenvLanguage(monaco);
      const model = monaco.editor.getModels()[0];
      monaco.editor.setModelLanguage(model, "dotenv");
      model.setValue(source);
      return monaco.editor
        .tokenize(source, "dotenv")
        .map((line: { offset: number; type: string }[]) =>
          line.map((token) => ({ offset: token.offset, type: token.type })),
        );
    },
    { source },
  );
  expect(tokens[0]).toContainEqual({ offset: 10, type: "comment.dotenv" });
  expect(tokens[1]).toContainEqual({ offset: 6, type: "comment.dotenv" });
  expect(tokens[2]).toContainEqual({ offset: 9, type: "string.escape.dotenv" });
  expect(tokens[4]?.[0]).toEqual({ offset: 0, type: "key.dotenv" });
  await page.screenshot({ path: "output/visual-previews/dotenv-after-desktop.png" });
});
