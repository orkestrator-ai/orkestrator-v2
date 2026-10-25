import { projectKey, projectRef, type BackendId } from "@orkestrator/protocol/federation";
import { expect, test, type Locator, type Page } from "@playwright/test";

const hintA = "gitlab.example/team-a/shared/app";
const hintB = "gitlab.example/team-b/shared/app";
const folder = (page: Page, name: string) => page.locator(`[data-project-folder="${name}"]`);
const key = (id: string) => projectKey(projectRef("bk_remote" as BackendId, id));
const project = (page: Page, id: string) =>
  page.locator(`[data-project=${JSON.stringify(key(id))}]`);
const heading = (page: Page, label: string, machine = "Command") =>
  page.getByRole("button", { name: `Open ${label} on ${machine}`, exact: true });

// Pointer drags target the row under the pointer, including expanded groups.
async function hoverDrag(page: Page, handle: Locator, target: Locator) {
  const grip = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y, { steps: 3 });
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
}

test("namespaced headings retain distinct labels and full-hint titles", async ({ page }) => {
  await page.goto("/merged-project-list");
  await expect(heading(page, "team-a/shared/app")).toHaveAttribute(
    "title",
    `Open ${hintA} on Command`,
  );
  await expect(heading(page, "team-b/shared/app", "Remote")).toHaveAttribute(
    "title",
    `Open ${hintB} on Remote`,
  );
  await expect(heading(page, "team-a/shared/app")).toContainText("team-a/shared/app");
  await expect(heading(page, "team-b/shared/app", "Remote")).toContainText("team-b/shared/app");
});

// Space is the heading's keyboard drag, covered by the reorder test below.
for (const activation of ["click", "Enter"] as const) {
  for (const fallback of [false, true]) {
    test(`${activation} opens the ${fallback ? "first shown fallback" : "command node"} workspace without dragging`, async ({
      page,
    }) => {
      await page.goto(`/merged-project-list${fallback ? "?fallback=1" : ""}`);
      const button = heading(page, "team-a/shared/app", fallback ? "Remote" : "Command");
      await expect(button).toBeVisible();
      await expect(page.getByTestId("federated-environment-row")).toHaveCount(fallback ? 6 : 8);
      const navigations: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
      });
      const documentId = await page.evaluate(() => {
        const marker = crypto.randomUUID();
        document.documentElement.dataset.documentId = marker;
        return marker;
      });
      if (activation === "click") await button.click();
      else {
        await button.focus();
        await button.press(activation);
      }
      if (fallback) {
        await expect(page.getByTestId("opened")).toHaveText('{"nodeId":"bk_remote"}');
        await expect(page.getByTestId("intent")).toHaveText('{"projectId":"p"}');
      } else {
        await expect(page.getByTestId("selected")).toHaveText("local");
      }
      expect(navigations).toEqual([]);
      await expect(page.locator("html")).toHaveAttribute("data-document-id", documentId);
      await expect(page.getByTestId("updates")).toHaveText("[]");
      await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
    });
  }
}

test("the chevron collapses without navigating and the heading reorders with Space", async ({
  page,
}) => {
  await page.goto("/merged-project-list");
  await page
    .getByRole("button", { name: "Collapse folder team-a/shared/app", exact: true })
    .press("Enter");
  await expect(folder(page, hintA).locator("[data-project-folder-content]")).toHaveCount(0);
  await expect(page.getByTestId("selected")).toBeEmpty();
  await expect(page.getByTestId("opened")).toBeEmpty();
  await page
    .getByRole("button", { name: "Collapse folder team-b/shared/app", exact: true })
    .press("Space");
  const source = page.getByRole("button", { name: /^Open team-a\/shared\/app on / });
  await source.focus();
  await source.press("Space");
  await expect(source).toHaveAttribute("aria-pressed", "true");
  // KeyboardSensor installs its document listener on the next task; wait for
  // the browser to paint the activated drag before sending movement keys.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.keyboard.press("ArrowDown");
  await expect(folder(page, hintA)).toHaveAttribute("style", /translate3d\(0px, [1-9]/);
  // Movement paints before DndContext publishes its new drop target.
  await expect(heading(page, "team-b/shared/app", "Remote").locator("..")).toHaveClass(
    /border-primary\/70/,
  );
  await page.keyboard.press("Space");
  await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
    "data-project-folder",
    hintB,
  );
  await expect(source).toBeFocused();
  await expect(page.getByTestId("opened")).toBeEmpty();
  await expect(page.getByTestId("updates")).toContainText('"repositoryOrder"');
  await expect(page.getByTestId("selected")).toBeEmpty();
});

for (const fallback of [false, true]) {
  test(`pointer repository reorder leaves navigation empty (${fallback ? "remote" : "bound"} target)`, async ({
    page,
  }) => {
    await page.goto(`/merged-project-list${fallback ? "?fallback=1" : ""}`);
    const source = heading(page, "team-a/shared/app", fallback ? "Remote" : "Command");
    await expect(source).toBeVisible();
    await hoverDrag(page, source, heading(page, "team-b/shared/app", "Remote"));
    await page.mouse.up();
    await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
      "data-project-folder",
      hintB,
    );
    await expect(page.getByTestId("updates")).toContainText('"repositoryOrder"');
    const updates = JSON.parse((await page.getByTestId("updates").textContent())!);
    expect(updates.at(-1).repositoryOrder[0]).toBe(key("r"));
    await expect(page.getByTestId("opened")).toBeEmpty();
    await expect(page.getByTestId("selected")).toBeEmpty();
    // A subsequent intentional click must still open the workspace.
    await source.click();
    await expect(page.getByTestId(fallback ? "opened" : "selected")).not.toBeEmpty();
  });
}

test("a project over a repository header has no join highlight and its drop is rejected", async ({
  page,
}) => {
  await page.goto("/merged-project-list");
  await page
    .getByRole("button", { name: "Collapse folder team-b/shared/app", exact: true })
    .click();
  await hoverDrag(page, page.getByTitle("Open p on Remote"), folder(page, hintB));
  await expect(page.getByTitle("Open p on Remote")).toHaveAttribute("aria-pressed", "true");
  await expect(heading(page, "team-b/shared/app", "Remote").locator("..")).not.toHaveClass(
    /border-primary\/70|bg-primary\/10/,
  );
  await expect(page.getByTestId("sidebar-root-drop-zone")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByTestId("updates")).toHaveText("[]");
  await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
    "data-project-folder",
    hintA,
  );
});

for (const mode of ["project", "repository"] as const) {
  test(`${mode} project and group drags ignore expanded environment rows`, async ({ page }) => {
    await page.goto(`/merged-project-list?mode=${mode}`);
    await expect(page.getByTestId("federated-environment-row")).toHaveCount(8);
    await hoverDrag(page, page.getByTitle("Open q on Remote"), project(page, "p"));
    await page.mouse.up();
    await expect(project(page, "q")).toHaveAttribute("data-project", key("q"));
    await expect(page.getByTestId("federated-project").first()).toHaveAttribute(
      "data-project",
      key("q"),
    );
    const nextFolder = mode === "project" ? "Later" : hintB;
    const handle =
      mode === "project"
        ? page.getByTitle("Collapse folder Work")
        : page.getByRole("button", { name: /^Open team-a\/shared\/app on / });
    await hoverDrag(page, handle, folder(page, nextFolder));
    await page.mouse.up();
    await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
      "data-project-folder",
      nextFolder,
    );
    await expect(page.getByTestId("reorders")).toHaveText("[]");
    await expect(page.getByTestId("opened")).toBeEmpty();
    await expect(page.getByTestId("selected")).toBeEmpty();
  });

  test(`${mode} preserves environment reordering`, async ({ page }) => {
    await page.goto(`/merged-project-list?mode=${mode}`);
    const first = page.getByRole("button", { name: "Reorder p-one", exact: true });
    const second = page.getByRole("button", { name: "Reorder p-two", exact: true });
    await hoverDrag(
      page,
      first,
      page.getByTestId("federated-environment-row").filter({ has: second }),
    );
    await page.mouse.up();
    await expect(page.getByTestId("reorders")).toContainText('"environmentIds":["p-two","p-one"]');
    await expect(page.getByTestId("updates")).toHaveText("[]");
  });
}

test("project mode accepts root drops with expanded environment rows", async ({ page }) => {
  await page.goto("/merged-project-list?mode=project");
  const handle = page.getByTitle("Open p on Remote");
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 10, grip.y + grip.height / 2);
  const target = (await page.getByTestId("sidebar-root-drop-zone").boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        JSON.parse((await page.getByTestId("updates").textContent()) ?? "[]").at(-1)
          ?.projectFolders,
    )
    .toEqual({ [key("p")]: null });
  await expect(
    folder(page, "Work").locator(`[data-project=${JSON.stringify(key("p"))}]`),
  ).toHaveCount(0);
  await expect(page.getByTestId("reorders")).toHaveText("[]");
});
