import { expect, test, type Locator, type Page } from "@playwright/test";

function panelContaining(page: Page, child: Locator): Locator {
  return page.locator('[data-slot="tabs-content"]').filter({ has: child });
}

const ENABLED_PLATFORMS = ["claude", "codex", "opencode"] as const;

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function expectPromptFieldLayout(page: Page, layout: "stacked" | "grid") {
  const field = page.locator('[data-slot="initial-prompt-field"]');
  const label = page.locator('label[for="initial-prompt"]');
  const prompt = page.getByLabel("Initial Prompt (optional)");
  const optional = label.locator(".sr-only");

  await expect(field).toBeVisible();
  await expect(label).toHaveText(/Initial Prompt/);
  await expect(optional).toHaveText("(optional)");
  await expect(optional).toHaveCSS("position", "absolute");
  await expect(optional).toHaveCSS("width", "1px");
  await expect(optional).toHaveCSS("height", "1px");
  await expect(optional).toHaveCSS("overflow", "hidden");
  await expect(prompt).not.toHaveAttribute("aria-label");

  const [labelBox, promptBox] = await Promise.all([label.boundingBox(), prompt.boundingBox()]);
  expect(labelBox).not.toBeNull();
  expect(promptBox).not.toBeNull();

  if (layout === "stacked") {
    await expect(field).toHaveCSS("display", "block");
    expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(promptBox!.y);
    expect(Math.abs(labelBox!.x - promptBox!.x)).toBeLessThanOrEqual(1);
    return;
  }

  await expect(field).toHaveCSS("display", "grid");
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(promptBox!.x);
  expect(labelBox!.y).toBeGreaterThanOrEqual(promptBox!.y);
  expect(labelBox!.y).toBeLessThan(promptBox!.y + promptBox!.height);
}

/**
 * The agent, model and reasoning choices are one `AgentModelPicker` trigger, so
 * the row can no longer overlap itself. What is still worth pinning is that the
 * trigger stays inside the dialog and that its menu — which asks for 46rem on a
 * wide viewport — stays inside a narrow one.
 */
async function expectAgentPickerFitsAt(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });

  const dialog = page.getByRole("dialog");
  const picker = page.locator("#agent-model");
  await expect(picker).toBeVisible();

  const [dialogBox, pickerBox] = await Promise.all([dialog.boundingBox(), picker.boundingBox()]);
  expect(dialogBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
  await expectNoHorizontalOverflow(page);

  await picker.click();
  const menu = page.locator("[data-native-model-picker]");
  await expect(menu).toBeVisible();

  // Agent choice moved onto the picker's platform rail, so every enabled
  // platform must still be reachable from here.
  for (const platform of ENABLED_PLATFORMS) {
    await expect(menu.getByRole("button", { name: `${platform} models` })).toBeVisible();
  }
  await expect(menu.locator("[data-native-model-list]")).toBeVisible();

  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width);
  await expectNoHorizontalOverflow(page);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
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
  const accessPanel = panelContaining(page, page.getByRole("button", { name: "Restricted" }));

  await expect(dialog).toBeVisible();
  await expect(tabList).toBeVisible();
  await expect(promptPanel).toBeVisible();
  await expect(setupPanel).toBeHidden();
  await expect(accessPanel).toBeHidden();
  await expectPromptFieldLayout(page, "stacked");

  await page.getByRole("tab", { name: "Setup" }).click();
  await expect(setupPanel).toBeVisible();
  await expect(promptPanel).toBeHidden();
  await expect(setupPanel).toHaveAttribute("data-mobile-transition", "forward");
  await expect(setupPanel).toHaveCSS("animation-name", "create-environment-tab-enter-forward");
  await expect(setupPanel).toHaveCSS("animation-duration", "0.18s");
  await environmentName.fill("mobile-layout");

  await page.getByRole("tab", { name: "Prompt" }).click();
  await expect(promptPanel).toHaveAttribute("data-mobile-transition", "backward");
  await expect(promptPanel).toHaveCSS("animation-name", "create-environment-tab-enter-backward");
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
  expect(hostBox!.x + hostBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
  expect(protocolBox!.y).toBeGreaterThan(containerBox!.y);
  expect(protocolBox!.x + protocolBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await protocol.click();
  await page.getByRole("option", { name: "UDP" }).click();
  const createButton = page.getByRole("button", { name: "Create Environment" });
  await expect(createButton).toBeVisible();
  await createButton.click();
  await expect
    .poll(() => page.evaluate(() => window.lastCreateEnvironmentOptions?.portMappings[0]?.protocol))
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
  const launchAgent = page.getByRole("checkbox", { name: "Launch Agent" });
  const prompt = page.getByLabel("Initial Prompt (optional)");
  const containerPort = page.getByPlaceholder("Container");

  await expect(tabList).toBeHidden();
  await expect(environmentName).toBeVisible();
  await expect(restrictedAccess).toBeVisible();
  await expect(launchAgent).toBeVisible();
  await expect(prompt).toBeVisible();
  await expect(containerPort).toBeVisible();
  await expectPromptFieldLayout(page, "grid");

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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tabList).toBeVisible();
  await page.getByRole("tab", { name: "Setup" }).click();
  await expect(setupPanel).toHaveCSS("animation-name", "create-environment-tab-enter-forward");

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(tabList).toBeHidden();
  await expect(setupPanel).toHaveCSS("display", "contents");
  await expect(setupPanel).toHaveCSS("animation-name", "none");
});

test("desktop keeps the unified agent picker and its menu inside a narrow viewport", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/");

  await expectAgentPickerFitsAt(page, 700);
  await expectAgentPickerFitsAt(page, 640);
});

test("desktop lays the picker's model and reasoning columns out side by side", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop project only");
  await page.goto("/");
  await page.setViewportSize({ width: 1024, height: 900 });

  const picker = page.locator("#agent-model");
  await picker.click();
  const menu = page.locator("[data-native-model-picker]");
  await expect(menu).toBeVisible();

  const models = menu.getByRole("group", { name: "Models" });
  // Claude's default catalog entry carries reasoning efforts, so the column is
  // present on first open; it is hidden only for a model that supports none.
  const reasoning = menu.getByRole("group", { name: "Reasoning" });
  await expect(models).toBeVisible();
  await expect(reasoning).toBeVisible();

  const [menuBox, modelsBox, reasoningBox] = await Promise.all([
    menu.boundingBox(),
    models.boundingBox(),
    reasoning.boundingBox(),
  ]);
  expect(menuBox).not.toBeNull();
  expect(modelsBox).not.toBeNull();
  expect(reasoningBox).not.toBeNull();
  expect(modelsBox!.x + modelsBox!.width).toBeLessThanOrEqual(reasoningBox!.x);
  expect(reasoningBox!.x + reasoningBox!.width).toBeLessThanOrEqual(menuBox!.x + menuBox!.width);
  await expectNoHorizontalOverflow(page);
});

async function showSection(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true });
  if (await tab.isVisible()) await tab.click();
}

async function trackCreations(page: Page) {
  await page.evaluate(() => {
    let count = 0;
    Object.defineProperty(window, "lastCreateEnvironmentOptions", {
      configurable: true,
      set: () => {
        count++;
      },
      get: () => count,
    });
  });
}

async function creationCount(page: Page) {
  return page.evaluate(() => window.lastCreateEnvironmentOptions);
}

test("native Enter inserts a newline and never implicitly submits name or ports", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await trackCreations(page);
  await showSection(page, "Prompt");
  const prompt = page.getByLabel("Initial Prompt (optional)");
  await prompt.fill("first line");
  await prompt.press("End");
  await prompt.press("Enter");
  await prompt.press("x");
  await expect(prompt).toHaveValue("first line\nx");
  await page.screenshot({
    path: `output/visual-previews/shortcut-newline-${testInfo.project.name}.png`,
  });
  await showSection(page, "Setup");
  await page.getByLabel("Environment Name (optional)").press("Enter");
  await showSection(page, "Ports");
  if (!(await page.getByPlaceholder("Host", { exact: true }).isVisible())) {
    await page.getByRole("button", { name: /Port Configuration/ }).click();
  }
  await page.getByPlaceholder("Container", { exact: true }).press("Enter");
  await page.getByPlaceholder("Host", { exact: true }).press("Enter");
  expect(await creationCount(page)).toBe(0);
  await expect(page.getByRole("dialog")).toBeVisible();
});

for (const chord of ["Meta+Enter", "Control+Enter"]) {
  test(`${chord} submits exactly once from fields, controls and portaled search`, async ({
    page,
  }) => {
    for (const target of [
      "prompt",
      "name",
      "port",
      "checkbox",
      "protocol",
      "cancel",
      "create",
      "search",
    ]) {
      await page.goto("/");
      await trackCreations(page);
      let control: Locator;
      if (target === "prompt") {
        await showSection(page, "Prompt");
        control = page.getByLabel("Initial Prompt (optional)");
      } else if (target === "name") {
        await showSection(page, "Setup");
        control = page.getByLabel("Environment Name (optional)");
      } else if (target === "port" || target === "protocol") {
        await showSection(page, "Ports");
        if (!(await page.getByPlaceholder("Host", { exact: true }).isVisible())) {
          await page.getByRole("button", { name: /Port Configuration/ }).click();
        }
        control =
          target === "port"
            ? page.getByPlaceholder("Host", { exact: true })
            : page.getByRole("combobox", { name: "Protocol" });
      } else if (target === "checkbox" || target === "search") {
        await showSection(page, "Agent");
        if (target === "search") {
          await page.locator("#agent-model").click();
          control = page.getByPlaceholder("Search models...");
        } else {
          control = page.getByRole("checkbox", { name: "Launch Agent" });
        }
      } else {
        control = page.getByRole("button", {
          name: target === "cancel" ? "Cancel" : "Create Environment",
          exact: true,
        });
      }
      await control.focus();
      await control.press(chord);
      await expect.poll(() => creationCount(page), { message: `${chord} on ${target}` }).toBe(1);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("listbox")).toHaveCount(0);
    }
  });
}
