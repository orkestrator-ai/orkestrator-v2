import { expect, test } from "@playwright/test";
import { BrowserPreviewTraceSessions } from "../apps/desktop/electron/browser-preview-trace";

test("trusted browser events stay within a recording and omit editable text", async ({ page }) => {
  await page.route("http://trace.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div role="group" aria-label="Editor group"><div contenteditable="true" aria-label="Editor"></div></div><button>First</button><button>Between</button><button>Second</button>',
    }),
  );
  await page.goto("http://trace.test/");
  const traces = new BrowserPreviewTraceSessions({
    preview: () => ({
      generation: 1,
      contents: {
        getURL: () => page.url(),
        executeJavaScript: (script) => page.evaluate(script),
        isDestroyed: () => page.isClosed(),
      },
    }),
  });
  try {
    await traces.start("preview", "Fixture");
    const editor = page.locator("[contenteditable]");
    await editor.fill("private editable text");
    await editor.press("Enter");
    await page.getByRole("button", { name: "First" }).click();
    const first = await traces.stop("preview");
    expect(first.steps.map((step) => step.action)).toContain("keypress");
    expect(JSON.stringify(first)).not.toContain("private editable text");
    expect(first.steps.some((step) => step.target?.text === "First")).toBe(true);
    await page.getByRole("button", { name: "Between" }).click();
    expect(await page.evaluate('"__orkestratorTrace" in window')).toBe(false);
    await traces.start("preview", "Fixture");
    await page.getByRole("button", { name: "Second" }).click();
    const second = await traces.stop("preview");
    expect(second.steps.map((step) => step.target?.text)).toEqual(["Second"]);
  } finally {
    traces.dispose();
  }
});
