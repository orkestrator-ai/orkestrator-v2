import { expect, test } from "@playwright/test";
import path from "node:path";

const moduleUrl = `/@fs${path.resolve(import.meta.dirname, "../apps/web/src/components/html/html-preview-document.ts")}`;

test("HTML boundary refuses resources, scripts, forms and mutated navigation", async ({ page }) => {
  await page.goto("/html-preview");
  await expect(page.locator("iframe")).toBeAttached();
  const requests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.includes("evil.invalid") || url.includes("relative-beacon")) {
      requests.push(url);
      await route.abort();
    } else await route.continue();
  });
  const popups: unknown[] = [];
  page.on("popup", (popup) => popups.push(popup));
  await page.evaluate(async (url) => {
    const { buildHtmlPreviewDocument } = await import(url);
    const frame = document.querySelector("iframe")!;
    frame.srcdoc = buildHtmlPreviewDocument(`
      <script>document.body.textContent='EXECUTED';fetch('https://evil.invalid/script')</script>
      <img src="https://evil.invalid/image"><img src="/relative-beacon">
      <iframe src="https://evil.invalid/frame"></iframe><object data="https://evil.invalid/object"></object><embed src="https://evil.invalid/embed">
      <p style="background:url(https://evil.invalid/background)">Resources</p>
      <style>@import 'https://evil.invalid/css';</style>
      <a id="external" href="https://evil.invalid/link">External</a>
      <a id="relative" href="/relative-beacon">Relative</a>
      <a id="script" href="javascript:document.body.textContent='EXECUTED'">Script</a>
      <a id="top" href="https://evil.invalid/top" target="_top">Top</a>
      <form action="https://evil.invalid/form"><button>Submit</button></form>
      <svg><a id="animated" href="#end"><animate attributeName="href" values="https://evil.invalid/animated" dur="0.01s" fill="freeze"/><text x="0" y="20">Animated</text></a></svg>
      <form><math><mtext></form><form><mglyph><style></math><a id="mutated" href="https://evil.invalid/mutated">Mutation</a>
      <a id="jump" href="#end">Jump</a><div style="height:1600px"></div><p id="end">End</p>
    `).srcDoc;
  }, moduleUrl);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#jump")).toBeVisible();
  await page.waitForTimeout(100);
  for (const id of ["external", "relative", "script", "top", "animated", "mutated"]) {
    const link = frame.locator(`#${id}`);
    if (await link.count()) await link.click();
    await expect(frame.locator("#jump")).toBeVisible();
  }
  await frame.getByRole("button", { name: "Submit" }).first().click();
  await frame.locator("#jump").click();
  await expect(frame.locator("#end")).toBeInViewport();
  await expect(frame.locator("body")).not.toHaveText("EXECUTED");
  expect(requests).toEqual([]);
  expect(popups).toEqual([]);
  expect(page.frames().some((f) => f.url().includes("evil.invalid"))).toBe(false);
});

test("preview releases keyboard focus, saves, and permits divider dragging", async ({
  page,
}, testInfo) => {
  await page.goto("/html-preview");
  await page.frameLocator("iframe").getByRole("heading", { name: "Report", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
  await page.keyboard.press("Control+s");
  await expect(page.getByLabel("Saves")).toHaveText("1");
  await page.keyboard.press("Control+k");
  await expect(page.getByLabel("Searches")).toHaveText("1");
  await page.frameLocator("iframe").getByRole("heading", { name: "Report", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
  await page.keyboard.press("Control+,");
  await expect(page.getByLabel("Settings")).toHaveText("1");
  await page.keyboard.press("Control+Shift+Slash");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  const handle = page.getByRole("separator");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 150, { steps: 8 });
  const middle = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 140, box.y + 150, { steps: 8 });
  const end = (await handle.boundingBox())!;
  expect(middle.x).toBeGreaterThan(box.x + 40);
  expect(end.x).toBeGreaterThan(middle.x + 30);
  await page.mouse.up();
  await expect(page.locator("iframe")).toHaveCSS("pointer-events", "auto");
  await page.screenshot({
    path: path.resolve(`output/visual-previews/html-preview-after-${testInfo.project.name}.png`),
  });
});
