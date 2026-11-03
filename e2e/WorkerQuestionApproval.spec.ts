import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";

async function openDialog(page: Page, route = "/worker-question-approval") {
  await page.goto(route);
  const dialog = page.getByTestId("worker-question-request");
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  return dialog;
}

const option = (dialog: Locator, label: string) =>
  dialog.getByRole("button", { name: new RegExp(`^${label}`) });

async function decision(page: Page) {
  return JSON.parse((await page.getByTestId("decision").textContent()) ?? "null");
}

test("shows the worker, the question and the coordinator's proposal inside the viewport", async ({
  page,
}, testInfo) => {
  const dialog = await openDialog(page);
  const viewport = page.viewportSize()!;
  await expect(
    dialog.getByRole("heading", { name: "Answer the question in “Claude 1” of “auth-fix”?" }),
  ).toBeVisible();
  await expect(dialog).toContainText("nothing is sent to the worker unless you approve");
  await expect(dialog).toContainText("Its reason: “The ticket says Postgres.”");
  const group = dialog.getByRole("group", { name: "Database choice" });
  await expect(group).toContainText("Coordinator's proposal");
  await expect(group.getByTestId("worker-question")).toHaveCount(3);

  // The proposal is preselected and marked; nothing else is.
  await expect(option(dialog, "Postgres")).toHaveAttribute("aria-pressed", "true");
  await expect(option(dialog, "SQLite")).toHaveAttribute("aria-pressed", "false");
  await expect(option(dialog, "Cache")).toHaveAttribute("aria-pressed", "true");
  await expect(option(dialog, "Search")).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByText("proposed", { exact: true })).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "Approve and send" })).toBeEnabled();

  // The dialog fits the viewport, and nothing inside it scrolls sideways.
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  expect(await group.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  // Options of one question stack at the same full width, one under another.
  const postgres = (await option(dialog, "Postgres").boundingBox())!;
  const sqlite = (await option(dialog, "SQLite").boundingBox())!;
  expect(sqlite.width).toBeCloseTo(postgres.width, 0);
  expect(sqlite.x).toBeCloseTo(postgres.x, 0);
  expect(sqlite.y).toBeGreaterThanOrEqual(postgres.y + postgres.height);

  // The "proposed" tag sits on the option's first line, right of its label.
  const label = (await option(dialog, "Postgres")
    .getByText("Postgres", { exact: true })
    .boundingBox())!;
  const tag = (await option(dialog, "Postgres")
    .getByText("proposed", { exact: true })
    .boundingBox())!;
  expect(tag.x).toBeGreaterThan(label.x + label.width);
  expect(tag.x + tag.width).toBeLessThanOrEqual(postgres.x + postgres.width);
  expect(Math.abs(tag.y - label.y)).toBeLessThan(label.height);

  // Decline and Approve sit below the questions, inside the dialog.
  const approve = (await dialog.getByRole("button", { name: "Approve and send" }).boundingBox())!;
  const decline = (await dialog.getByRole("button", { name: "Decline" }).boundingBox())!;
  const groupBounds = (await group.boundingBox())!;
  for (const button of [approve, decline]) {
    expect(button.y).toBeGreaterThanOrEqual(groupBounds.y + groupBounds.height);
    expect(button.x + button.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }

  await page.screenshot({
    path: path.resolve(
      "output/visual-previews",
      `worker-question-approval-${testInfo.project.name}.png`,
    ),
  });

  // Escape does not dismiss it: only Decline or Approve settles the request.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(await decision(page)).toBeNull();
});

test("an edited answer is the one approved", async ({ page }, testInfo) => {
  const dialog = await openDialog(page);
  const group = dialog.getByRole("group", { name: "Database choice" });

  await option(dialog, "SQLite").click();
  await expect(option(dialog, "SQLite")).toHaveAttribute("aria-pressed", "true");
  await expect(option(dialog, "Postgres")).toHaveAttribute("aria-pressed", "false");
  // Toggle the multiple-choice extra from the keyboard.
  await option(dialog, "Search").focus();
  await page.keyboard.press("Space");
  await expect(option(dialog, "Search")).toHaveAttribute("aria-pressed", "true");
  await expect(option(dialog, "Cache")).toHaveAttribute("aria-pressed", "true");
  await dialog
    .getByRole("textbox", { name: "Answer: Anything else the worker should know?" })
    .fill("Use the staging credentials.");
  await expect(group).toContainText("Edited by you");
  await expect(group).not.toContainText("Coordinator's proposal");

  await page.screenshot({
    path: path.resolve(
      "output/visual-previews",
      `worker-question-approval-edited-${testInfo.project.name}.png`,
    ),
  });

  await dialog.getByRole("button", { name: "Approve and send" }).click();
  await expect
    .poll(() => decision(page))
    .toEqual({
      requestId: "worker-question-fixture",
      decision: "approve",
      approval: {
        answers: [
          { questionId: "db", optionIds: ["sqlite"] },
          { questionId: "extras", optionIds: ["cache", "search"] },
          { questionId: "notes", freeText: "Use the staging credentials." },
        ],
      },
    });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Answered.")).toBeVisible();
});

test("a written answer replaces the single choice, and an empty required answer blocks approval", async ({
  page,
}) => {
  const dialog = await openDialog(page);
  const other = dialog.getByRole("textbox", {
    name: /^Other answer: Which database should the service use/,
  });
  const approve = dialog.getByRole("button", { name: "Approve and send" });

  await other.fill("MySQL, as the platform team runs it");
  await expect(option(dialog, "Postgres")).toHaveAttribute("aria-pressed", "false");
  await expect(approve).toBeEnabled();

  await other.fill("");
  await expect(dialog.getByText("Question db needs an answer.")).toBeVisible();
  await expect(approve).toBeDisabled();

  await other.fill("MySQL, as the platform team runs it");
  await approve.click();
  await expect
    .poll(() => decision(page))
    .toEqual({
      requestId: "worker-question-fixture",
      decision: "approve",
      approval: {
        answers: [
          { questionId: "db", freeText: "MySQL, as the platform team runs it" },
          { questionId: "extras", optionIds: ["cache"] },
        ],
      },
    });
});

test("a long question list scrolls while the heading and actions stay in view", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const dialog = await openDialog(page, "/worker-question-approval?many");
  const group = dialog.getByRole("group", { name: "Database choice" });
  const heading = dialog.getByRole("heading", { name: /^Answer the question/ });
  const approve = dialog.getByRole("button", { name: "Approve and send" });
  const decline = dialog.getByRole("button", { name: "Decline" });

  expect(await group.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const controls = [heading, approve, decline];
  for (const control of controls) await expect(control).toBeInViewport({ ratio: 1 });
  const before = await Promise.all(controls.map((control) => control.boundingBox()));
  await group.evaluate((element) => (element.scrollTop = element.scrollHeight));
  expect(await group.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  for (const [index, control] of controls.entries()) {
    await expect(control).toBeInViewport({ ratio: 1 });
    const after = (await control.boundingBox())!;
    expect(after.y).toBeCloseTo(before[index]!.y, 0);
  }
  await page.screenshot({
    path: path.resolve(
      "output/visual-previews",
      `worker-question-approval-many-${testInfo.project.name}.png`,
    ),
  });

  await decline.click();
  await expect
    .poll(() => decision(page))
    .toEqual({
      requestId: "worker-question-fixture",
      decision: "reject",
    });
  await expect(dialog).toHaveCount(0);
});
