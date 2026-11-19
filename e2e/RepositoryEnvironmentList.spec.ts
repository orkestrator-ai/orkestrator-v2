import { environmentKey, environmentRef, type BackendId } from "@orkestrator/protocol/federation";
import { expect, test, type Locator, type Page } from "@playwright/test";

// The multi-machine sidebar's list (design EL01) over seven machines
// (apps/web/src/test/RepositoryEnvironmentListFixture.tsx).

const ORK = "github.com/acme/orkestrator-v2";
const TELEGRAM = "github.com/acme/telegram-scraper";

const folder = (page: Page, name: string) => page.locator(`[data-project-folder="${name}"]`);
const heading = (page: Page, label: string) =>
  page.getByRole("button", { name: new RegExp(`^Open ${label} on `) });
const grip = (page: Page, name: string) =>
  page.getByRole("button", { name: `Reorder ${name}`, exact: true });
const row = (page: Page, name: string) =>
  page.getByTestId("federated-environment-row").filter({ has: grip(page, name) });
const tile = (page: Page, machine: string) =>
  page.getByTestId("machine-tile").and(page.locator(`[data-machine="bk_${machine}"]`));
const key = (machine: string, id: string) =>
  environmentKey(environmentRef(`bk_${machine}` as BackendId, id));

/** A repository's rows as `name@machine`, in list order. */
async function rowsOf(page: Page, repository: string): Promise<string[]> {
  return folder(page, repository)
    .getByTestId("federated-environment-row")
    .evaluateAll((rows) =>
      rows.map((element) => {
        const name =
          element
            .querySelector('button[aria-label^="Reorder "]')
            ?.getAttribute("aria-label")
            ?.slice("Reorder ".length) ?? "?";
        return `${name}@${element.getAttribute("data-machine")?.slice("bk_".length)}`;
      }),
    );
}

async function updates(page: Page): Promise<Array<Record<string, unknown>>> {
  return JSON.parse((await page.getByTestId("updates").textContent()) || "[]");
}

/** Presses on `handle`, moves past the 8 px activation distance, then over `target`. */
async function holdDrag(page: Page, handle: Locator, target: Locator) {
  await handle.scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!;
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 12, y, { steps: 3 });
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
}

async function drag(page: Page, handle: Locator, target: Locator) {
  await holdDrag(page, handle, target);
  await page.mouse.up();
  // PointerSensor suppresses the click that ends a drag; let it clean up.
  await page.waitForTimeout(60);
}

test("each repository is one heading over its environments, flat across machines", async ({
  page,
}) => {
  await page.goto("/repository-environment-list");
  await expect(page.getByTestId("federated-repository-list")).toHaveAttribute(
    "data-ordering",
    "machine",
  );
  await expect(page.locator("[data-project-folder]")).toHaveCount(5);
  await expect(heading(page, "acme/orkestrator-v2")).toContainText("4 machines · 5 environments");
  // By machine: each machine's environments together, in machine order.
  await expect
    .poll(() => rowsOf(page, ORK))
    .toEqual([
      "sidebar-redesign@mini",
      "fix-merge-queue@mini",
      "release-notes@beelink",
      "desktop-smoke@mbp3",
      "perf-trace@mbp3",
    ]);
  // No per-machine project headings under a repository.
  await expect(page.getByTestId("federated-project")).toHaveCount(0);
  await expect(
    folder(page, ORK).getByRole("button", { name: /^Open orkestrator-v2 on / }),
  ).toHaveCount(0);
  // A repository with no environments is a heading alone.
  await expect(heading(page, "acme/infra")).toContainText("1 machine");
  await expect(heading(page, "acme/infra")).not.toContainText("environment");
  await expect(
    folder(page, "github.com/acme/infra").getByTestId("federated-environment-row"),
  ).toHaveCount(0);
  // A project with no repository is a heading of its own, named by the project.
  await expect(heading(page, "scratch")).toHaveAccessibleName("Open scratch on rkmbp");
  // Each row's status marker is its machine's colour; the row names its machine.
  await expect(
    row(page, "desktop-smoke").getByRole("button", { name: /^desktop-smoke, on mbp3/ }),
  ).toBeVisible();
});

test("the heading's + opens New Environment on the machine the heading opens", async ({ page }) => {
  await page.goto("/repository-environment-list");
  const add = page.getByRole("button", {
    name: "New environment in acme/orkestrator-v2",
    exact: true,
  });
  await expect(add).toHaveAttribute("title", "New environment on mini");
  await add.click();
  await expect(page.getByTestId("opened")).toHaveText("bk_mini");
  await expect(page.getByTestId("intent")).toContainText('"createEnvironmentProjectId":"ork"');
  await expect(page.getByTestId("intent")).toContainText('"projectId":"ork"');
  // Neither the + nor the heading changes the list.
  await heading(page, "acme/telegram-scraper").click();
  await expect(page.getByTestId("opened")).toHaveText("bk_beelink2");
  await expect(page.getByTestId("intent")).toHaveText(
    '{"projectId":"tg","landingTab":"coordinator"}',
  );
  await expect(page.getByTestId("updates")).toHaveText("[]");
  await expect(page.getByTestId("reorders")).toHaveText("[]");
});

test("dragging a heading reorders the repositories on the command node", async ({ page }) => {
  await page.goto("/repository-environment-list");
  await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
    "data-project-folder",
    ORK,
  );
  await drag(page, heading(page, "acme/telegram-scraper"), heading(page, "acme/orkestrator-v2"));
  await expect(page.locator("[data-project-folder]").first()).toHaveAttribute(
    "data-project-folder",
    TELEGRAM,
  );
  const [update] = await updates(page);
  expect(Object.keys(update!)).toEqual(["repositoryOrder"]);
  // Its members on every machine move together, ahead of the rest.
  expect((update!.repositoryOrder as string[]).slice(0, 2).map((id) => JSON.parse(id)[0])).toEqual([
    "bk_beelink2",
    "bk_omarchy-hp",
  ]);
  await expect(page.getByTestId("opened")).toBeEmpty();
  await expect(page.getByTestId("reorders")).toHaveText("[]");
});

test("by machine, a row moves only within its machine's run", async ({ page }) => {
  await page.goto("/repository-environment-list");
  await expect(row(page, "fix-merge-queue")).toBeVisible();
  await drag(page, grip(page, "sidebar-redesign"), row(page, "fix-merge-queue"));
  await expect(page.getByTestId("reorders")).toHaveText(
    JSON.stringify([
      {
        nodeId: "bk_mini",
        projectId: "ork",
        environmentIds: ["fix-merge-queue", "sidebar-redesign"],
      },
    ]),
  );
  await expect
    .poll(() => rowsOf(page, ORK))
    .toEqual([
      "fix-merge-queue@mini",
      "sidebar-redesign@mini",
      "release-notes@beelink",
      "desktop-smoke@mbp3",
      "perf-trace@mbp3",
    ]);

  // Onto another machine's row: refused, nothing written anywhere.
  await drag(page, grip(page, "desktop-smoke"), row(page, "fix-merge-queue"));
  await expect
    .poll(() => rowsOf(page, ORK))
    .toEqual([
      "fix-merge-queue@mini",
      "sidebar-redesign@mini",
      "release-notes@beelink",
      "desktop-smoke@mbp3",
      "perf-trace@mbp3",
    ]);
  expect(JSON.parse((await page.getByTestId("reorders").textContent())!)).toHaveLength(1);
  await expect(page.getByTestId("updates")).toHaveText("[]");
});

test("a row never leaves its repository", async ({ page }) => {
  await page.goto("/repository-environment-list?ordering=manual");
  await drag(page, grip(page, "blog-migration"), row(page, "sidebar-redesign"));
  await expect(page.getByTestId("updates")).toHaveText("[]");
  await expect(page.getByTestId("reorders")).toHaveText("[]");
  await expect
    .poll(() => rowsOf(page, "github.com/acme/website"))
    .toEqual(["blog-migration@mini", "pricing-page@omarchy-gram"]);
});

test("manually, a row moves across machines and the order is kept on the command node", async ({
  page,
}) => {
  await page.goto("/repository-environment-list?ordering=manual");
  await expect(page.getByTestId("federated-repository-list")).toHaveAttribute(
    "data-ordering",
    "manual",
  );
  await drag(page, grip(page, "desktop-smoke"), row(page, "sidebar-redesign"));
  await expect
    .poll(() => rowsOf(page, ORK))
    .toEqual([
      "desktop-smoke@mbp3",
      "sidebar-redesign@mini",
      "fix-merge-queue@mini",
      "release-notes@beelink",
      "perf-trace@mbp3",
    ]);
  const written = await updates(page);
  expect(written).toHaveLength(1);
  expect(written[0]).toEqual({
    environmentOrder: {
      [ORK]: [
        key("mbp3", "desktop-smoke"),
        key("mini", "sidebar-redesign"),
        key("mini", "fix-merge-queue"),
        key("beelink", "release-notes"),
        key("mbp3", "perf-trace"),
      ],
    },
  });
  // Nothing is written to the machines themselves.
  await expect(page.getByTestId("reorders")).toHaveText("[]");
});

test("a tile shows only its machine; the others fade until it is clicked again", async ({
  page,
}) => {
  await page.goto("/repository-environment-list");
  const mbp3 = tile(page, "mbp3");
  await expect(page.getByTestId("machine-tile")).toHaveCount(7);
  await expect(mbp3.getByTestId("machine-tile-cpu")).toHaveText("15%");
  await expect(mbp3).toHaveAccessibleName("mbp3, CPU 15%, shown");
  await expect(mbp3).toHaveAttribute("data-state", "all");

  await mbp3.click();
  await expect(page.getByTestId("filter")).toHaveText('["bk_mbp3"]');
  await expect(mbp3).toHaveAttribute("data-state", "selected");
  await expect(mbp3).toHaveAttribute("aria-pressed", "true");
  await expect(tile(page, "mini")).toHaveAttribute("data-state", "faded");
  await expect(tile(page, "mini")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("machine-tiles")).toHaveAttribute("data-filtered", "true");
  await expect(page.locator("[data-project-folder]")).toHaveCount(1);
  await expect.poll(() => rowsOf(page, ORK)).toEqual(["desktop-smoke@mbp3", "perf-trace@mbp3"]);
  await expect(heading(page, "acme/orkestrator-v2")).toContainText("1 machine · 2 environments");

  // Another tile adds its machine; removing the last one shows them all.
  await tile(page, "beelink").click();
  await expect(page.getByTestId("filter")).toHaveText('["bk_beelink","bk_mbp3"]');
  await tile(page, "beelink").click();
  await mbp3.click();
  await expect(page.getByTestId("filter")).toHaveText("[]");
  await expect(mbp3).toHaveAttribute("data-state", "all");
  await expect(page.locator("[data-project-folder]")).toHaveCount(5);
  await expect(page.getByTestId("updates")).toHaveText("[]");
});

test("dragging a tile reorders the machines without filtering", async ({ page }) => {
  await page.goto("/repository-environment-list");
  await drag(page, tile(page, "mbp3"), tile(page, "mini"));
  await expect(page.getByTestId("machine-tile").first()).toHaveAttribute("data-machine", "bk_mbp3");
  const written = await updates(page);
  expect(written).toHaveLength(1);
  expect((written[0]!.machineOrder as string[]).filter((id) => id !== "bk_self")).toEqual([
    "bk_mbp3",
    "bk_mini",
    "bk_beelink",
    "bk_beelink2",
    "bk_omarchy-hp",
    "bk_rkmbp",
    "bk_omarchy-gram",
  ]);
  await expect(page.getByTestId("filter")).toHaveText("[]");
  // By machine, the list follows the machine order.
  await expect
    .poll(() => rowsOf(page, ORK))
    .toEqual([
      "desktop-smoke@mbp3",
      "perf-trace@mbp3",
      "sidebar-redesign@mini",
      "fix-merge-queue@mini",
      "release-notes@beelink",
    ]);
});

test("an unavailable machine's tile dims and its environments leave the list", async ({ page }) => {
  await page.goto("/repository-environment-list?offline=mbp3");
  const mbp3 = tile(page, "mbp3");
  await expect(mbp3.getByTestId("machine-tile-cpu")).toHaveText("—");
  await expect(mbp3).toHaveAttribute("data-dimmed", "true");
  await expect(mbp3).toHaveAccessibleName(/^mbp3, CPU unavailable, Unavailable/);
  await expect
    .poll(() => rowsOf(page, ORK))
    .toEqual(["sidebar-redesign@mini", "fix-merge-queue@mini", "release-notes@beelink"]);
});
