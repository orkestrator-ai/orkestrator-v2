import { expect, test } from "@playwright/test";

test("Find reveals a match in failure Details and restores its prior state", async ({
  page,
}, info) => {
  await page.clock.setFixedTime(new Date("2026-11-19T10:00:02.000Z"));
  await page.goto("/provider-failure");
  const card = page.getByRole("group", { name: "Sign-in needed" });
  const details = card.getByRole("button", { name: "Details" });
  const technicalText = card.getByText(/Please pass a valid API key/);
  await expect(card.getByRole("button", { name: "Sign in to openai again" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(technicalText).toBeHidden();
  if (process.env.ORKESTRATOR_CAPTURE_VISUALS === "1") {
    await page.screenshot({
      path: `output/visual-previews/failure-recovery-closed-${info.project.name}.png`,
    });
  }

  await details.focus();
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByPlaceholder("Find in chat");
  await find.fill("Please pass a valid API key");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(technicalText).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const entry = Array.from(CSS.highlights).find(([name]) =>
          name.startsWith("agent-chat-find-current-"),
        );
        const range = entry && Array.from(entry[1])[0];
        return range instanceof Range && range.getBoundingClientRect().height > 0
          ? range.toString()
          : "";
      }),
    )
    .toBe("Please pass a valid API key");
  if (process.env.ORKESTRATOR_CAPTURE_VISUALS === "1") {
    await page.screenshot({
      path: `output/visual-previews/failure-recovery-find-${info.project.name}.png`,
    });
  }

  await find.press("Escape");
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(technicalText).toBeHidden();
  await details.click();
  await page.keyboard.press("ControlOrMeta+f");
  await find.fill("valid API key");
  await find.press("Escape");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(technicalText).toBeVisible();
});

test("a mounted usage-limit alert removes the verified reset when it passes", async ({
  page,
}, info) => {
  await page.clock.install({ time: new Date("2026-11-19T10:00:00.000Z") });
  await page.goto("/provider-failure");
  const alert = page.getByRole("group", { name: "Usage limit reached" });
  const reset = alert.getByText(/The limit resets at/);
  await expect(reset).toBeVisible();
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
  if (process.env.ORKESTRATOR_CAPTURE_VISUALS === "1") {
    await alert.screenshot({
      path: `output/visual-previews/failure-recovery-reset-upcoming-${info.project.name}.png`,
    });
  }
  await page.clock.fastForward(31 * 60 * 1_000);
  await expect(reset).toHaveCount(0);
  if (process.env.ORKESTRATOR_CAPTURE_VISUALS === "1") {
    await alert.screenshot({
      path: `output/visual-previews/failure-recovery-reset-expired-${info.project.name}.png`,
    });
  }
});
