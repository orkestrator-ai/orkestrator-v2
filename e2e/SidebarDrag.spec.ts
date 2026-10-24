import { expect, test, type Locator, type Page } from "@playwright/test";

async function drag(page: Page, handle: Locator, target: Locator) {
  const start = (await handle.boundingBox())!;
  const end = (await target.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2, { steps: 3 });
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
  await page.mouse.up();
}

const project = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^(Self · )?${name} 3$`) });

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
        .filter({ has: page.getByRole("button", { name: "p-env-1", exact: true }) })
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
