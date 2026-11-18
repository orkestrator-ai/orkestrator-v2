import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectHairline(target: Locator, color = "rgb(59, 130, 246)") {
  await expect(target).toHaveCSS("outline-style", "solid");
  await expect(target).toHaveCSS("outline-width", "1px");
  await expect(target).toHaveCSS("outline-offset", "-2px");
  await expect(target).toHaveCSS("outline-color", color);
}

async function expectFrame(input: Locator, frame: Locator, color?: string) {
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS("outline-style", "none");
  await expectHairline(frame, color);
}

async function systemHighlight(page: Page) {
  return page.evaluate(() => {
    const sample = document.createElement("span");
    sample.style.color = "Highlight";
    sample.style.forcedColorAdjust = "none";
    document.body.append(sample);
    const highlight = getComputedStyle(sample).color;
    sample.remove();
    return highlight;
  });
}

for (const forcedColors of ["none", "active"] as const) {
  test(`the find frame follows keyboard focus on the input (${forcedColors})`, async ({ page }) => {
    await page.emulateMedia({ forcedColors });
    await page.goto("/pipeline-worker-mail");
    const tile = page.locator("[data-mail-tile]").first();
    await expect(tile).toBeVisible();
    await page.keyboard.press("Tab");
    await tile.getByRole("button").first().focus();
    await page.keyboard.press("ControlOrMeta+f");
    const input = page.getByRole("textbox", { name: "Find in chat" });
    const frame = page.getByRole("search", { name: "Find in agent chat" });
    const close = frame.getByRole("button", { name: "Close find" });
    const highlight = forcedColors === "active" ? await systemHighlight(page) : undefined;
    await expectFrame(input, frame, highlight);

    // With no query, the match navigation buttons are disabled.
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await expect(frame).toHaveCSS("outline-style", "none");
    await expectHairline(close, highlight);
    await page.keyboard.press("Shift+Tab");
    await expectFrame(input, frame, highlight);
  });
}

test("the keyboard shortcuts search draws its outline on the frame", async ({ page }) => {
  await page.goto("/keyboard-shortcuts");
  await expect(page.getByTestId("terminal").locator("textarea")).toBeAttached();
  await page.keyboard.press("Meta+Shift+Slash");
  const input = page.getByRole("textbox", { name: "Search keyboard shortcuts" });
  await expectFrame(input, input.locator(".."));
});

test("the project search draws its outline on the frame", async ({ page }) => {
  await page.goto("/project-search-machines");
  await page.getByTestId("project-search-trigger").press("Enter");
  const input = page.getByRole("combobox", { name: "Search projects and environments" });
  await expectFrame(input, input.locator(".."));
});

test("the Coordinator action search draws its outline on the frame", async ({ page }) => {
  // At short pane heights the Actions panel hides the search trigger.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/coordinator-actions?many");
  await page.getByRole("button", { name: "Search actions", exact: true }).press("Enter");
  const input = page.getByRole("combobox", { name: "Search actions" });
  await expectFrame(input, input.locator(".."));
});

for (const composer of [
  {
    name: "pipeline",
    path: "/pipeline-flow?scenario=building",
    input: "Send a message to the agent...",
    frame: "../..",
    send: "Send message",
  },
  {
    name: "feature planning",
    path: "/focus-hairline",
    input: "Describe the feature or answer Codex...",
    frame: "..",
    send: "Send message",
  },
  {
    name: "terminal",
    path: "/focus-hairline",
    input: "Type a message (newlines become spaces)...",
    frame: "..",
    send: "Send",
  },
]) {
  test(`the ${composer.name} frame releases its outline when Send takes focus`, async ({
    page,
  }) => {
    await page.goto(composer.path);
    const input = page.getByPlaceholder(composer.input, { exact: true });
    await expect(input).toBeEditable();
    await page.keyboard.press("Tab");
    await input.focus();
    const frame = input.locator(`xpath=${composer.frame}`);
    await expectFrame(input, frame);
    await page.keyboard.type("Fixture draft");
    const send = frame.getByRole("button", { name: composer.send, exact: true });
    await expect(send).toBeEnabled();
    await page.keyboard.press("Tab");
    await expect(send).toBeFocused();
    await expect(frame).toHaveCSS("outline-style", "none");
    await expect(send).toHaveCSS("outline-width", "1px");
    await expect(send).toHaveCSS("outline-style", "solid");
  });
}

test("a GitHub repository row has an inset keyboard focus outline", async ({ page }) => {
  await page.goto("/add-project");
  await page.getByRole("button", { name: "From GitHub" }).click();
  await page.getByRole("button", { name: /^acme/ }).click();
  const row = page.getByRole("list", { name: "repositories" }).getByRole("button");
  await expect(row).toBeVisible();
  await page.keyboard.press("Tab");
  await row.focus();
  await expect(row).toBeFocused();
  await expectHairline(row);
});
