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
