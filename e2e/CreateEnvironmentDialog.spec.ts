import { expect, test, type Locator, type Page } from "@playwright/test";

function panelContaining(page: Page, child: Locator): Locator {
  return page.locator('[data-slot="tabs-content"]').filter({ has: child });
}

async function expectCompactAgentConfigurationAt(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });

  const dialog = page.getByRole("dialog");
  const agentGroup = page.getByRole("radiogroup", { name: "Default Agent" });
  const agentButtons = agentGroup.getByRole("radio");
  const model = page.locator("#agent-model");
  const reasoningEffort = page.locator("#agent-reasoning-effort");
  const [dialogBox, agentBox, modelBox, reasoningBox, buttonBoxes] = await Promise.all([
    dialog.boundingBox(),
    agentGroup.boundingBox(),
    model.boundingBox(),
    reasoningEffort.boundingBox(),
    agentButtons.evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { width: box.width };
      }),
    ),
  ]);

  expect(dialogBox).not.toBeNull();
  expect(agentBox).not.toBeNull();
  expect(modelBox).not.toBeNull();
  expect(reasoningBox).not.toBeNull();
  expect(buttonBoxes).toHaveLength(3);

  const buttonWidth = buttonBoxes.reduce((total, button) => total + button.width, 0);
  // Three 2rem buttons plus the control's gaps, padding, and border should fit
  // tightly. The former stretched 10rem control is intentionally too wide.
  expect(agentBox!.width).toBeGreaterThanOrEqual(buttonWidth);
  expect(agentBox!.width).toBeLessThanOrEqual(buttonWidth + 20);
  expect(agentBox!.x + agentBox!.width).toBeLessThanOrEqual(modelBox!.x);
  expect(modelBox!.x + modelBox!.width).toBeLessThanOrEqual(reasoningBox!.x);
  expect(reasoningBox!.x + reasoningBox!.width).toBeLessThanOrEqual(
    dialogBox!.x + dialogBox!.width,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
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

test("desktop shrink-wraps the agent selector without overlapping adjacent controls", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/");

  await expectCompactAgentConfigurationAt(page, 700);
  await expectCompactAgentConfigurationAt(page, 640);
});
