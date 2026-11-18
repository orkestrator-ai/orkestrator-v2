import { expect, test, type Locator, type Page } from "@playwright/test";

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(channels: number[]): number {
  return (
    0.2126 * linearChannel(channels[0]!) +
    0.7152 * linearChannel(channels[1]!) +
    0.0722 * linearChannel(channels[2]!)
  );
}

async function renderedContrast(surface: Locator, text: Locator = surface): Promise<number> {
  // The screenshot includes opacity, backdrop filters and any surface underneath.
  // Sample inside the top padding, clear of borders, rounding and glyphs.
  const screenshot = await surface.screenshot({ animations: "disabled", scale: "css" });
  const { foreground, background } = await text.evaluate(async (element, png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const background = context.getImageData(Math.floor(image.width / 2), 3, 1, 1).data;
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    const foreground = context.getImageData(0, 0, 1, 1).data;
    return { foreground: Array.from(foreground), background: Array.from(background) };
  }, screenshot.toString("base64"));
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function expectConfirmationContrast(page: Page, button: Locator) {
  await expect(button).toBeEnabled();
  await page.mouse.move(0, 0);
  expect(await renderedContrast(button), "resting contrast").toBeGreaterThanOrEqual(4.5);
  await button.hover();
  expect(await renderedContrast(button), "hover contrast").toBeGreaterThanOrEqual(4.5);
  await page.mouse.down();
  try {
    expect(await renderedContrast(button), "pressed contrast").toBeGreaterThanOrEqual(4.5);
  } finally {
    // Release outside the control so checking :active does not confirm the action.
    await page.mouse.move(0, 0);
    await page.mouse.up();
  }
}

test("Claude's Deny label is readable in each enabled state", async ({ page }) => {
  await page.goto("/tmux-mail-tiles?approval");
  await expectConfirmationContrast(page, page.getByRole("button", { name: "Deny", exact: true }));
});

test("machine confirmation labels are readable in each enabled state", async ({ page }) => {
  await page.goto("/machines-settings");
  await page.getByRole("button", { name: /^Settings for Desk/ }).click();
  const settings = page.getByRole("dialog", { name: /^Desk with/ });
  const confirmation = page.getByRole("alertdialog");

  await settings.getByRole("button", { name: "Forget on this device" }).click();
  await expectConfirmationContrast(
    page,
    confirmation.getByRole("button", { name: "Forget on this device" }),
  );
  await confirmation.getByRole("button", { name: "Cancel" }).click();

  await settings.getByRole("button", { name: /^Remove Desk/ }).click();
  await expectConfirmationContrast(
    page,
    confirmation.getByRole("button", { name: "Remove", exact: true }),
  );
  await confirmation.getByRole("button", { name: "Cancel" }).click();
});

test("the disconnect notice stays readable over a white terminal", async ({ page }) => {
  await page.goto("/terminal-corner-toolbar?light");
  await expect(page.getByTestId("terminal-ready")).toHaveText("true");
  await expect(page.locator(".xterm-viewport")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.getByRole("button", { name: "Show disconnected" }).click();
  const banner = page.getByTestId("terminal-pane").getByRole("status");
  const message = banner.getByText("This terminal is disconnected and is not accepting input.");
  expect(await renderedContrast(banner, message)).toBeGreaterThanOrEqual(4.5);
  await banner.getByRole("button", { name: "Reconnect" }).click();
  await expect(banner).toHaveCount(0);
});

test("the root terminal tooltip keeps its privilege warning colour", async ({ page }) => {
  await page.goto("/auto-merge-error?message=none&terminalControls");
  const rootTerminal = page.getByRole("button", { name: "New root terminal" });
  await expect(rootTerminal).toBeEnabled();
  await rootTerminal.hover();
  const warning = page.getByText("Full root privileges inside container", { exact: true }).first();
  await expect(warning).toBeVisible();
  await expect(warning).toHaveClass(/\btext-red-500\b/);
});

test("the mail delivery failure badge uses the failure colour after reload", async ({ page }) => {
  await page.goto("/mail-tiles?variant=delivery-failed");
  const status = page
    .locator('[data-mail-status="error"]')
    .filter({ hasText: /^delivery failed$/ });
  const assertFailureTone = async () => {
    await expect(status).toBeVisible();
    await expect(status).toHaveClass(/\btext-failure\b/);
    await expect(status).toHaveClass(/\bbg-failure\/10\b/);
  };
  await assertFailureTone();
  await page.reload();
  await assertFailureTone();
});
