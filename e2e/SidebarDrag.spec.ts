import { expect, test, type Locator, type Page } from "@playwright/test";

async function holdDrag(page: Page, handle: Locator, target: Locator, targetYFraction = 0.5) {
  const start = (await handle.boundingBox())!;
  const end = (await target.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2, { steps: 3 });
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(end.x + end.width / 2, end.y + end.height * targetYFraction, { steps: 12 });
}

async function drag(page: Page, handle: Locator, target: Locator, targetYFraction = 0.5) {
  await holdDrag(page, handle, target, targetYFraction);
  await page.mouse.up();
}

const project = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^(Self · )?${name} 3$`) });

// Check the rendered positions after transitions settle, while the pointer is
// still down. Persisted order alone cannot detect rows piling up during a drag.
async function expectVerticalShift(row: Locator, top: number, shift: number) {
  await expect
    .poll(async () => Math.abs((await row.boundingBox())!.y - top - shift))
    .toBeLessThan(1);
}

// This window's own sidebar, with no other machine. With one, the sidebar is
// the repository list (design EL01), covered further down and in
// RepositoryEnvironmentList.spec.ts.
test("local project drag keeps expanded folder rows separate before release", async ({ page }) => {
  await page.goto("/sidebar-drag?groups=1");
  // Keep one project expanded so measured blocks include environment rows,
  // while the whole scenario fits both viewport profiles.
  for (const name of ["p2", "q", "q2"]) {
    await page.getByRole("button", { name: `Collapse project ${name}`, exact: true }).click();
  }
  const source = page.locator('[data-project-folder="Source"]');
  const target = page.locator('[data-project-folder="Target"]');
  const sourceHeading = source.getByTitle("Collapse folder Source", { exact: true }).first();
  const targetHeading = target.getByTitle("Collapse folder Target", { exact: true }).first();
  const rows = [
    sourceHeading,
    project(page, "p"),
    project(page, "p2"),
    targetHeading,
    project(page, "q"),
    project(page, "q2"),
  ];
  const before = await Promise.all(rows.map(async (row) => (await row.boundingBox())!.y));
  const active = project(page, "p2");
  const activeBlock = active.locator("xpath=ancestor::div[contains(@class, 'px-2')][1]");
  const activeHeight = (await activeBlock.boundingBox())!.height;
  // Verify the real folder measurement encloses its member nodes.
  const targetBox = (await target.boundingBox())!;
  const lastBox = (await project(page, "q2").boundingBox())!;
  expect(targetBox.y).toBeLessThan(lastBox.y);
  expect(targetBox.y + targetBox.height).toBeGreaterThanOrEqual(lastBox.y + lastBox.height);

  await holdDrag(page, active, targetHeading);
  await expect(page.getByTestId("sidebar-drag-overlay")).toContainText("p2");
  await expect(target.locator(":scope > .relative")).toHaveClass(/border-primary/);
  for (const index of [0, 1, 3, 4, 5]) {
    await expectVerticalShift(rows[index]!, before[index]!, 0);
  }
  // Continue across the entire target folder. Its members must inherit one
  // parent shift, rather than adding a second transform on top of it.
  await project(page, "q2").hover();
  await expect(
    page.locator('[id^="DndLiveRegion"]').filter({ hasText: "over droppable area" }),
  ).toContainText("area q2");
  for (const index of [0, 1]) await expectVerticalShift(rows[index]!, before[index]!, 0);
  for (const index of [3, 4, 5])
    await expectVerticalShift(rows[index]!, before[index]!, -activeHeight);
  await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
  await page.keyboard.press("Escape");
  for (const [index, row] of rows.entries()) await expectVerticalShift(row, before[index]!, 0);
  await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
});

for (const collapsed of [false, true]) {
  test(`local folder drag shifts ${collapsed ? "collapsed" : "expanded"} target as one block before release`, async ({
    page,
  }) => {
    await page.goto("/sidebar-drag?groups=1");
    for (const name of ["p2", "q", "q2"]) {
      await page.getByRole("button", { name: `Collapse project ${name}`, exact: true }).click();
    }
    const source = page.locator('[data-project-folder="Source"]');
    const target = page.locator('[data-project-folder="Target"]');
    if (collapsed)
      await target.getByRole("button", { name: "Collapse folder Target", exact: true }).click();
    const sourceHeading = source.getByTitle("Collapse folder Source", { exact: true }).first();
    const targetHeading = target
      .getByTitle(`${collapsed ? "Expand" : "Collapse"} folder Target`, { exact: true })
      .first();
    const sourceBox = (await source.boundingBox())!;
    const targetBox = (await target.boundingBox())!;
    // Both sidebars use an overlay; the source occupies its sortable destination.
    const sourceShift = targetBox.height;
    const sourceMember = project(page, "p2");
    const sourceMemberTop = (await sourceMember.boundingBox())!.y;
    const members = collapsed ? [] : [project(page, "q"), project(page, "q2")];
    const memberTops = await Promise.all(members.map(async (row) => (await row.boundingBox())!.y));
    await holdDrag(page, sourceHeading, targetHeading);
    await expect(page.getByTestId("sidebar-drag-overlay")).toContainText("Source");
    await expect(target.locator(":scope > .relative")).toHaveClass(/border-primary/);
    await expectVerticalShift(source, sourceBox.y, sourceShift);
    await expectVerticalShift(sourceMember, sourceMemberTop, sourceShift);
    await expectVerticalShift(target, targetBox.y, -sourceBox.height);
    for (const [index, member] of members.entries()) {
      await expectVerticalShift(member, memberTops[index]!, -sourceBox.height);
    }
    await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
    await page.mouse.up();
    await expect(page.getByTestId("sidebar-writes")).toContainText("arrange_projects_by_intent");
    await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
      "data-project-folder",
      "Target",
    );
    await page.reload();
    await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
      "data-project-folder",
      "Target",
    );
  });
}

test("local project header drop reorders expanded projects and survives reload", async ({
  page,
}) => {
  await page.goto("/sidebar-drag");
  await expect(page.getByText("p-env-3", { exact: true })).toBeVisible();
  await expect(page.getByText("q-env-3", { exact: true })).toBeVisible();
  await drag(page, project(page, "q"), project(page, "p"));
  await expect(page.getByTestId("sidebar-writes")).toContainText("arrange_projects_by_intent");
  const write = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!)[0];
  expect(write.args.projectIds).toEqual(["q", "p"]);
  expect((await project(page, "q").boundingBox())!.y).toBeLessThan(
    (await project(page, "p").boundingBox())!.y,
  );
  await page.reload();
  await expect(page.getByText("p-env-3", { exact: true })).toBeVisible();
  expect((await project(page, "q").boundingBox())!.y).toBeLessThan(
    (await project(page, "p").boundingBox())!.y,
  );
});

for (const merged of [false, true]) {
  test(`${merged ? "merged" : "local"} environment drop on another project submits no write`, async ({
    page,
  }) => {
    await page.goto(`/sidebar-drag${merged ? "?merged=1" : ""}`);
    await expect(page.getByText("q-env-2", { exact: true })).toBeVisible();
    await drag(
      page,
      page
        .locator(".group\\/sortable")
        .filter({ has: page.getByRole("button", { name: /^p-env-1(?:, on |$)/ }) })
        .getByRole("button")
        .first(),
      page.getByText("q-env-2", { exact: true }),
    );
    await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
  });
}

// With another machine known, the sidebar is the repository list (design
// EL01): this window's projects are repository headings over their rows.
const repositoryHeading = (page: Page, label: string) =>
  page.getByRole("button", { name: new RegExp(`^Open acme/${label} on `) });
const repositoryFolder = (page: Page, label: string) =>
  page.locator(`[data-project-folder="github.com/acme/${label}"]`);

test("a pointer gesture from the repository chevron leaves repository order alone", async ({
  page,
}) => {
  await page.goto("/sidebar-drag?groups=1&merged=1");
  const source = repositoryHeading(page, "source");
  const target = repositoryHeading(page, "target");
  const chevron = repositoryFolder(page, "source").getByTestId("repository-collapse-toggle");
  await expect(chevron).toBeVisible();
  const start = (await chevron.boundingBox())!;
  const end = (await target.boundingBox())!;

  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  try {
    // Cross the same activation distance as a drag from the heading.
    await page.mouse.move(start.x + start.width / 2 - 12, start.y + start.height / 2, {
      steps: 3,
    });
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
    await expect(source).not.toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("sidebar-drag-overlay")).toHaveCount(0);
  } finally {
    await page.mouse.up();
  }

  await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
  await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
    "data-project-folder",
    "github.com/acme/source",
  );
});

test("repository heading drop on an expanded repository's row moves the whole group", async ({
  page,
}) => {
  await page.goto("/sidebar-drag?groups=1&merged=1");
  const source = repositoryHeading(page, "source");
  await expect(source).toBeVisible();
  await drag(page, source, page.getByText("q-env-1", { exact: true }));
  await expect(page.getByTestId("sidebar-writes")).toContainText("repositoryOrder");
  const write = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!)[0];
  expect(write.command).toBe("update_portal_layout");
  expect(write.args.repositoryOrder.map((id: string) => JSON.parse(id)[2])).toEqual([
    "q",
    "q2",
    "p",
    "p2",
  ]);
  await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
    "data-project-folder",
    "github.com/acme/target",
  );
  // Rows stay with their repository.
  await expect(
    repositoryFolder(page, "source").getByText("p-env-1", { exact: true }),
  ).toBeVisible();
  await expect(
    repositoryFolder(page, "target").getByText("q-env-1", { exact: true }),
  ).toBeVisible();
});

for (const collapsed of [false, true]) {
  test(`repository heading drop reorders ${collapsed ? "collapsed" : "expanded"} repositories and survives reload`, async ({
    page,
  }) => {
    await page.goto("/sidebar-drag?groups=1&merged=1");
    const source = repositoryHeading(page, "source");
    const target = repositoryHeading(page, "target");
    await expect(source).toBeVisible();
    if (collapsed) {
      // Left collapses a heading from the keyboard; its chevron agrees.
      for (const [label, heading] of [
        ["source", source],
        ["target", target],
      ] as const) {
        await heading.focus();
        await heading.press("ArrowLeft");
        await expect(
          page.getByRole("button", { name: `Expand project acme/${label}`, exact: true }),
        ).toHaveAttribute("aria-expanded", "false");
      }
      await expect(page.getByText("p-env-1", { exact: true })).toHaveCount(0);
    }
    await drag(page, source, target);
    await expect(page.getByTestId("sidebar-writes")).toContainText('"repositoryOrder"');
    const writes = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!);
    expect(writes.at(-1).args.repositoryOrder.map((id: string) => JSON.parse(id)[2])).toEqual([
      "q",
      "q2",
      "p",
      "p2",
    ]);
    await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
      "data-project-folder",
      "github.com/acme/target",
    );
    await page.reload();
    await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
      "data-project-folder",
      "github.com/acme/target",
    );
  });
}

test("a row of this window's machine reorders within its project", async ({ page }) => {
  await page.goto("/sidebar-drag?merged=1");
  await expect(page.getByText("p-env-2", { exact: true })).toBeVisible();
  await drag(
    page,
    page.getByRole("button", { name: "Reorder p-env-1", exact: true }),
    page.getByText("p-env-2", { exact: true }),
  );
  await expect(page.getByTestId("sidebar-writes")).toContainText("reorder_environments");
  const writes = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!);
  expect(writes).toHaveLength(1);
});

const tile = (page: Page, machine: string) =>
  page.getByTestId("machine-tile").and(page.locator(`[data-machine="bk_${machine}"]`));

test("a machine tile pointer reorder persists without filtering", async ({ page }) => {
  await page.goto("/sidebar-drag?merged=1");
  await expect(page.getByTestId("machine-tile").first()).toHaveAttribute("data-machine", "bk_self");
  await drag(page, tile(page, "remote"), tile(page, "self"));
  await expect(page.getByTestId("sidebar-writes")).toContainText('"machineOrder"');
  const writes = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!);
  expect(writes.at(-1).args.machineOrder).toEqual(["bk_remote", "bk_self"]);
  await expect(page.getByTestId("machine-tile").first()).toHaveAttribute(
    "data-machine",
    "bk_remote",
  );
  // The click that ends the drag does not filter.
  await expect(page.getByTestId("machine-tiles")).not.toHaveAttribute("data-filtered");
  await expect(page.getByText("p-env-1", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("machine-tile").first()).toHaveAttribute(
    "data-machine",
    "bk_remote",
  );
});

test("a machine tile dropped on the last tile moves to the end", async ({ page }) => {
  await page.goto("/sidebar-drag?merged=1&spare=1");
  await expect(page.getByTestId("machine-tile")).toHaveCount(3);
  await drag(page, tile(page, "self"), tile(page, "spare"));
  await expect(page.getByTestId("sidebar-writes")).toContainText('"machineOrder"');
  const writes = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!);
  expect(writes.at(-1).args.machineOrder).toEqual(["bk_remote", "bk_spare", "bk_self"]);
  await page.reload();
  await expect(page.getByTestId("machine-tile").last()).toHaveAttribute("data-machine", "bk_self");
});

test("a connected machine's tile says it is catching up", async ({ page }) => {
  await page.goto("/sidebar-drag?merged=1&catching-up=1");
  const remote = tile(page, "remote");
  await expect(remote).toHaveAttribute("title", /^Remote · Catching up\n/);
  await expect(remote).not.toHaveAttribute("data-dimmed");
});
