import { expect, test, type Page } from "@playwright/test";

/*
 * The window's layout roots are `overflow: hidden`, which stops wheel
 * scrolling but not programmatic scrolling. A `scrollIntoView` or `focus()`
 * deep in the shell used to scroll them and leave the window shifted up over a
 * blank band until restart. These run the real stylesheet, the real shell
 * components, the real panel group and the listener `App` installs.
 */

type Offset = { element: string; top: number; left: number };

/** Scroll offsets of `html`, `body`, `#root` and every element marked pinned. */
async function layoutRootOffsets(page: Page): Promise<Offset[]> {
  return page.evaluate(() => {
    const elements = [
      document.documentElement,
      document.body,
      document.getElementById("root")!,
      ...Array.from(document.querySelectorAll("[data-pinned-scroll]")),
    ];
    return elements.map((element) => ({
      element:
        element.getAttribute("data-testid") ??
        (element.id ? `#${element.id}` : element.tagName.toLowerCase()),
      top: element.scrollTop,
      left: element.scrollLeft,
    }));
  });
}

async function expectLayoutRootsSettledAtZero(page: Page) {
  await expect
    .poll(async () =>
      (await layoutRootOffsets(page)).filter((offset) => offset.top !== 0 || offset.left !== 0),
    )
    .toEqual([]);
}

for (const layout of ["desktop", "mobile"] as const) {
  test.describe(`${layout} shell`, () => {
    test("the fixture reproduces the shift when nothing pins the layout roots", async ({
      page,
    }) => {
      await page.goto(`/pinned-scroll?layout=${layout}&unpinned`);
      await expect(page.getByTestId("pinned-target")).toBeAttached();
      // Each layout has its frame and two more pinned roots between it and the content.
      expect(await page.locator("[data-pinned-scroll]").count()).toBe(3);

      await page.evaluate(() =>
        document.querySelector("[data-testid='pinned-target']")!.scrollIntoView(),
      );
      const shifted = (await layoutRootOffsets(page)).filter((offset) => offset.top > 0);
      // Without the pin the shell's own `main` is left scrolled: this is the bug.
      expect(shifted.length).toBeGreaterThan(0);
    });

    test("scrollIntoView and focus deep in the shell leave every layout root at zero", async ({
      page,
    }) => {
      await page.goto(`/pinned-scroll?layout=${layout}`);
      const frame = page.getByTestId("pinned-frame");
      await expect(page.getByTestId("pinned-target")).toBeAttached();
      expect(await page.locator("[data-pinned-scroll]").count()).toBe(3);

      await page.evaluate(() =>
        document.querySelector("[data-testid='pinned-target']")!.scrollIntoView({ block: "end" }),
      );
      await expectLayoutRootsSettledAtZero(page);

      // A focus without `preventScroll` scrolls its ancestors the same way.
      await page.getByRole("textbox", { name: "Late input" }).focus();
      await expect(page.getByRole("textbox", { name: "Late input" })).toBeFocused();
      await expectLayoutRootsSettledAtZero(page);

      // The smooth form the initialization log used, which scrolls over several frames.
      await page.evaluate(() =>
        document
          .querySelector("[data-testid='pinned-target']")!
          .scrollIntoView({ behavior: "smooth", block: "end" }),
      );
      await expectLayoutRootsSettledAtZero(page);

      // No blank band: the frame still fills the viewport from its top edge.
      const box = (await frame.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.y).toBe(0);
      expect(box.height).toBe(viewport.height);
    });

    test("the log box still scrolls to its last line while its ancestors stay pinned", async ({
      page,
    }) => {
      await page.goto(`/pinned-scroll?layout=${layout}`);
      const log = page.getByTestId("pinned-log");
      const lastLine = page.getByTestId("pinned-log-line-199");
      await expect(lastLine).toBeAttached();

      // What `InitializationLogs` does now: scroll its own box to the tail.
      await log.evaluate((element) =>
        element.scrollTo({ top: element.scrollHeight, behavior: "smooth" }),
      );
      await expect
        .poll(() =>
          log.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      await expectLayoutRootsSettledAtZero(page);

      // And the call it used before, which also reaches every ancestor.
      await log.evaluate((element) => {
        element.scrollTop = 0;
      });
      await lastLine.evaluate((element) => element.scrollIntoView({ behavior: "smooth" }));
      await expectLayoutRootsSettledAtZero(page);
      await expect
        .poll(() =>
          log.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const line = element.lastElementChild!.getBoundingClientRect();
            return line.top >= box.top - 1 && line.bottom <= box.bottom + 1;
          }),
        )
        .toBe(true);
      expect(await log.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    });
  });
}
