import { expect, test, type Page } from "@playwright/test";

const rows = (page: Page) =>
  page
    .getByTestId("federated-environment-row")
    .locator("[role=button][aria-label*=', on Remote,']");
async function expectRows(page: Page, ids: string[]) {
  await expect(rows(page)).toHaveText(ids);
}
async function drag(page: Page, from: string, to: string) {
  const handle = page.getByRole("button", { name: `Reorder ${from}`, exact: true });
  const target = page.getByRole("button", { name: `Reorder ${to}`, exact: true });
  const start = (await handle.boundingBox())!;
  const end = (await target.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 10, start.y + start.height / 2, { steps: 3 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 });
  await page.mouse.up();
  // PointerSensor suppresses document clicks for 50ms after release. Let its
  // cleanup finish before a fixture control answers the deferred owner write.
  await page.waitForTimeout(60);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/remote-machine-tree");
  await expectRows(page, ["a", "b", "c", "d"]);
});

test("drag optimistically reorders within a project, preserves home slots, and reconciles with the summary", async ({
  page,
}) => {
  await drag(page, "a", "b");
  await expectRows(page, ["b", "a", "c", "d"]);
  await expect(page.getByTestId("calls")).toHaveText('[["b","home","a","c"]]');
  await expect(page.getByTestId("owner")).toHaveText('["a","home","b","c"]');
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByTestId("overlay")).toHaveText("1");
  await page.getByRole("button", { name: "Publish owner", exact: true }).click();
  await expect(page.getByTestId("overlay")).toHaveText("0");
  await expectRows(page, ["b", "a", "c", "d"]);
});

test("cross-project and no-op drops never submit a reorder", async ({ page }) => {
  await drag(page, "a", "d");
  await drag(page, "b", "b");
  await expect(page.getByTestId("calls")).toHaveText("[]");
  await expectRows(page, ["a", "b", "c", "d"]);
});

test("truncated summaries have no drag handles and preserve owner order", async ({ page }) => {
  await page.goto("/remote-machine-tree?truncated=1");
  await expectRows(page, ["a", "b", "c", "d"]);
  await expect(page.getByRole("button", { name: /^Reorder / })).toHaveCount(0);
  await expect(page.getByTestId("calls")).toHaveText("[]");
  await expect(page.getByTestId("owner")).toHaveText('["a","home","b","c"]');
});

for (const outcome of ["Reject", "Unknown"] as const) {
  test(`${outcome} rolls back the drag${outcome === "Unknown" ? " and names the command in the notice" : ""}`, async ({
    page,
  }) => {
    await drag(page, "a", "b");
    await expectRows(page, ["b", "a", "c", "d"]);
    await expect(page.getByTestId("pending")).toHaveText("1");
    await page.getByRole("button", { name: outcome, exact: true }).click();
    await expect(page.getByTestId("pending")).toHaveText("0");
    await expectRows(page, ["a", "b", "c", "d"]);
    await expect(page.getByTestId("overlay")).toHaveText("0");
    if (outcome === "Unknown") {
      await expect(page.getByTestId("unknown-outcomes")).toContainText(
        "Outcome unknown: Reorder environments.",
      );
      await expect(page.getByTestId("unknown-outcomes")).not.toContainText("reorder_environments");
    }
    await expect(page.getByTestId("calls")).toHaveText('[["b","home","a","c"]]');
  });
}

test("a missing summary expires the optimistic display back to the authoritative order", async ({
  page,
}) => {
  await page.clock.install();
  await drag(page, "a", "b");
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByTestId("overlay")).toHaveText("1");
  await expect(page.getByTestId("owner")).toHaveText('["b","home","a","c"]');
  await page.clock.fastForward(10_001);
  await expect(page.getByTestId("overlay")).toHaveText("0");
  await expectRows(page, ["a", "b", "c", "d"]);
});

test("overlapping drops survive unmount and finish with the latest owner and display order", async ({
  page,
}) => {
  await drag(page, "a", "b");
  await expectRows(page, ["b", "a", "c", "d"]);
  await drag(page, "c", "b");
  await expectRows(page, ["c", "b", "a", "d"]);
  await expect(page.getByTestId("calls")).toHaveText('[["b","home","a","c"]]');
  await page.getByRole("button", { name: "Toggle tree" }).click();
  await expect(rows(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByTestId("calls")).toHaveText('[["b","home","a","c"],["c","home","b","a"]]');
  await page.getByRole("button", { name: "Toggle tree" }).click();
  await expectRows(page, ["c", "b", "a", "d"]);
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByTestId("owner")).toHaveText('["c","home","b","a"]');
  await page.getByRole("button", { name: "Publish owner", exact: true }).click();
  await expect(page.getByTestId("overlay")).toHaveText("0");
  await expectRows(page, ["c", "b", "a", "d"]);
});

test("dragging a project writes the new project order to its own machine", async ({ page }) => {
  const projects = page.getByTestId("federated-project");
  await expect(projects).toHaveCount(2);
  // Aim at the expanded project's header, above its environment rows.
  const handle = (await page
    .getByRole("button", { name: "Open q on Remote", exact: true })
    .boundingBox())!;
  const target = (await page
    .getByRole("button", { name: "Open p on Remote", exact: true })
    .boundingBox())!;
  await page.mouse.move(handle.x + 10, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 20, handle.y + handle.height / 2, { steps: 3 });
  await page.mouse.move(target.x + 10, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId("arrangements")).toHaveText(
    '[{"projectIds":["q","p"],"folders":{}}]',
  );
  await expect(projects.first()).toContainText("q");
  await expect(page.getByTestId("calls")).toHaveText("[]");
});

test("row accessibility retains badges and deleting without hover warns about its PR", async ({
  page,
}, testInfo) => {
  await page.goto("/remote-machine-tree?accessible-state=1");
  const row = page.getByRole("button", { name: "b, on Remote, Idle", exact: true });
  await expect(row).toHaveAccessibleDescription(
    /New completed activity.*2 unread agent messages.*Pull request open/,
  );
  expect(await row.ariaSnapshot()).toContain('button "b, on Remote, Idle"');
  const preview = `${process.cwd()}/output/visual-previews`;
  await page.screenshot({ path: `${preview}/review-row-${testInfo.project.name}.png` });
  // Dispatch directly: no pointer movement over the row, hence no prior hover read.
  await row.dispatchEvent("contextmenu", { button: 2 });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "This environment has an associated PR that will remain open.",
  );
  await page.screenshot({ path: `${preview}/review-delete-pr-${testInfo.project.name}.png` });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});
