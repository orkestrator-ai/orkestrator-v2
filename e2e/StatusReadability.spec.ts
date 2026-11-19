import { expect, test } from "@playwright/test";

test("status labels are readable and fit the transcript", async ({ page }, testInfo) => {
  await page.goto("/status-readability");
  for (const name of [/1\/4 complete/, /1 task tracked/, /no tasks/]) {
    const trigger = page.getByRole("button", { name });
    await trigger.focus();
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  }

  const mutedColor = await page
    .getByTestId("muted-color")
    .evaluate((element) => getComputedStyle(element).color);
  for (const name of [
    "1/4 complete (1 canceled)",
    "1 task tracked +2 more",
    "no tasks",
    "Task list is empty.",
    /Retire obsolete fixture$/,
    "Tasks created before this session was being watched are not shown.",
    "2 more tasks not shown.",
  ]) {
    await expect(page.getByText(name, { exact: true })).toHaveCSS("color", mutedColor);
  }
  await expect(page.getByText("Retire obsolete fixture")).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
  for (const status of ["in progress", "canceled"]) {
    const badge = page.getByText(status, { exact: true });
    await expect(badge).toHaveCSS("font-size", "11px");
    await expect(badge).toBeInViewport({ ratio: 1 });
  }

  await expect(page.getByRole("img", { name: "Not verified yet" })).toHaveCSS("color", mutedColor);

  await page.getByRole("button", { name: "Retry setup", exact: true }).click();
  const retrying = page.getByRole("button", { name: "Retrying setup..." });
  await expect(retrying).toBeDisabled();
  await expect(retrying).toHaveCSS("color", mutedColor);
  await expect(retrying).toHaveCSS("opacity", "1");

  if (process.env.STATUS_READABILITY_CAPTURE === "after") {
    await page.getByTestId("status-readability").screenshot({
      path: `output/visual-previews/status-readability-after-${testInfo.project.name}.png`,
      animations: "disabled",
    });
  }

  await page.evaluate(() => window.dispatchEvent(new Event("finish-fixture-retry")));
  await expect(page.getByRole("status")).toHaveText("Waiting for setup scripts to complete...");
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry setup", exact: true })).toBeEnabled();
});

test("folded tool count and duration match and fit with their icons", async ({ page }) => {
  await page.goto("/status-readability");
  const group = page.getByRole("button", { name: /^(Show|Fold) 3 tool calls:/ });
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(group.getByText("1 failed", { exact: true })).toBeVisible();
  await expect(group).toBeInViewport({ ratio: 1 });

  const mutedColor = await page
    .getByTestId("muted-color")
    .evaluate((element) => getComputedStyle(element).color);
  const count = group.getByTitle("3 tool calls");
  const duration = group.getByTitle(/^First call started to last call finished:/);
  await expect(count.locator("svg.lucide-wrench")).toBeVisible();
  await expect(duration.locator("svg.lucide-timer[aria-hidden='true']")).toBeVisible();
  for (const stat of [count, duration]) {
    await expect(stat).toHaveCSS("font-size", "11px");
    await expect(stat).toHaveCSS("color", mutedColor);
    expect(
      await stat.evaluate((element) => {
        const row = element.closest("button")!.getBoundingClientRect();
        const content = document.createRange();
        content.selectNodeContents(element);
        const bounds = content.getBoundingClientRect();
        return bounds.left >= row.left && bounds.right <= row.right;
      }),
    ).toBe(true);
  }

  await group.press("Enter");
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTitle("Ran for 250ms").locator("svg.lucide-timer")).toHaveCount(3);
});
