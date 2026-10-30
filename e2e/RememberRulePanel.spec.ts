/**
 * The card's "Approve and remember…" panel (todo 0723, task 5) on Codex
 * approvals, rendered in a real browser at phone and desktop widths.
 *
 * The cards come from the payloads codex-bridge forwards, read by the real
 * backend Codex reader and the protocol's offer builder
 * (`fixture/RememberRulePanelFixture.tsx`). No provider runs; the billed card
 * run in the app is still recorded as open in the todo.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

async function openPanel(page: Page, id: string): Promise<Locator> {
  const card = page.getByTestId(`card-${id}`);
  await card.getByRole("button", { name: "Approve and remember…" }).click();
  const panel = card.getByTestId("remember-rule-panel");
  await expect(panel).toBeVisible();
  return panel;
}

async function patterns(panel: Locator) {
  return panel.locator("label:has(input[type=radio])").evaluateAll((labels) =>
    labels.map((label) => ({
      pattern: label.querySelector("code")?.textContent ?? "",
      checked: (label.querySelector("input") as HTMLInputElement).checked,
    })),
  );
}

async function fitsViewport(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/remember-rule-panel");
  await expect(page.getByTestId("card-codex-touch")).toBeVisible();
});

test("the live Codex command shape offers the unwrapped command and saves the chosen rule", async ({
  page,
}) => {
  const panel = await openPanel(page, "codex-touch");
  // `/bin/zsh -lc '…'` is unwrapped: the rule is about the command inside.
  expect(await patterns(panel)).toEqual([
    { pattern: "touch policy-amendment-probe.txt", checked: true },
  ]);
  await expect(panel).toContainText("(narrowest)");
  await expect(panel).toContainText("Nothing is saved in Codex's own settings");
  await expect(panel).toContainText("Commands with shell operators always ask.");
  expect(await fitsViewport(page)).toBe(true);
  await page
    .getByTestId("card-codex-touch")
    .screenshot({ path: test.info().outputPath("codex-touch-panel.png") });

  await panel.getByRole("button", { name: "Approve and remember", exact: true }).click();
  await expect(page.getByTestId("saved-codex-touch")).toHaveText(
    JSON.stringify({
      pattern: "touch policy-amendment-probe.txt",
      scope: "project",
      anyProvider: false,
    }),
  );
  await expect(panel).toBeHidden();
});

test("Codex's proposed prefix is preselected among the offered prefixes, narrowest first", async ({
  page,
}) => {
  const panel = await openPanel(page, "codex-bun-test");
  const offered = await patterns(panel);
  expect(offered[0]?.pattern).toBe("bun test apps/web/src/components/native-agent --timeout 20000");
  expect(offered.at(-1)?.pattern).toBe("bun test");
  expect(offered.filter((entry) => entry.checked).map((entry) => entry.pattern)).toEqual([
    "bun test",
  ]);
  expect(await fitsViewport(page)).toBe(true);
  await page
    .getByTestId("card-codex-bun-test")
    .screenshot({ path: test.info().outputPath("codex-prefix-panel.png") });

  await panel.getByRole("radio").first().check();
  await panel.getByRole("button", { name: "This environment" }).click();
  await panel.getByRole("button", { name: "30 days" }).click();
  await panel.getByLabel("Also answer for other agents").click();
  await panel.getByRole("button", { name: "Approve and remember", exact: true }).click();
  expect(JSON.parse((await page.getByTestId("saved-codex-bun-test").textContent()) ?? "")).toEqual({
    pattern: "bun test apps/web/src/components/native-agent --timeout 20000",
    scope: "environment",
    anyProvider: true,
    expiresInMs: 30 * 24 * 60 * 60 * 1_000,
  });
});

test("a Codex file change offers the workspace-relative file and its parent folders", async ({
  page,
}) => {
  const panel = await openPanel(page, "codex-edit");
  const offered = await patterns(panel);
  expect(offered[0]).toEqual({
    pattern: "apps/web/src/components/native-agent/RememberRulePanel.tsx",
    checked: true,
  });
  expect(offered.length).toBeGreaterThan(1);
  expect(await fitsViewport(page)).toBe(true);
  await page
    .getByTestId("card-codex-edit")
    .screenshot({ path: test.info().outputPath("codex-file-panel.png") });
});

test("a piped Codex command explains why it can't be remembered and saves nothing", async ({
  page,
}) => {
  const panel = await openPanel(page, "codex-pipe");
  await expect(panel).toContainText("can't be remembered");
  await expect(
    panel.getByRole("button", { name: "Approve and remember", exact: true }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("saved-codex-pipe")).toHaveCount(0);
});
