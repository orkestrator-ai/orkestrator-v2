import { expect, test, type Frame, type Page } from "@playwright/test";

const IFRAME = 'iframe[data-artifact-static-document="true"]';

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/static-html-artifact${query ? `?${query}` : ""}`);
}

async function rendered(page: Page, index = 0): Promise<Frame> {
  const iframe = page.locator(`${IFRAME}[data-state="rendered"]`).nth(index);
  // Includes loading the page, which a saturated host can take seconds over.
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  const frame = await (await iframe.elementHandle())!.contentFrame();
  if (!frame) throw new Error("No frame");
  return frame;
}

async function frameHeight(page: Page): Promise<number> {
  return page
    .locator(IFRAME)
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
}

test.describe("static HTML presentation", () => {
  test("publishes as real document content with no preview worker or live host", async ({
    page,
  }) => {
    await open(page);
    const frame = await rendered(page);
    await expect(frame.locator("h1")).toHaveText("Agent activity and cost");
    await expect(frame.locator(".session")).toHaveCount(4);
    await expect(frame.locator("svg.timeline")).toHaveCount(4);
    await expect(frame.locator("svg.models")).toBeVisible();
    await expect(frame.locator("table tbody tr")).toHaveCount(4);
    // The saved image is gone once the document is up, and the frame holds no image of itself.
    await expect(page.locator('[data-artifact-capture="true"]')).toHaveCount(0);
    expect(await frame.locator("img").count()).toBe(0);
    expect(await page.locator(IFRAME).getAttribute("sandbox")).toBe("allow-scripts");
    expect(await page.locator(IFRAME).getAttribute("title")).toBe(
      "Report: Agent activity and cost",
    );
  });

  test("fallback layout moves remount an open report with a fresh identity", async ({
    page,
  }, testInfo) => {
    await open(page);
    await rendered(page);
    const before = await page.locator(IFRAME).getAttribute("srcdoc");
    await page.screenshot({
      path: `output/visual-previews/static-before-${testInfo.project.name}.png`,
    });
    await page.evaluate(async (modulePath) => {
      // Force the Safari fallback even on Chromium.
      Object.defineProperty(Element.prototype, "moveBefore", {
        value: undefined,
        configurable: true,
      });
      const { parkHost, placeHost } = await import(/* @vite-ignore */ modulePath);
      const frame = document.querySelector('iframe[data-artifact-static-document="true"]')!;
      const host = frame.closest<HTMLElement>("[data-artifact-static-state]")!;
      const originalParent = host.parentElement!;
      const park = document.createElement("div");
      document.body.appendChild(park);
      parkHost(host, park);
      placeHost(host, originalParent);
      park.remove();
    }, `/@fs${process.cwd()}/apps/web/src/lib/stable-host.ts`);
    const fresh = await rendered(page);
    await expect(fresh.locator("h1")).toHaveText("Agent activity and cost");
    expect(await page.locator(IFRAME).getAttribute("srcdoc")).not.toBe(before);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await page.screenshot({
      path: `output/visual-previews/static-after-${testInfo.project.name}.png`,
    });
    await page.reload();
    await rendered(page);
  });

  test("a session label can be selected and copied", async ({ page, context, browserName }) => {
    await open(page);
    const frame = await rendered(page);
    // The reader's own path: a click focuses the frame, then the text is selected.
    await frame.locator(".session").first().click();
    await frame.locator(".session").first().selectText();
    expect(await frame.evaluate(() => document.getSelection()?.toString())).toBe("UI polish");
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.keyboard.press("ControlOrMeta+C");
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe("UI polish");
    }
  });

  test("content is responsive and stays vector", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await open(page);
    let frame = await rendered(page);
    const metrics = () =>
      frame.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        columns: getComputedStyle(document.querySelector(".row")!).gridTemplateColumns.split(" ")
          .length,
      }));
    await expect.poll(async () => (await metrics()).columns).toBe(4);
    expect((await metrics()).overflow).toBe(0);
    const wideHeight = await frameHeight(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await metrics()).columns).toBe(3);
    expect((await metrics()).overflow).toBe(0);
    await expect.poll(() => frameHeight(page)).toBeGreaterThan(wideHeight);
    frame = await rendered(page);
    expect(await frame.locator("svg.timeline rect").count()).toBeGreaterThan(4);
  });

  test("a native disclosure opens and closes, and the frame follows both ways", async ({
    page,
  }) => {
    await open(page);
    const frame = await rendered(page);
    const before = await frameHeight(page);
    await frame.locator("summary").click();
    await expect(frame.locator("details#methodology")).toHaveAttribute("open", "");
    await expect.poll(() => frameHeight(page)).toBeGreaterThan(before);
    await frame.locator("summary").click();
    await expect(frame.locator("details#methodology")).not.toHaveAttribute("open", "");
    await expect.poll(() => frameHeight(page)).toBeLessThanOrEqual(before + 1);
    // The whole content fits; the inline frame shows no scrollbar of its own.
    expect(
      await frame.evaluate(() => {
        const root = document.documentElement;
        return root.scrollHeight - root.clientHeight;
      }),
    ).toBeLessThanOrEqual(1);
  });

  test("source, saved preview and expanded views are each accurate", async ({ page }) => {
    await open(page);
    await rendered(page);
    await page.getByRole("button", { name: "Saved preview", exact: true }).click();
    await expect(page.locator('[data-artifact-capture="true"]')).toBeVisible();
    await expect(page.locator(IFRAME)).toHaveCount(0);
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await expect(page.getByText("Agent activity and cost").first()).toBeVisible();
    await expect(page.locator(IFRAME)).toHaveCount(0);
    await page.getByRole("button", { name: "Document", exact: true }).click();
    await rendered(page);
    await page.getByRole("button", { name: "Expand document", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const expanded = dialog.locator(`${IFRAME}[data-mode="expanded"][data-state="rendered"]`);
    await expect(expanded).toBeVisible();
    const inner = await (await expanded.elementHandle())!.contentFrame();
    await expect(inner!.locator("h1")).toHaveText("Agent activity and cost");
    await inner!.locator(".session").first().selectText();
    expect(await inner!.evaluate(() => document.getSelection()?.toString())).toBe("UI polish");
    // Escape inside the frame reaches the host through its one narrow message.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await rendered(page);
  });

  test("a reload replays the same published document", async ({ page }) => {
    await open(page);
    await rendered(page);
    await page.reload();
    const frame = await rendered(page);
    await expect(frame.locator("h1")).toHaveText("Agent activity and cost");
  });

  test("the theme follows the application without reloading or re-reading", async ({ page }) => {
    await open(page);
    const frame = await rendered(page);
    const stats = () =>
      page.evaluate(() =>
        (
          window as unknown as {
            __staticFixture: {
              stats: () => { framesMounted: number };
              calls: () => Record<string, number>;
            };
          }
        ).__staticFixture.calls(),
      );
    const before = await stats();
    const themeOf = () => frame.evaluate(() => document.documentElement.dataset.orkTheme);
    const appTheme = () =>
      page.evaluate(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));
    const initial = await themeOf();
    expect(initial).toBe(await appTheme());
    const initialText = await frame.evaluate(() => getComputedStyle(document.body).color);
    await page.getByRole("button", { name: "Toggle theme" }).click();
    const toggled = initial === "dark" ? "light" : "dark";
    await expect.poll(themeOf).toBe(toggled);
    expect(await frame.evaluate(() => getComputedStyle(document.body).color)).not.toBe(initialText);
    expect(await frame.evaluate(() => document.documentElement.style.colorScheme)).toBe(toggled);
    expect(await stats()).toEqual(before);
  });

  test("a document with hard-coded colours stays readable under the dark theme", async ({
    page,
  }) => {
    await open(page, "doc=plain");
    const frame = await rendered(page);
    const colours = await frame.evaluate(() => ({
      theme: document.documentElement.dataset.orkTheme,
      canvas: getComputedStyle(document.documentElement).backgroundColor,
      inherited: getComputedStyle(document.querySelector("#inherited")!).color,
      card: getComputedStyle(document.querySelector(".card")!).backgroundColor,
    }));
    expect(colours.theme).toBe("light");
    expect(colours.canvas).toBe("rgb(255, 255, 255)");
    expect(colours.card).toBe("rgb(255, 255, 255)");
    expect(colours.inherited).toBe("rgb(0, 0, 0)");
    expect(
      await page.locator(IFRAME).evaluate((element) => getComputedStyle(element).colorScheme),
    ).toBe("light");
  });

  test("a themed document's canvas stays transparent over the card", async ({ page }) => {
    await open(page);
    const frame = await rendered(page);
    expect(
      await frame.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    expect(
      await page.locator(IFRAME).evaluate((element) => getComputedStyle(element).colorScheme),
    ).toBe("dark");
  });

  test("authored code never runs and nothing is fetched", async ({ page }) => {
    // A policy-blocked resource is reported as a request; only one that reached
    // the network layer could have left the machine.
    const sent: string[] = [];
    const refused: Array<string | undefined> = [];
    await page.route(/hostile\.invalid/, (route) => {
      sent.push(route.request().url());
      return route.abort();
    });
    page.on("requestfailed", (request) => {
      if (request.url().includes("hostile.invalid")) refused.push(request.failure()?.errorText);
    });
    await open(page, "doc=hostile");
    const frame = await rendered(page);
    await expect(frame.locator("#title")).toHaveText("Hostile report");
    expect(
      await frame.evaluate(() => (window as unknown as { __authored?: unknown }).__authored),
    ).toBeUndefined();
    await expect(frame.locator("script,iframe,object,embed,base,meta,link")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(sent).toEqual([]);
    expect(refused.every((reason) => reason === "csp")).toBe(true);
  });

  test("opening and closing repeatedly converges and never reloads a frame", async ({ page }) => {
    await open(page);
    await rendered(page);
    const stats = () =>
      page.evaluate(() =>
        (
          window as unknown as {
            __staticFixture: {
              stats: () => {
                claims: number;
                granted: number;
                framesReloaded: number;
                framesFailed: number;
              };
            };
          }
        ).__staticFixture.stats(),
      );
    for (let cycle = 0; cycle < 6; cycle++) {
      await page.getByRole("button", { name: "Saved preview", exact: true }).click();
      await expect(page.locator(IFRAME)).toHaveCount(0);
      await page.getByRole("button", { name: "Document", exact: true }).click();
      await rendered(page);
      await page.getByRole("button", { name: "Expand document", exact: true }).click();
      await expect(
        page.getByRole("dialog").locator(`${IFRAME}[data-state="rendered"]`),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await rendered(page);
    }
    expect(await page.locator(IFRAME).count()).toBe(1);
    expect(await stats()).toMatchObject({
      claims: 1,
      granted: 1,
      framesReloaded: 0,
      framesFailed: 0,
    });
  });

  test("a frame in a hidden tab keeps its last height", async ({ page }) => {
    await open(page);
    await rendered(page);
    await expect.poll(() => frameHeight(page)).toBeGreaterThan(300);
    const before = await frameHeight(page);
    await page.getByTestId("scroller").evaluate((element) => {
      element.style.display = "none";
    });
    await page.waitForTimeout(800);
    await page.getByTestId("scroller").evaluate((element) => {
      element.style.display = "";
    });
    await page.waitForTimeout(800);
    expect(await frameHeight(page)).toBe(before);
    await expect(page.locator(`${IFRAME}[data-state="rendered"]`)).toHaveCount(1);
  });

  test("links, SVG links and forms do not navigate; a real click asks the host", async ({
    page,
  }) => {
    await open(page, "doc=hostile");
    const frame = await rendered(page);
    const url = frame.url();
    await frame.locator("#submit").click();
    await frame.locator("#download-link").click();
    await frame.locator("#web-link").click({ button: "middle" });
    await frame.locator("#js-link").click({ force: true });
    await frame.locator("#svg-rect").click();
    expect(frame.url()).toBe(url);
    const request = page.locator('[data-artifact-link-request="true"]');
    await expect(request).toContainText("Open example.com");
    await frame.locator("#web-link").click();
    await request.getByRole("button", { name: /Open example\.com/ }).click();
    await expect(request).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { __staticFixture: { opened: () => string[] } }
          ).__staticFixture.opened(),
        ),
      )
      .toEqual(["https://example.com/page"]);
    expect(frame.url()).toBe(url);
  });

  test("forged messages from any other window change nothing", async ({ page }) => {
    await open(page);
    await rendered(page);
    const before = await frameHeight(page);
    await page.evaluate(() => {
      const forged = (height: number) => ({
        channel: "orkestrator-static-html",
        v: 1,
        type: "size",
        generation: "g".repeat(32),
        height,
      });
      window.postMessage(forged(1500), "*");
      const other = document.createElement("iframe");
      other.setAttribute("sandbox", "allow-scripts");
      other.srcdoc = `<script>parent.postMessage(${JSON.stringify(forged(1400))}, "*");</script>`;
      document.body.append(other);
    });
    await page.waitForTimeout(400);
    expect(await frameHeight(page)).toBe(before);
    await expect(page.locator('[data-artifact-link-request="true"]')).toHaveCount(0);
  });

  test("an unexpected reload invalidates the mount until an explicit retry", async ({ page }) => {
    await open(page);
    const frame = await rendered(page);
    await frame.evaluate(() => window.location.reload());
    await expect(page.getByText("reloaded unexpectedly")).toBeVisible();
    await expect(page.locator(IFRAME)).toHaveCount(0);
    await expect(page.locator('[data-artifact-capture="true"]')).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    const fresh = await rendered(page);
    await expect(fresh.locator("h1")).toHaveText("Agent activity and cost");
  });

  test("a tampered document is refused and the saved preview stays", async ({ page }) => {
    await open(page, "tamper=1");
    await expect(page.getByText("did not match its verification receipt")).toBeVisible();
    await expect(page.locator(IFRAME)).toHaveCount(0);
    await expect(page.locator('[data-artifact-capture="true"]')).toBeVisible();
  });

  test("over-budget documents say so and keep saved preview and source", async ({ page }) => {
    await open(page, "doc=oversized");
    await expect(page.getByText("larger than the 256 KiB inline display budget")).toBeVisible();
    await expect(page.locator(IFRAME)).toHaveCount(0);
    await expect(page.locator('[data-artifact-capture="true"]')).toBeVisible();
    await open(page, "doc=elements");
    await expect(page.getByText("more than 5000 elements")).toBeVisible();
    await expect(page.locator(IFRAME)).toHaveCount(0);
    await expect(page.locator('[data-artifact-capture="true"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Source", exact: true })).toBeVisible();
  });

  test("a tall report never clips silently: bounded inline, reachable, expandable", async ({
    page,
  }) => {
    await open(page, "doc=tall");
    const frame = await rendered(page);
    await expect.poll(() => frameHeight(page)).toBe(1600);
    await expect(page.getByText("taller than the 1600 px inline limit")).toBeVisible();
    await frame.locator("#report-end").scrollIntoViewIfNeeded();
    await expect(frame.locator("#report-end")).toBeInViewport();
    await page.getByRole("button", { name: "Expand", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const expanded = dialog.locator(`${IFRAME}[data-state="rendered"]`);
    await expect(expanded).toBeVisible();
    const inner = await (await expanded.elementHandle())!.contentFrame();
    await inner!.locator("#report-end").scrollIntoViewIfNeeded();
    await expect(inner!.locator("#report-end")).toBeInViewport();
  });

  test("frames are bounded, the rest defer honestly, and expansion takes priority", async ({
    page,
  }) => {
    await open(page, "count=6");
    await expect(page.locator(`${IFRAME}[data-state="rendered"]`)).toHaveCount(4);
    const deferred = page.locator('[data-artifact-static-state="deferred"]');
    await expect(deferred).toHaveCount(2);
    await expect(deferred.first().locator('[data-artifact-capture="true"]')).toBeVisible();
    await expect(deferred.first().getByText("reports are already open")).toBeVisible();
    await deferred.first().getByRole("button", { name: "Open this report" }).click();
    await expect(
      page.getByRole("dialog").locator(`${IFRAME}[data-state="rendered"]`),
    ).toBeVisible();
    await expect(page.locator(IFRAME)).toHaveCount(4);
  });

  test("static documents do not touch the single interactive host", async ({ page }) => {
    await open(page, "count=2&interactive=1");
    await expect(page.locator(`${IFRAME}[data-state="rendered"]`)).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Run interactive" })).toBeVisible();
    const calls = await page.evaluate(() =>
      (
        window as unknown as { __staticFixture: { calls: () => Record<string, number> } }
      ).__staticFixture.calls(),
    );
    expect(calls.transcript_artifact_open_live_session).toBeUndefined();
  });

  test("the rollback control keeps every card on its saved preview", async ({ page }) => {
    await open(page, "presentation=off");
    await expect(page.locator('[data-artifact-capture="true"]')).toBeVisible();
    await expect(page.locator(IFRAME)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Document", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
  });
});
