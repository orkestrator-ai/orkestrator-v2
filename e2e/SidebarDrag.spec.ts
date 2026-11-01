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

for (const merged of [false, true]) {
  test(`${merged ? "merged" : "local"} project drag keeps expanded folder rows separate before release`, async ({
    page,
  }) => {
    await page.goto(`/sidebar-drag?groups=1${merged ? "&merged=1" : ""}`);
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
    await expect(target.locator(":scope > .relative")).toHaveClass(/border-primary/);
    for (const index of [0, 1, 3, 4, 5]) {
      await expectVerticalShift(rows[index]!, before[index]!, 0);
    }
    // Continue across the entire target folder. Its members must inherit one
    // parent shift, rather than adding a second transform on top of it.
    await project(page, "q2").hover();
    await expect(
      page.locator('[id^="DndLiveRegion"]').filter({ hasText: "over droppable area" }),
    ).toContainText(merged ? "q2" : "area q2");
    for (const index of [0, 1]) await expectVerticalShift(rows[index]!, before[index]!, 0);
    for (const index of [3, 4, 5])
      await expectVerticalShift(rows[index]!, before[index]!, -activeHeight);
    await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
    await page.keyboard.press("Escape");
    for (const [index, row] of rows.entries()) await expectVerticalShift(row, before[index]!, 0);
    await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
  });

  for (const collapsed of [false, true]) {
    test(`${merged ? "merged" : "local"} folder drag shifts ${collapsed ? "collapsed" : "expanded"} target as one block before release`, async ({
      page,
    }) => {
      await page.goto(`/sidebar-drag?groups=1${merged ? "&merged=1" : ""}`);
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
      const sourceHandleBox = (await sourceHeading.boundingBox())!;
      const targetHandleBox = (await targetHeading.boundingBox())!;
      // The merged sidebar moves the active node with the pointer. Local
      // uses a drag overlay and leaves the node at its sortable destination.
      const sourceShift = merged
        ? targetHandleBox.y +
          targetHandleBox.height / 2 -
          sourceHandleBox.y -
          sourceHandleBox.height / 2
        : targetBox.height;
      const sourceMember = project(page, "p2");
      const sourceMemberTop = (await sourceMember.boundingBox())!.y;
      const members = collapsed ? [] : [project(page, "q"), project(page, "q2")];
      const memberTops = await Promise.all(
        members.map(async (row) => (await row.boundingBox())!.y),
      );
      await holdDrag(page, sourceHeading, targetHeading);
      await expect(target.locator(":scope > .relative")).toHaveClass(/border-primary/);
      await expectVerticalShift(source, sourceBox.y, sourceShift);
      await expectVerticalShift(sourceMember, sourceMemberTop, sourceShift);
      await expectVerticalShift(target, targetBox.y, -sourceBox.height);
      for (const [index, member] of members.entries()) {
        await expectVerticalShift(member, memberTops[index]!, -sourceBox.height);
      }
      await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
      await page.mouse.up();
      await expect(page.getByTestId("sidebar-writes")).toContainText(
        merged ? "update_portal_layout" : "arrange_projects",
      );
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
}

for (const merged of [false, true]) {
  test(`${merged ? "merged" : "local"} project header drop reorders expanded projects and survives reload`, async ({
    page,
  }) => {
    await page.goto(`/sidebar-drag${merged ? "?merged=1" : ""}`);
    await expect(page.getByText("p-env-3", { exact: true })).toBeVisible();
    await expect(page.getByText("q-env-3", { exact: true })).toBeVisible();
    await drag(page, project(page, "q"), project(page, "p"));
    await expect(page.getByTestId("sidebar-writes")).toContainText(
      merged ? "update_portal_layout" : "arrange_projects",
    );
    const write = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!)[0];
    expect(
      write.args[merged ? "projectOrder" : "projectIds"].map((id: string) =>
        merged ? JSON.parse(id)[2] : id,
      ),
    ).toEqual(["q", "p"]);
    expect((await project(page, "q").boundingBox())!.y).toBeLessThan(
      (await project(page, "p").boundingBox())!.y,
    );
    await page.reload();
    await expect(page.getByText("p-env-3", { exact: true })).toBeVisible();
    expect((await project(page, "q").boundingBox())!.y).toBeLessThan(
      (await project(page, "p").boundingBox())!.y,
    );
  });

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

for (const repository of [false, true]) {
  test(`${repository ? "repository group" : "folder"} drop on an expanded member moves the whole group`, async ({
    page,
  }) => {
    await page.goto(`/sidebar-drag?groups=1${repository ? "&merged=1&repository=1" : ""}`);
    const source = repository
      ? page.getByRole("button", { name: /^Open acme\/source( on |$)/ })
      : page.getByTitle("Collapse folder Source", { exact: true }).first();
    await expect(source).toBeVisible();
    await drag(page, source, project(page, "q"));
    await expect(page.getByTestId("sidebar-writes")).toContainText(
      repository ? "repositoryOrder" : "projectIds",
    );
    const write = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!)[0];
    const ids: string[] = write.args[repository ? "repositoryOrder" : "projectIds"];
    expect(ids.map((id) => (repository ? JSON.parse(id)[2] : id))).toEqual(["q", "q2", "p", "p2"]);
    if (!repository) expect(write.args.folders).toEqual({});
    await expect(
      page
        .locator(`[data-project-folder='${repository ? "github.com/acme/source" : "Source"}']`)
        .getByRole("button", { name: /^(Self · )?p 3$/ }),
    ).toBeVisible();
    await expect(
      page
        .locator(`[data-project-folder='${repository ? "github.com/acme/target" : "Target"}']`)
        .getByRole("button", { name: /^(Self · )?q 3$/ }),
    ).toBeVisible();
  });
}

for (const collapsed of [false, true]) {
  for (const [region, fraction] of [
    ["rule", 0.5],
    ["above rule", 0.1],
    ["below rule", 0.9],
  ] as const) {
    test(`repository drop ${region} reorders ${collapsed ? "collapsed" : "expanded"} groups and survives reload`, async ({
      page,
    }) => {
      await page.goto("/sidebar-drag?groups=1&merged=1&repository=1");
      const source = page.getByRole("button", { name: /^Open acme\/source( on |$)/ });
      const target = page.locator('[data-project-folder="github.com/acme/target"]');
      await expect(source).toBeVisible();
      if (collapsed) {
        await page
          .getByRole("button", { name: "Collapse folder acme/source", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Collapse folder acme/target", exact: true })
          .click();
      }
      // Exercise the line and both padding bands inside the following group's drop target.
      const separatorBand = target.getByTestId("repository-separator").locator("..");
      await drag(page, source, separatorBand, fraction);
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
}

for (const input of ["pointer", "keyboard"] as const) {
  test(`machine name ${input} reorder persists and restores focus`, async ({ page }) => {
    await page.goto("/sidebar-drag?machines=1");
    const source = page.getByRole("button", { name: "Move Self", exact: true });
    const target = page.getByRole("button", { name: "Move Remote", exact: true });
    await expect(source).toBeVisible();
    // The trailing chevron collapses independently and cannot start dragging.
    await page.getByRole("button", { name: "Collapse Self", exact: true }).click();
    await expect(page.getByRole("button", { name: "Expand Self", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.getByText("p-env-1", { exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
    await page.getByRole("button", { name: "Collapse Remote", exact: true }).press("Space");
    await expect(page.getByRole("button", { name: "Expand Remote", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.getByTestId("sidebar-writes")).toHaveText("[]");
    if (input === "pointer") {
      await drag(page, source, target);
    } else {
      await source.focus();
      await source.press("Space");
      await expect(source).toHaveAttribute("aria-pressed", "true");
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      await page.keyboard.press("ArrowDown");
      await expect(page.getByTestId("bound-machine-section")).toHaveAttribute(
        "style",
        /translate3d\(0px, [1-9]/,
      );
      await expect(
        page.locator('[id^="DndLiveRegion"]').filter({ hasText: "machine:bk_self" }),
      ).toContainText("over droppable area machine:bk_remote");
      await page.keyboard.press("Space");
    }
    await expect(page.getByTestId("sidebar-writes")).toContainText('"machineOrder"');
    const writes = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!);
    expect(writes.at(-1).args.machineOrder).toEqual(["bk_remote", "bk_self"]);
    await expect(page.getByTestId("machine-section-header").first()).toHaveAttribute(
      "data-machine",
      "bk_remote",
    );
    await expect(source).toBeFocused();
    await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("machine-section-header").first()).toHaveAttribute(
      "data-machine",
      "bk_remote",
    );
    await expect(page.getByText("p-env-1", { exact: true })).toBeVisible();
  });
}

for (const direction of ["down", "up"] as const) {
  test(`machine name pointer drop ${direction} targets an adjacent heading with unequal section heights`, async ({
    page,
  }) => {
    await page.goto("/sidebar-drag?machines=1&spare=1");
    await expect(page.getByText("q-env-3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move Spare", exact: true })).toBeVisible();
    const source = page.getByRole("button", {
      name: direction === "down" ? "Move Self" : "Move Remote",
      exact: true,
    });
    // Self stays expanded, so its section is far taller than Remote's or Spare's.
    await drag(
      page,
      source,
      page.getByRole("button", {
        name: direction === "down" ? "Move Remote" : "Move Self",
        exact: true,
      }),
    );
    await expect(page.getByTestId("sidebar-writes")).toContainText('"machineOrder"');
    const writes = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!);
    expect(writes.at(-1).args.machineOrder).toEqual(["bk_remote", "bk_self", "bk_spare"]);
    await expect(source).toBeFocused();
    await page.reload();
    await expect(page.getByTestId("machine-section-header").first()).toHaveAttribute(
      "data-machine",
      "bk_remote",
    );
  });
}

test("machine released in empty space below collapsed sections moves to the end", async ({
  page,
}) => {
  await page.goto("/sidebar-drag?machines=1&spare=1");
  for (const name of ["Self", "Remote", "Spare"]) {
    await page.getByRole("button", { name: `Collapse ${name}`, exact: true }).click();
  }
  const source = page.getByRole("button", { name: "Move Self", exact: true });
  const start = (await source.boundingBox())!;
  const last = (await page.getByTestId("machine-section-header").last().boundingBox())!;
  const x = start.x + start.width / 2;
  const y = last.y + last.height + 80;
  // Verify the release point really is outside every machine section.
  for (const header of await page.getByTestId("machine-section-header").all()) {
    const box = (await header.boundingBox())!;
    expect(box.y + box.height).toBeLessThan(y);
  }
  await page.mouse.move(x, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(x + 12, start.y + start.height / 2, { steps: 3 });
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId("sidebar-writes")).toContainText('"machineOrder"');
  const writes = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!);
  expect(writes.at(-1).args.machineOrder).toEqual(["bk_remote", "bk_spare", "bk_self"]);
  await expect(source).toBeFocused();
  await page.reload();
  await expect(page.getByTestId("machine-section-header").last()).toHaveAttribute(
    "data-machine",
    "bk_self",
  );
});

for (const sourceName of ["Self", "Remote"] as const) {
  test(`keyboard machine reorder from ${sourceName} visits adjacent unequal-height sections`, async ({
    page,
  }) => {
    await page.goto("/sidebar-drag?machines=1&spare=1");
    await expect(page.getByText("q-env-3", { exact: true })).toBeVisible();
    const source = page.getByRole("button", { name: `Move ${sourceName}`, exact: true });
    await source.focus();
    await source.press("Space");
    await expect(source).toHaveAttribute("aria-pressed", "true");
    // The keyboard sensor attaches its arrow listener after activation.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const targets =
      sourceName === "Self"
        ? [
            ["ArrowDown", "bk_remote"],
            ["ArrowDown", "bk_spare"],
            ["ArrowUp", "bk_remote"],
          ]
        : [["ArrowUp", "bk_self"]];
    for (const [key, id] of targets) {
      await page.keyboard.press(key);
      await expect(
        page
          .locator('[id^="DndLiveRegion"]')
          .filter({ hasText: `machine:bk_${sourceName.toLowerCase()}` }),
      ).toContainText(`over droppable area machine:${id}`);
    }
    await page.keyboard.press("Space");
    await expect(page.getByTestId("sidebar-writes")).toContainText('"machineOrder"');
    const writes = JSON.parse((await page.getByTestId("sidebar-writes").textContent())!);
    expect(writes.at(-1).args.machineOrder).toEqual(["bk_remote", "bk_self", "bk_spare"]);
    await expect(source).toBeFocused();
    await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("machine-section-header").first()).toHaveAttribute(
      "data-machine",
      "bk_remote",
    );
  });
}

test("project grouping leads bound project headings with the machine home icon", async ({
  page,
}) => {
  await page.goto("/sidebar-drag?merged=1");
  const heading = project(page, "p");
  await expect(heading.getByTestId("machine-home-icon")).toHaveAttribute(
    "data-machine-color",
    "teal",
  );
  await expect(heading.locator(":scope > :first-child")).toHaveAttribute(
    "data-testid",
    "machine-home-icon",
  );
});

test("a connected machine exposes catching-up status in its header", async ({ page }) => {
  await page.goto("/sidebar-drag?machines=1&catching-up=1");
  const header = page.getByTestId("machine-section-header").filter({ hasText: "Remote" });
  await expect(header.getByText("Catching up", { exact: true })).toBeVisible();
  await expect(header.locator(".lucide-wifi-off")).toHaveCount(0);
});
