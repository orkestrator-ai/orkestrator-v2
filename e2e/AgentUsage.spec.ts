import { expect, test, type Locator } from "@playwright/test";

async function assertStat(
  card: Locator,
  label: string,
  value: string,
  icon: "coins" | "wrench" | "activity",
) {
  const stat = card.getByTitle(label, { exact: true });
  await expect(stat).toBeVisible();
  await expect(stat.locator("span[aria-hidden='true']")).toHaveText(value);
  await expect(stat.locator(`svg.lucide-${icon}`)).toHaveAttribute("aria-hidden", "true");
  await expect(stat.locator(".sr-only")).toHaveText(label);
  await expect(
    card.getByRole("button", { name: /^Agent Review the compact usage presentation/ }),
  ).toHaveAccessibleName(new RegExp(label));
  // These are native browser tooltips: title is the tooltip's source, rather
  // than a separate DOM tooltip. Hover must preserve the full phrase.
  await stat.hover();
  await expect(stat).toHaveAttribute("title", label);
  const fullyVisible = await stat.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.left < 0 || rect.right > innerWidth) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) {
        const bounds = parent.getBoundingClientRect();
        if (rect.left < bounds.left || rect.right > bounds.right) return false;
      }
    }
    return true;
  });
  expect(fullyVisible).toBe(true);
  return stat;
}

for (const path of ["subagent", "task-group"]) {
  test(`${path} compact usage fits alongside the header and remains accessible after reload`, async ({
    page,
  }) => {
    await page.goto(`/agent-usage?path=${path}`);
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      for (const [id, stats] of [
        [
          "full",
          [
            ["8 tool uses", "8", "wrench"],
            ["1.2m tokens", "1.2m", "coins"],
          ],
        ],
        [
          "updates",
          [
            ["1 tool", "1", "wrench"],
            ["2 updates", "2", "activity"],
          ],
        ],
        ["cursor", [["980 tokens", "980", "coins"]]],
        ["token-only", [["1 token", "1", "coins"]]],
        [
          "auto",
          [
            ["1 tool", "1", "wrench"],
            ["auto", "auto", "coins"],
          ],
        ],
        [
          "bare",
          [
            ["1 tool", "1", "wrench"],
            ["980", "980", "coins"],
          ],
        ],
      ] as const) {
        const card = page.getByRole("region", { name: id, exact: true });
        const boxes = [];
        for (const [label, value, icon] of stats) {
          const stat = await assertStat(card, label, value, icon);
          boxes.push((await stat.boundingBox())!);
        }
        // Every statistic is on the same line, with space between its siblings.
        for (let index = 1; index < boxes.length; index++) {
          expect(Math.abs(boxes[index]!.y - boxes[0]!.y)).toBeLessThan(1);
          expect(boxes[index]!.x).toBeGreaterThan(boxes[index - 1]!.x + boxes[index - 1]!.width);
        }
        await expect(card.locator("button [title]")).toHaveCount(stats.length);
        const trigger = card.getByRole("button", {
          name: /^Agent Review the compact usage presentation/,
        });
        await expect(trigger).toHaveAccessibleName(/Review the compact usage presentation/);
        await expect(trigger).toHaveAccessibleName(/Finished/);
        await expect(trigger).toHaveAccessibleName(/2m 5s/);
        const name = trigger.locator("span.truncate").first();
        const headerBox = (await name.boundingBox())!;
        expect(headerBox.width).toBeGreaterThan(20);
        expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(boxes[0]!.x);
        await expect(card.getByText("Finished", { exact: true })).toBeVisible();
        await expect(card.getByText("2m 5s", { exact: true })).toBeVisible();
        await trigger.focus();
        await expect(trigger).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await page.keyboard.press("Enter");
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
      }
      const empty = page.getByRole("region", { name: "empty", exact: true });
      await expect(empty.locator("button [title]")).toHaveCount(0);
      await expect(empty.getByText("2m 5s", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  });
}
