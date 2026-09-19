import { expect, test, type Page } from "@playwright/test";

async function colorForClass(page: Page, className: string) {
  return page.locator("main").evaluate((main, referenceClass) => {
    const reference = document.createElement("span");
    reference.className = referenceClass;
    main.appendChild(reference);
    const color = getComputedStyle(reference).color;
    reference.remove();
    return color;
  }, className);
}

test("CI status announces running, failed, and successful completion", async ({ page }) => {
  await page.goto("/pr-check-status");

  const status = page.getByRole("status");
  await expect(status).toBeVisible();
  await expect(status).toHaveText("3 of 4 CI checks passed; 1 still running");
  await expect(status).toHaveAttribute("data-state", "running");
  const runningText = await status.textContent();
  const viewPrButton = page.getByRole("button", { name: "View PR", exact: true });
  const visualStatus = page.locator('[data-pr-check-status="visual"]');
  await expect(viewPrButton).toHaveText(/View PR\s*\(3\/4\)/);
  await expect(visualStatus).toHaveClass(/text-amber-700/);
  await expect(visualStatus.locator('[data-status-icon="running"]')).toBeVisible();
  expect(await visualStatus.evaluate((element) => getComputedStyle(element).color)).toBe(
    await colorForClass(page, "text-amber-700"),
  );

  await page.getByRole("button", { name: "Continue with failure" }).click();
  await expect(status).toHaveText("1 of 4 CI checks passed; 1 failed; 2 still running");
  await expect(status).toHaveAttribute("data-state", "running");
  await expect(visualStatus).toHaveClass(/text-amber-700/);
  await expect(visualStatus.locator('[data-status-icon="running"]')).toBeVisible();

  await page.getByRole("button", { name: "Complete with failure" }).click();
  await expect(status).toHaveText("3 of 4 CI checks passed; 1 failed; all checks complete");
  expect(await status.textContent()).not.toBe(runningText);
  await expect(status).toHaveAttribute("data-state", "failed");
  await expect(visualStatus).toHaveClass(/text-red-600/);
  await expect(visualStatus.locator('[data-status-icon="failed"]')).toBeVisible();
  expect(await visualStatus.evaluate((element) => getComputedStyle(element).color)).toBe(
    await colorForClass(page, "text-red-600"),
  );

  await page.getByRole("button", { name: "Complete successfully" }).click();
  await expect(status).toHaveText("4 of 4 CI checks passed; all checks complete");
  await expect(status).toHaveAttribute("data-state", "passed");
  await expect(visualStatus).toHaveClass(/text-green-600/);
  await expect(visualStatus.locator('[data-status-icon="passed"]')).toBeVisible();
  expect(await visualStatus.evaluate((element) => getComputedStyle(element).color)).toBe(
    await colorForClass(page, "text-green-600"),
  );
});

test("CI status fits the View PR button in grid presentation", async ({ page }) => {
  await page.goto("/pr-check-status?grid");

  const button = page.getByRole("button", { name: "View PR", exact: true });
  const status = page.locator('[data-pr-check-status="visual"]');
  const label = page.getByText("View PR", { exact: true });
  await expect(status).toHaveClass(/text-xs/);
  await expect(button).toHaveText(/View PR\s*\(3\/4\)/);

  const [buttonBox, statusBox] = await Promise.all([button.boundingBox(), status.boundingBox()]);
  expect(buttonBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(buttonBox!.x + buttonBox!.width);
  expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const statusColor = await status.evaluate((element) => getComputedStyle(element).color);
  const labelColor = await label.evaluate((element) => getComputedStyle(element).color);
  expect(statusColor).not.toBe(labelColor);
});

test("CI status applies each dark-theme state color", async ({ page }) => {
  await page.goto("/pr-check-status?dark");

  const status = page.locator('[data-pr-check-status="visual"]');
  await expect(status).toHaveClass(/dark:text-amber-400/);
  expect(await status.evaluate((element) => getComputedStyle(element).color)).toBe(
    await colorForClass(page, "text-amber-400"),
  );

  await page.getByRole("button", { name: "Complete with failure" }).click();
  await expect(status).toHaveClass(/dark:text-red-400/);
  expect(await status.evaluate((element) => getComputedStyle(element).color)).toBe(
    await colorForClass(page, "text-red-400"),
  );

  await page.getByRole("button", { name: "Complete successfully" }).click();
  await expect(status).toHaveClass(/dark:text-green-400/);
  expect(await status.evaluate((element) => getComputedStyle(element).color)).toBe(
    await colorForClass(page, "text-green-400"),
  );
});
