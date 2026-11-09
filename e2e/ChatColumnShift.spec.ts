import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const scroller = '[data-testid="transcript-region"] [data-virtuoso-scroller]';
const shell = '[style*="--chat-column-shift:"]';
const collapse = (page: Page) => page.getByRole("button", { name: "Collapse actions" });
const reopen = (page: Page) => page.getByRole("button", { name: /^Actions,/ });

async function geometry(page: Page, empty: boolean) {
  return page.evaluate(
    ({ scroller, empty }) => {
      const box = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const rect = element.getBoundingClientRect();
        return { center: rect.x + rect.width / 2, width: rect.width };
      };
      const viewport = document.querySelector<HTMLElement>(scroller)!;
      return {
        columns: [
          box('[data-testid="shift-header"]'),
          box('[data-testid="shift-footer"]'),
          box('[aria-label="Prompt"]'),
          box(
            empty
              ? '[data-testid="transcript-region"] p'
              : '[data-chat-message-key="row-0"] [data-transcript-item]',
          ),
        ],
        scroller: {
          left: viewport.getBoundingClientRect().left,
          right: viewport.getBoundingClientRect().right,
          clientWidth: viewport.clientWidth,
        },
        horizontalOverflow: viewport.scrollWidth > viewport.clientWidth,
        verticalOverflow: viewport.scrollHeight > viewport.clientHeight,
      };
    },
    { scroller, empty },
  );
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  for (const empty of [false, true]) {
    test(`real chat column shifts together at 1280px (${reducedMotion}, ${empty ? "empty" : "rows"})`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ reducedMotion });
      await page.goto("/coordinator-actions-transcript?shift-layout");
      if (empty) await page.getByRole("button", { name: "Clear transcript" }).click();
      await expect(collapse(page)).toBeVisible();
      await expect(page.locator(shell)).toHaveCSS("--chat-column-shift-duration", "300ms");
      await expect(page.locator(shell)).toHaveCSS("--chat-column-shift", "7.5rem");
      const shifted = await geometry(page, empty);
      expect(shifted.horizontalOverflow).toBe(false);
      if (!empty) expect(shifted.verticalOverflow).toBe(true);
      const panel = await page.locator("[data-actions-panel-box]").boundingBox();
      expect(shifted.columns[0]!.center + shifted.columns[0]!.width / 2).toBeLessThan(panel!.x);
      await page.screenshot({
        path: path.resolve(
          `output/visual-previews/shift-${testInfo.project.name}-${reducedMotion}-${empty}-open.png`,
        ),
      });

      await collapse(page).focus();
      await page.keyboard.press("Enter");
      await expect(reopen(page)).toBeFocused();
      await expect
        .poll(async () => (await geometry(page, empty)).columns[0]!.center)
        .toBeCloseTo(640, 0);
      const centered = await geometry(page, empty);
      expect(centered.scroller).toEqual(shifted.scroller);
      for (let index = 0; index < centered.columns.length; index++) {
        expect(centered.columns[index]!.width).toBeCloseTo(shifted.columns[index]!.width, 1);
        expect(centered.columns[index]!.center - shifted.columns[index]!.center).toBeCloseTo(
          120,
          0,
        );
      }
      await page.screenshot({
        path: path.resolve(
          `output/visual-previews/shift-${testInfo.project.name}-${reducedMotion}-${empty}-folded.png`,
        ),
      });

      // Start and freeze the actual padding transitions at their midpoint.
      // Sampling browser animation time avoids a wall-clock screenshot race.
      const transitions = await reopen(page).evaluate(async (button) => {
        (button as HTMLButtonElement).click();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const elements = Array.from(
          document.querySelectorAll<HTMLElement>('[class*="chat-column-shift,0rem"]'),
        );
        return elements.map((element) => {
          const animations = element.getAnimations();
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = 150;
          }
          return {
            duration: getComputedStyle(element).transitionDuration,
            property: getComputedStyle(element).transitionProperty,
            animations: animations.length,
          };
        });
      });
      expect(transitions.length).toBeGreaterThanOrEqual(4);
      if (reducedMotion === "reduce") {
        expect(
          transitions.every((entry) => entry.property === "none" && entry.animations === 0),
        ).toBe(true);
      } else {
        expect(
          transitions.every(
            (entry) =>
              entry.property === "padding-right" &&
              entry.duration === "0.3s" &&
              entry.animations === 1,
          ),
        ).toBe(true);
        const middle = await geometry(page, empty);
        const progress = centered.columns[0]!.center - middle.columns[0]!.center;
        expect(progress).toBeGreaterThan(0);
        expect(progress).toBeLessThan(120);
        for (let index = 1; index < middle.columns.length; index++) {
          expect(centered.columns[index]!.center - middle.columns[index]!.center).toBeCloseTo(
            progress,
            0,
          );
          expect(middle.columns[index]!.width).toBeCloseTo(centered.columns[index]!.width, 1);
        }
        expect(middle.scroller).toEqual(centered.scroller);
        await page.evaluate(() => {
          for (const element of document.querySelectorAll('[class*="chat-column-shift,0rem"]')) {
            for (const animation of element.getAnimations()) animation.finish();
          }
        });
      }
      await expect
        .poll(async () => (await geometry(page, empty)).columns[0]!.center)
        .toBeCloseTo(520, 0);
      await page.reload();
      if (empty) await page.getByRole("button", { name: "Clear transcript" }).click();
      await expect(collapse(page)).toBeVisible();
      await expect
        .poll(async () => (await geometry(page, empty)).columns[0]!.center)
        .toBeCloseTo(520, 0);

      // Cross the lower fit boundary and the upper no-shift boundary.
      for (const [width, shift] of [
        [1176, "6.75rem"],
        [1168, "0rem"],
        [1392, "0rem"],
        [1280, "7.5rem"],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator(shell)).toHaveCSS("--chat-column-shift", shift);
        if (width === 1168) await expect(reopen(page)).toHaveAttribute("aria-expanded", "false");
        else await expect(collapse(page)).toBeVisible();
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator(shell)).toHaveCSS("--chat-column-shift", "0rem");
      await expect(reopen(page)).toHaveAttribute("aria-expanded", "false");
      await page.screenshot({
        path: path.resolve(
          `output/visual-previews/shift-${testInfo.project.name}-${reducedMotion}-${empty}-narrow.png`,
        ),
      });
    });
  }
}
