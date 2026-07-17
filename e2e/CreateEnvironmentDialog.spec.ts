import { expect, test, type Locator, type Page } from "@playwright/test";

function panelContaining(page: Page, child: Locator): Locator {
  return page.locator('[data-slot="tabs-content"]').filter({ has: child });
}

test("mobile sections have one visible panel, preserve values, and stay within the viewport", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile project only");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");

  const dialog = page.getByRole("dialog");
  const tabList = page.getByRole("tablist", {
    name: "Environment configuration sections",
  });
  const prompt = page.getByLabel("Initial Prompt (optional)");
  const environmentName = page.getByLabel("Environment Name (optional)");
  const promptPanel = panelContaining(page, prompt);
  const setupPanel = panelContaining(page, environmentName);
  const accessPanel = panelContaining(
    page,
    page.getByRole("button", { name: "Restricted" }),
  );

  await expect(dialog).toBeVisible();
  await expect(tabList).toBeVisible();
  await expect(promptPanel).toBeVisible();
  await expect(setupPanel).toBeHidden();
  await expect(accessPanel).toBeHidden();

  await page.getByRole("tab", { name: "Setup" }).click();
  await expect(setupPanel).toBeVisible();
  await expect(promptPanel).toBeHidden();
  await expect(setupPanel).toHaveAttribute("data-mobile-transition", "forward");
  await expect(setupPanel).toHaveCSS(
    "animation-name",
    "create-environment-tab-enter-forward",
  );
  await expect(setupPanel).toHaveCSS("animation-duration", "0.18s");
  await environmentName.fill("mobile-layout");

  await page.getByRole("tab", { name: "Prompt" }).click();
  await expect(promptPanel).toHaveAttribute("data-mobile-transition", "backward");
  await expect(promptPanel).toHaveCSS(
    "animation-name",
    "create-environment-tab-enter-backward",
  );
  await prompt.fill("Keep this prompt");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("tab", { name: "Setup" }).click();
  await expect(setupPanel).toHaveAttribute("data-mobile-transition", "forward");
  await expect(setupPanel).toHaveCSS("animation-name", "none");
  await expect(environmentName).toHaveValue("mobile-layout");
  await expect(prompt).toHaveValue("Keep this prompt");

  await page.getByRole("tab", { name: "Ports" }).click();
  const containerPort = page.getByPlaceholder("Container");
  const hostPort = page.getByPlaceholder("Host");
  const protocol = page.getByRole("combobox");
  await expect(containerPort).toBeVisible();
  await expect(hostPort).toBeVisible();
  await expect(protocol).toBeVisible();

  const [dialogBox, containerBox, hostBox, protocolBox] = await Promise.all([
    dialog.boundingBox(),
    containerPort.boundingBox(),
    hostPort.boundingBox(),
    protocol.boundingBox(),
  ]);
  expect(dialogBox).not.toBeNull();
  expect(containerBox).not.toBeNull();
  expect(hostBox).not.toBeNull();
  expect(protocolBox).not.toBeNull();
  expect(containerBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
  expect(hostBox!.x + hostBox!.width).toBeLessThanOrEqual(
    dialogBox!.x + dialogBox!.width,
  );
  expect(protocolBox!.y).toBeGreaterThan(containerBox!.y);
  expect(protocolBox!.x + protocolBox!.width).toBeLessThanOrEqual(
    dialogBox!.x + dialogBox!.width,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await protocol.click();
  await page.getByRole("option", { name: "UDP" }).click();
  const createButton = page.getByRole("button", { name: "Create Environment" });
  await expect(createButton).toBeVisible();
  await createButton.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.lastCreateEnvironmentOptions?.portMappings[0]?.protocol,
      ),
    )
    .toBe("udp");
});

test("desktop hides the mobile tablist while exposing every configuration section", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/");

  const tabList = page.getByRole("tablist", {
    name: "Environment configuration sections",
  });
  const environmentName = page.getByLabel("Environment Name (optional)");
  const restrictedAccess = page.getByRole("button", { name: "Restricted" });
  const launchAgent = page.getByRole("switch", { name: "Launch Agent" });
  const prompt = page.getByLabel("Initial Prompt (optional)");
  const containerPort = page.getByPlaceholder("Container");

  await expect(tabList).toBeHidden();
  await expect(environmentName).toBeVisible();
  await expect(restrictedAccess).toBeVisible();
  await expect(launchAgent).toBeVisible();
  await expect(prompt).toBeVisible();
  await expect(containerPort).toBeVisible();

  const setupPanel = panelContaining(page, environmentName);
  const accessPanel = panelContaining(page, restrictedAccess);
  const agentPanel = panelContaining(page, launchAgent);
  const promptPanel = panelContaining(page, prompt);
  await expect(setupPanel).toHaveCSS("display", "contents");
  await expect(accessPanel).toHaveCSS("display", "contents");
  await expect(agentPanel).toHaveCSS("display", "contents");
  await expect(promptPanel).toHaveCSS("display", "block");

  const [nameBox, accessBox] = await Promise.all([
    environmentName.boundingBox(),
    restrictedAccess.boundingBox(),
  ]);
  expect(nameBox).not.toBeNull();
  expect(accessBox).not.toBeNull();
  expect(nameBox!.x).toBeLessThan(accessBox!.x);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tabList).toBeVisible();
  await page.getByRole("tab", { name: "Setup" }).click();
  await expect(setupPanel).toHaveCSS(
    "animation-name",
    "create-environment-tab-enter-forward",
  );

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(tabList).toBeHidden();
  await expect(setupPanel).toHaveCSS("display", "contents");
  await expect(setupPanel).toHaveCSS("animation-name", "none");
});
