import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.describe("When verified", () => {
  test("the launcher's Pull request card opens on the default and submits a change", async ({
    page,
  }) => {
    await page.goto("/delivery-policy?launch");
    const card = page.locator('[data-build-step="pr"]');
    const select = card.getByRole("combobox", { name: "When verified" });
    await expect(select).toHaveValue("open-pr");
    await expect(select.locator("option")).toHaveText(["Open a PR, don't merge", "Push, no PR"]);

    await select.selectOption("push-no-pr");
    await expect(card).toContainText("No pull request is opened.");
    await page.getByRole("button", { name: "Start build" }).click();
    await expect(page.getByTestId("confirmed-policy")).toHaveText("push-no-pr");
  });

  test("the launcher offers the machines holding the project and submits the pick", async ({
    page,
  }) => {
    await page.goto("/delivery-policy?launch&machines");
    const machines = page.getByRole("radiogroup", { name: "Machine" });
    await expect(machines.getByRole("radio", { name: /Studio Mac/ })).toBeChecked();
    await expect(machines.getByRole("radio", { name: /Laptop/ })).toBeDisabled();
    await mkdir(path.join(process.cwd(), "output/visual-previews"), { recursive: true });
    await page.screenshot({
      path: path.join(process.cwd(), "output/visual-previews/build-machine-choice.png"),
    });

    // The radio is visually hidden; the user picks through its card.
    await machines.getByText("Builder").click();
    await expect(machines.getByRole("radio", { name: /Builder/ })).toBeChecked();
    await page.getByRole("button", { name: "Start build" }).click();
    await expect(page.getByTestId("confirmed-machine")).toHaveText("Builder");
  });

  test("the launcher offers no Local build on a machine without a checkout", async ({ page }) => {
    await page.goto("/delivery-policy?launch&machines&remote-only");
    const machines = page.getByRole("radiogroup", { name: "Machine" });
    await machines.getByText("Builder").click();
    const where = page.getByRole("radiogroup", { name: "Where it runs" });
    await expect(where.getByRole("radio", { name: /^Local/ })).toBeDisabled();
    await expect(where.getByText("No project checkout on Builder")).toBeVisible();
    // The fixture cannot reach Builder's Docker either, so nothing can start.
    await expect(where.getByRole("radio", { name: /^Container/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Start build" })).toBeDisabled();
    await mkdir(path.join(process.cwd(), "output/visual-previews"), { recursive: true });
    await page.screenshot({
      path: path.join(
        process.cwd(),
        `output/visual-previews/build-machine-remote-only-${test.info().project.name}.png`,
      ),
    });
  });

  test("the launcher has no machine choice for a single machine", async ({ page }) => {
    await page.goto("/delivery-policy?launch");
    await expect(page.getByRole("radiogroup", { name: "Machine" })).toHaveCount(0);
  });

  test("a commit-only ticket keeps its selection in the launcher", async ({ page }) => {
    await page.goto("/delivery-policy?launch&policy=commit-only");
    const select = page
      .locator('[data-build-step="pr"]')
      .getByRole("combobox", { name: "When verified" });
    await expect(select).toHaveValue("commit-only");
    await expect(select.locator("option")).toContainText(["Commit, don't push"]);
  });

  test("the Delivery tile always shows, and changes the ticket", async ({ page }) => {
    await page.goto("/delivery-policy");
    const tile = page.getByTestId("ticket-tile-delivery");
    const select = tile.getByRole("combobox", { name: "When verified" });
    await expect(select).toHaveValue("open-pr");
    await select.selectOption("push-no-pr");
    await expect(select).toHaveValue("push-no-pr");
    await expect(tile).toContainText("Mail the coordinator when pushed.");
  });

  test("the Delivery tile says when a change came too late", async ({ page }) => {
    await page.goto("/delivery-policy?policy=open-pr&decided=open-pr");
    const tile = page.getByTestId("ticket-tile-delivery");
    await expect(page.getByTestId("ticket-delivery-too-late")).toHaveCount(0);

    await tile.getByRole("combobox", { name: "When verified" }).selectOption("push-no-pr");

    await expect(page.getByTestId("ticket-delivery-too-late")).toContainText(
      "Too late for this build",
    );
  });

  test("a finished push reads as a success with no pull request", async ({ page }) => {
    await page.goto("/pipeline-flow?delivered=push-no-pr");
    const graph = page.getByRole("tablist", { name: "Build pipeline" });
    const outcome = graph.getByRole("tab", { name: /^No PR,/ });
    await expect(outcome).toContainText("Branch pushed, no PR opened");
    await expect(graph.getByRole("tab", { name: /^Push,/ })).toBeVisible();
    await expect(page.getByTestId("build-pipeline-header-summary")).toContainText(
      "branch pushed, no PR opened",
    );
    await outcome.click();
    await expect(page.getByTestId("pipeline-delivery-outcome")).toContainText(
      "The branch was pushed and no pull request was opened.",
    );
  });

  test("kept commits read as a success with no Ship step", async ({ page }) => {
    await page.goto("/pipeline-flow?delivered=commit-only");
    const graph = page.getByRole("tablist", { name: "Build pipeline" });
    const outcome = graph.getByRole("tab", { name: /^No PR,/ });
    await expect(outcome).toContainText("Commits kept in the environment");
    await expect(graph.getByRole("tab", { name: /^Ship/ })).toHaveCount(0);
    await outcome.click();
    await expect(page.getByTestId("pipeline-delivery-outcome")).toContainText(
      "The commits were kept in the environment",
    );
  });
});

test("feature model cards match delivery policy at both viewport sizes", async ({
  page,
}, testInfo) => {
  await page.goto("/delivery-policy?feature&policy=push-no-pr");
  await expect(page.getByText("Pushes the branch. No pull request is opened.")).toBeVisible();
  const previewDir = path.resolve("output/visual-previews");
  await mkdir(previewDir, { recursive: true });
  await page.screenshot({
    path: path.join(previewDir, `feature-push-only-${testInfo.project.name}.png`),
    fullPage: true,
  });
  await page
    .getByText("Pushes the branch. No pull request is opened.")
    .locator("../../..")
    .screenshot({
      path: path.join(previewDir, `feature-push-step-${testInfo.project.name}.png`),
    });
  await page.getByRole("combobox", { name: "When verified" }).selectOption("open-pr");
  await expect(page.getByText("Pushes the branch and opens the pull request.")).toBeVisible();
});

test("completed delivery does not mark the next policy edit too late", async ({ page }) => {
  await page.goto("/delivery-policy?complete&policy=open-pr&decided=open-pr");
  await page.getByRole("combobox", { name: "When verified" }).selectOption("push-no-pr");
  await expect(page.getByTestId("ticket-delivery-too-late")).toHaveCount(0);
});
