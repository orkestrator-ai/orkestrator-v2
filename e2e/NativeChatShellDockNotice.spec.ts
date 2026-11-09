import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { startAnchorProbe, stopAnchorProbe, scrollDiagnostics } from "./transcript-anchor-probe";

const scrollerSelector = '[data-transcript-scroller="true"]';

async function expectClearance(page: Page, inset: boolean) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const region = document.querySelector('[data-testid="transcript-region"]')!;
        const spacer = document.querySelector('[data-testid="transcript-bottom-spacer"]')!;
        return {
          inset: parseFloat(getComputedStyle(region).paddingBottom),
          spacer: spacer.getBoundingClientRect().height,
        };
      }),
    )
    .toMatchObject(
      inset
        ? {
            spacer: 0,
          }
        : { inset: 0 },
    );
  if (inset) {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const scroller = document.querySelector('[data-transcript-scroller="true"]')!;
          const dock = document.querySelector('[data-testid="compose-dock"]')!;
          return Math.abs(
            scroller.getBoundingClientRect().bottom - dock.getBoundingClientRect().top,
          );
        }),
      )
      .toBeLessThanOrEqual(1.1);
  }
  await expect
    .poll(() =>
      page.evaluate((inset) => {
        const dock = document.querySelector('[data-testid="compose-dock"]')!;
        const target = document.querySelector(
          inset ? '[data-testid="transcript-region"]' : '[data-testid="transcript-bottom-spacer"]',
        )!;
        const reservation = inset
          ? parseFloat(getComputedStyle(target).paddingBottom)
          : target.getBoundingClientRect().height;
        return Math.abs(reservation - Math.ceil(dock.getBoundingClientRect().height));
      }, inset),
    )
    .toBeLessThanOrEqual(1);
}

async function readHistory(page: Page) {
  const scroller = page.locator(scrollerSelector);
  await expect(scroller).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight)).toBeGreaterThan(3000);
  await scroller.hover();
  await page.mouse.wheel(0, -1600);
  await expect(
    page.getByRole("button", { name: "Scroll to bottom of conversation" }),
  ).toBeVisible();
  let anchorKey: string | null = null;
  // The scroll affordance updates before Virtuoso has filled the new range.
  // Wait for a rendered history anchor rather than sampling that empty frame.
  await expect
    .poll(async () => {
      anchorKey = await scroller.evaluate((el) => {
        const viewport = el.getBoundingClientRect();
        const row = Array.from(el.querySelectorAll("[data-chat-message-key]")).find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top > viewport.top + 20 && rect.bottom < viewport.bottom - 80;
        });
        return row?.getAttribute("data-chat-message-key") ?? null;
      });
      return anchorKey;
    })
    .not.toBeNull();
  await startAnchorProbe(scroller, `css:[data-chat-message-key="${anchorKey}"]`);
  return scroller;
}

for (const notice of ["error", "desync", "refresh"]) {
  test(`${notice} notice clears a long transcript and preserves the history anchor through growth`, async ({
    page,
  }, testInfo) => {
    await page.goto("/native-dock-notice");
    const scroller = await readHistory(page);
    await page.getByRole("button", { name: notice, exact: true }).click();
    await expect(page.getByTestId("compose-dock-notice")).toBeVisible();
    if (notice === "refresh")
      await expect(page.getByTestId("session-refresh-shimmer-pinned")).toHaveAttribute(
        "data-active",
        "true",
      );
    await expectClearance(page, true);
    const before = await page.getByTestId("compose-dock").boundingBox();
    await page.getByRole("button", { name: "Grow dock" }).click();
    await expect
      .poll(async () => (await page.getByTestId("compose-dock").boundingBox())!.height)
      .toBeGreaterThan(before!.height + 100);
    await expectClearance(page, true);
    const directory = path.resolve("output/visual-previews");
    await mkdir(directory, { recursive: true });
    await page.screenshot({
      path: path.join(directory, `dock-${notice}-history-${testInfo.project.name}.png`),
    });
    await page.getByRole("button", { name: "none", exact: true }).click();
    await expectClearance(page, false);
    const probe = await stopAnchorProbe(scroller);
    expect(probe.count).toBeGreaterThan(0);
    expect(probe.missing).toBe(0);
    expect(probe.maxError, JSON.stringify(probe.trace.slice(-10))).toBeLessThanOrEqual(2);
  });
}

test("refresh moves between the pinned notice and footer as the reader returns to latest", async ({
  page,
}) => {
  await page.goto("/native-dock-notice");
  const scroller = await readHistory(page);
  await stopAnchorProbe(scroller);
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expectClearance(page, true);
  await page.getByRole("button", { name: "Scroll to bottom of conversation" }).click();
  await expect(page.getByTestId("session-refresh-shimmer-transcript")).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(page.getByTestId("session-refresh-shimmer-pinned")).toHaveCount(0);
  await expectClearance(page, false);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);
  // Geometry reaches the bottom before the controller retires its latest
  // journey. Wait for that acknowledgement before starting a new reader intent.
  await expect
    .poll(async () => {
      const stats = (await scrollDiagnostics(scroller)) as Record<string, number>;
      return (
        stats.operationsStarted! -
        stats.converged! -
        stats.clamped! -
        stats.expired! -
        stats.unresolved! -
        stats.cancelled! -
        stats.superseded!
      );
    })
    .toBe(0);
  await scroller.hover();
  await page.mouse.wheel(0, -800);
  await expect(page.getByTestId("session-refresh-shimmer-pinned")).toBeVisible();
  await expectClearance(page, true);
  await page.getByRole("button", { name: "none", exact: true }).click();
  await expectClearance(page, false);
});

for (const notice of ["error", "desync"]) {
  test(`${notice} keeps the latest response above the notice`, async ({ page }) => {
    await page.goto("/native-dock-notice");
    await expect(page.getByText(/^Transcript row 100\./)).toBeVisible();
    await page.getByRole("button", { name: notice, exact: true }).click();
    await expectClearance(page, true);
    const last = page.getByText(/^Transcript row 100\./);
    await expect(last).toBeVisible();
    await expect
      .poll(async () => {
        const row = await last.boundingBox();
        const notice = await page.getByTestId("compose-dock-notice").boundingBox();
        return row!.y + row!.height - notice!.y;
      })
      .toBeLessThanOrEqual(1);
  });
}

test("a centered composer keeps the notice without insetting the hidden transcript", async ({
  page,
}) => {
  await page.goto("/native-dock-notice");
  await page.getByRole("button", { name: "Center composer" }).click();
  await page.getByRole("button", { name: "refresh", exact: true }).click();
  await expect(page.getByTestId("session-refresh-shimmer-pinned")).toBeVisible();
  await expect(page.getByTestId("transcript-region")).toHaveCSS("padding-bottom", "0px");
  await expect(page.getByTestId("transcript-region")).toHaveCSS("opacity", "0");
});
