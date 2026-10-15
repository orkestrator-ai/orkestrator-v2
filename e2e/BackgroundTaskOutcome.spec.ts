import { expect, test, type Page } from "@playwright/test";

async function openOutcome(page: Page, label: "Task" | "Agent") {
  const row = page.getByRole("button", { name: new RegExp(`${label} Review validation`) });
  if (!(await page.getByText("Two checks failed", { exact: true }).isVisible())) {
    await row.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByText("Two checks failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Error", { exact: true })).toBeVisible();
  await expect(page.getByText("7 tool uses", { exact: true })).toBeVisible();
  await expect(page.getByText("12k tokens", { exact: true })).toBeVisible();
  await expect(page.getByText("/tmp/tasks/shared.output", { exact: true })).toBeVisible();
}

for (const tool of ["Agent", "Task", "Bash"] as const) {
  for (const container of [false, true]) {
    test(`${tool} outcomes survive launch loading and remount in ${container ? "container" : "local"} environments`, async ({
      page,
    }) => {
      await page.goto(`/background-task-outcome?tool=${tool}${container ? "&container=1" : ""}`);
      await openOutcome(page, "Task");
      await page.getByRole("button", { name: "Load launch", exact: true }).click();
      await openOutcome(page, tool === "Bash" ? "Task" : "Agent");
      const reveal = page.getByRole("button", { name: "Reveal output file", exact: true });
      if (container) await expect(reveal).toHaveCount(0);
      else await expect(reveal).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Copy output file path", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Switch environment", exact: true }).click();
      await expect(page.getByText("Other environment", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Return to task", exact: true }).click();
      await openOutcome(page, tool === "Bash" ? "Task" : "Agent");
      await page.reload();
      await openOutcome(page, tool === "Bash" ? "Task" : "Agent");
      if (container) await expect(reveal).toHaveCount(0);
      else await expect(reveal).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
}

for (const tool of ["Agent", "Bash"] as const) {
  test(`${tool} Stop reveals without moving the activity slot or card`, async ({
    page,
    isMobile,
  }) => {
    await page.goto(`/background-task-outcome?tool=${tool}&loaded=1&running=1`);
    const stop = page.getByRole("button", { name: "Stop Review validation", exact: true });
    const slot = stop.locator("..");
    const icon = slot.locator(":scope > span");
    const card = stop.locator("xpath=ancestor::*[contains(@class, 'group/stoppable')][1]");
    const trigger = page.getByRole("button", {
      name: new RegExp(`${tool === "Bash" ? "Task" : "Agent"} Review validation`),
    });
    const fineHover = await page.evaluate(
      () => matchMedia("(hover: hover) and (pointer: fine)").matches,
    );
    const desktopReveal = fineHover && !isMobile && (page.viewportSize()?.width ?? 0) >= 768;
    await page.mouse.move(0, 0);
    await expect(stop).toHaveCSS("opacity", desktopReveal ? "0" : "1");
    await expect(icon).toHaveCSS("opacity", desktopReveal ? "1" : "0");
    const before = {
      slot: await slot.boundingBox(),
      card: await card.boundingBox(),
      trigger: await trigger.boundingBox(),
    };
    expect(before.slot?.width).toBe(28);
    expect(before.slot?.height).toBe(28);

    if (desktopReveal) {
      // Hover the title, proving the whole tile reveals Stop.
      await trigger.hover();
      await expect(stop).toHaveCSS("opacity", "1");
      await expect(icon).toHaveCSS("opacity", "0");
      expect(await slot.boundingBox()).toEqual(before.slot);
      expect(await card.boundingBox()).toEqual(before.card);
      expect(await trigger.boundingBox()).toEqual(before.trigger);
      await page.mouse.move(0, 0);
      await expect(stop).toHaveCSS("opacity", "0");
    }

    // Reach Stop using the keyboard from the preceding fixture control.
    await page.getByRole("button", { name: "Switch environment", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(stop).toBeFocused();
    await expect(stop).toHaveCSS("opacity", "1");
    await expect(icon).toHaveCSS("opacity", "0");
    expect(await slot.boundingBox()).toEqual(before.slot);
    expect(await card.boundingBox()).toEqual(before.card);
    expect(await trigger.boundingBox()).toEqual(before.trigger);

    // A fine pointer in a narrow layout uses the always-visible fallback too.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch environment", exact: true }).focus();
    await page.mouse.move(0, 0);
    await expect(stop).toHaveCSS("opacity", "1");
    await expect(icon).toHaveCSS("opacity", "0");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await page.getByRole("button", { name: "Switch environment", exact: true }).click();
    await expect(stop).toHaveCount(0);
    await page.getByRole("button", { name: "Return to task", exact: true }).click();
    await expect(stop).toHaveCSS("opacity", "1");
    await page.reload();
    await expect(stop).toHaveCSS("opacity", "1");
    await stop.click();
    await expect(stop).toHaveCount(0);
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    await page.reload();
    await expect(stop).toHaveCount(0);
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  });
}

for (const tool of ["Agent", "Bash"]) {
  test(`${tool} duration includes separately reported pauses before and after settle`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Date.now = () => Date.parse("2026-08-16T10:03:05Z");
    });
    await page.goto(
      `/background-task-outcome?tool=${tool}&loaded=1&running=1&paused=1&startedAt=2026-08-16T10:00:00Z`,
    );
    await expect(page.getByText("3m 5s", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Switch environment", exact: true }).click();
    await page.getByRole("button", { name: "Return to task", exact: true }).click();
    await expect(page.getByText("3m 5s", { exact: true })).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop Review validation", exact: true });
    await stop.focus();
    await stop.click();
    await expect(page.getByText("3m 5s", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("3m 5s", { exact: true })).toBeVisible();
  });
}
