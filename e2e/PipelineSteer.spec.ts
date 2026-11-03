import { expect, test, type Page } from "@playwright/test";

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Send a message to the agent", exact: true });
}

async function sendMessage(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

function commands(page: Page, command: string) {
  return page.evaluate(
    (name) => window.__pipelineCommands!.filter((entry) => entry.command === name),
    command,
  );
}

test("with Auto-steer off a message waits in the queue until Steer is clicked", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=building");
  await sendMessage(page, "Use the existing helper instead");

  const strip = page.getByTestId("compose-queue-strip");
  await expect(strip).toContainText("1 queued");
  await expect(strip).toContainText("Use the existing helper instead");
  await expect(composer(page)).toHaveValue("");
  expect(await commands(page, "steer_queued_build_pipeline_message")).toHaveLength(0);

  await strip.getByRole("button", { name: /^Steer queued prompt 1 of 1/ }).click();

  await expect(strip).toHaveCount(0);
  expect(await commands(page, "steer_queued_build_pipeline_message")).toHaveLength(1);
});

test("a queued message comes back after a reload with its Steer button", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=building");
  await sendMessage(page, "Use the existing helper instead");
  await expect(page.getByTestId("compose-queue-strip")).toContainText("1 queued");

  await page.goto("/pipeline-flow?scenario=building&restore=1&view=build");

  const strip = page.getByTestId("compose-queue-strip");
  await expect(strip).toContainText("Use the existing helper instead");
  await expect(strip.getByRole("button", { name: /^Steer queued prompt 1 of 1/ })).toBeVisible();
});

test("with Auto-steer on a message goes straight into the running turn", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=building&autoSteer=1");
  await composer(page).fill("Use the existing helper instead");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveAttribute(
    "title",
    /^Steer the current .* turn$/,
  );
  await composer(page).press("Enter");

  await expect(composer(page)).toHaveValue("");
  await expect.poll(() => commands(page, "steer_queued_build_pipeline_message")).toHaveLength(1);
  await expect(page.getByTestId("compose-queue-strip")).toHaveCount(0);
});

test("with Auto-steer on a refused steer leaves the message queued", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=building&autoSteer=1&steer=refused");
  await sendMessage(page, "Use the existing helper instead");

  const strip = page.getByTestId("compose-queue-strip");
  await expect(strip).toContainText("Use the existing helper instead");
  await expect(strip.getByRole("button", { name: /^Steer queued prompt 1 of 1/ })).toBeVisible();
  await expect(composer(page)).toHaveValue("");
});

test("a queued message can be edited back into the box or removed", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=building");
  await sendMessage(page, "First thought");
  await sendMessage(page, "Second thought");
  const strip = page.getByTestId("compose-queue-strip");
  await expect(strip).toContainText("2 queued");

  await strip.getByRole("button", { name: "Remove queued prompt 2 of 2" }).click();
  await expect(strip).toContainText("1 queued");
  await strip.getByRole("button", { name: "Edit queued prompt 1 of 1" }).click();

  await expect(composer(page)).toHaveValue("First thought");
  await expect(strip).toHaveCount(0);
});
