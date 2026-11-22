import { environmentKey, environmentRef, type BackendId } from "@orkestrator/protocol/federation";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

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

test("a leaf-only repository lands on Coordinator from search and its heading", async ({
  page,
}) => {
  await page.goto("/repository-environment-list");
  await heading(page, "acme/telegram-scraper").click();
  const intent = page.getByTestId("intent");
  await expect(intent).toHaveText('{"projectId":"tg","landingTab":"coordinator"}');
  await page.reload();
  await page.getByTestId("project-search-trigger").click();
  await page.getByRole("combobox", { name: "Search projects and environments" }).fill("telegram");
  await page.getByRole("option", { name: "telegram-scraper, project on beelink2" }).click();
  await expect(intent).toHaveText('{"projectId":"tg","landingTab":"coordinator"}');
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
    repositoryKey: ORK,
    order: [
      key("mbp3", "desktop-smoke"),
      key("mini", "sidebar-redesign"),
      key("mini", "fix-merge-queue"),
      key("beelink", "release-notes"),
      key("mbp3", "perf-trace"),
    ],
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

test("the 390 px sidebar fits seven tiles and keyboard and menu filters stay in sync", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/repository-environment-list?phone-overlay");
  const sidebar = page.getByTestId("fixture-sidebar");
  const tiles = page.getByRole("group", { name: "Machines shown in the list" });
  await expect(tiles.getByRole("button")).toHaveCount(7);
  for (const surface of [
    page.getByRole("dialog", { name: "Projects and environments" }),
    sidebar,
    tiles,
    sidebar.locator("[data-sidebar-scroll]"),
  ]) {
    expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  const mini = tile(page, "mini");
  await mini.focus();
  await expect(mini).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("filter")).toHaveText('["bk_mini"]');
  await page.keyboard.press("Space");
  await expect(page.getByTestId("filter")).toHaveText("[]");
  // A tap on a tile is the same filter.
  await tile(page, "mbp3").click();
  await expect(tile(page, "mbp3")).toHaveAttribute("data-state", "selected");
  await expect(mini).toHaveAttribute("data-state", "faded");
  await tile(page, "mbp3").click();
  await expect(mini).toHaveAttribute("data-state", "all");
});

for (const scenario of ["empty", "offline"]) {
  test(`an ${scenario} selected machine explains the filter and offers to clear it`, async ({
    page,
  }) => {
    await page.goto(`/repository-environment-list?${scenario}=mbp3`);
    await tile(page, "mbp3").click();
    const message =
      scenario === "empty"
        ? "No projects on the selected machines"
        : "Selected machines are unavailable";
    await expect(page.getByText(message)).toBeVisible();
    await expect(page.getByRole("button", { name: "Add your first project" })).toHaveCount(0);
    await page.getByRole("button", { name: "Clear machine filter" }).click();
    await expect(heading(page, "acme/orkestrator-v2")).toBeVisible();
  });
}

test("a command node without Manual ordering uses by-machine order", async ({ page }) => {
  await page.goto("/repository-environment-list?ordering=manual&legacy-layout");
  await expect(page.getByTestId("federated-repository-list")).toHaveAttribute(
    "data-ordering",
    "machine",
  );
  await drag(page, grip(page, "desktop-smoke"), row(page, "sidebar-redesign"));
  await expect(page.getByTestId("updates")).toHaveText("[]");
});

test("two browsers save independent Manual orders across a command-node restart", async ({
  page,
  context,
}) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sidebar-command-node-"));
  const token = randomUUID();
  let commandNode: Awaited<ReturnType<typeof startCommandNode>> | undefined;
  const writes: Promise<unknown>[] = [];
  const reconciled = new Set<Page>();
  let releaseWrites!: () => void;
  const bothDropped = new Promise<void>((resolve) => {
    releaseWrites = resolve;
  });
  const serveLayout = async (route: Route) => {
    const body = route.request().postDataJSON() as { command: string; args?: unknown };
    if (body.command === "update_repository_environment_order") {
      const pending = bothDropped.then(() => commandNode!.invoke(body));
      writes.push(pending);
      if (writes.length === 2) releaseWrites();
      await route.fulfill({ json: await pending });
      return;
    }
    expect(body.command).toBe("get_portal_layout");
    await route.fulfill({ json: await commandNode!.invoke(body) });
    if (writes.length === 2) reconciled.add(route.request().frame().page());
  };
  try {
    commandNode = await startCommandNode(dataDir, token);
    const second = await context.newPage();
    for (const client of [page, second]) {
      await client.route("**/__fixture/sidebar-command-node", serveLayout);
      await client.goto("/repository-environment-list?ordering=manual&command-node");
      await expect(client.getByTestId("federated-repository-list")).toHaveAttribute(
        "data-ordering",
        "manual",
      );
    }
    await drag(page, grip(page, "desktop-smoke"), row(page, "sidebar-redesign"));
    await drag(second, grip(second, "pricing-page"), row(second, "blog-migration"));
    await expect(page.getByTestId("updates")).toContainText(ORK);
    await expect(second.getByTestId("updates")).toContainText("github.com/acme/website");
    expect(writes).toHaveLength(2);
    await expect.poll(() => reconciled.size).toBe(2);
    await commandNode.stop();
    commandNode = await startCommandNode(dataDir, token);
    for (const client of [page, second]) {
      await client.reload();
      await expect
        .poll(() => rowsOf(client, ORK))
        .toEqual([
          "desktop-smoke@mbp3",
          "sidebar-redesign@mini",
          "fix-merge-queue@mini",
          "release-notes@beelink",
          "perf-trace@mbp3",
        ]);
      await expect
        .poll(() => rowsOf(client, "github.com/acme/website"))
        .toEqual(["pricing-page@omarchy-gram", "blog-migration@mini"]);
      await expect(client.getByTestId("reorders")).toHaveText("[]");
    }
  } finally {
    releaseWrites();
    await commandNode?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function startCommandNode(dataDir: string, token: string) {
  const startupStages: string[] = [];
  const child = spawn(
    "bun",
    [
      "--no-env-file",
      "src/main.ts",
      "--data-dir",
      dataDir,
      "--runtime-flavor",
      "agent-test",
      "--command-node",
      "--host",
      "127.0.0.1",
      "--allow-non-tailscale-bind",
      "--port",
      "0",
      "--control-port",
      "0",
      "--loopback-client-port",
      "0",
    ],
    {
      cwd: path.resolve(import.meta.dirname, "../apps/backend"),
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "test",
        ORKESTRATOR_GATEWAY_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const input = createInterface({ input: child.stdout });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  };
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Command node did not become ready")),
        20_000,
      );
      const finish = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once("error", finish);
      void closed.then((code) =>
        finish(
          new Error(
            `Command node exited before readiness (${code}), startup stages: ${startupStages.join(", ")}`,
          ),
        ),
      );
      input.on("line", (line) => {
        if (!line.startsWith("{")) return;
        if (!line.includes('"orkestrator-backend-ready"')) {
          const startup = JSON.parse(line) as { phase?: string };
          if (startup.phase) startupStages.push(startup.phase);
          return;
        }
        const ready = JSON.parse(line) as { url: string };
        clearTimeout(timer);
        resolve(ready.url);
      });
    });
    return {
      stop,
      async invoke(body: { command: string; args?: unknown }): Promise<unknown> {
        const response = await fetch(new URL("/__orkestrator/invoke", origin), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            connection: "close",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
          throw new Error(`Command node refused ${body.command} (${response.status})`);
        return ((await response.json()) as { result: unknown }).result;
      },
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    input.close();
    child.stdout.resume();
  }
}

test("the chevron right of the + collapses and expands a repository", async ({
  page,
  hasTouch,
}) => {
  await page.goto("/repository-environment-list");
  const add = page.getByRole("button", {
    name: "New environment in acme/orkestrator-v2",
    exact: true,
  });
  const collapse = page.getByRole("button", {
    name: "Collapse project acme/orkestrator-v2",
    exact: true,
  });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  // Immediately right of the +, at the row's right edge.
  const addBox = (await add.boundingBox())!;
  const chevronBox = (await collapse.boundingBox())!;
  if (hasTouch) {
    for (const { width, height } of [addBox, chevronBox]) {
      expect(width).toBeGreaterThanOrEqual(40);
      expect(height).toBeGreaterThanOrEqual(40);
    }
  }
  expect(Math.abs(chevronBox.x - (addBox.x + addBox.width))).toBeLessThan(1);
  expect(Math.abs(chevronBox.y - addBox.y)).toBeLessThan(1);
  // Flush with the row's inner edge, inside its 1px border.
  const rowBox = (await collapse.locator("..").boundingBox())!;
  expect(Math.abs(rowBox.x + rowBox.width - 1 - (chevronBox.x + chevronBox.width))).toBeLessThan(1);

  const rows = folder(page, ORK).getByTestId("federated-environment-row");
  await expect(rows.first()).toBeVisible();
  await (hasTouch ? collapse.tap() : collapse.click());
  await expect(rows).toHaveCount(0);
  const expand = page.getByRole("button", {
    name: "Expand project acme/orkestrator-v2",
    exact: true,
  });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(heading(page, "acme/orkestrator-v2")).toBeVisible();
  await expect(add).toBeVisible();
  // The chevron neither opened the project nor created an environment.
  await expect(page.getByTestId("opened")).toHaveText("");
  await expect(page.getByTestId("intent")).toHaveText("");

  await page.reload();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(0);

  await (hasTouch ? expand.tap() : expand.click());
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(rows.first()).toBeVisible();

  await (hasTouch ? add.tap() : add.click());
  await expect(page.getByTestId("opened")).toHaveText("bk_mini");
  await expect(page.getByTestId("intent")).toContainText('"createEnvironmentProjectId":"ork"');
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(rows.first()).toBeVisible();
});

test("the repository chevron is flush right with its rows' changed-line counts", async ({
  page,
  hasTouch,
}) => {
  await page.goto("/repository-environment-list");
  const repository = folder(page, ORK);
  const chevron = repository.getByTestId("repository-collapse-toggle");
  const counts = repository.getByTestId("environment-change-counts");
  await expect(counts).toHaveCount(2);
  const edges = (locator: Locator) =>
    locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right };
    });
  // The heading's highlight spans its environment rows' frame on both sides.
  const headingFrame = await edges(chevron.locator(".."));
  const rowFrame = await edges(
    repository.getByTestId("federated-environment-row").first().locator("> div"),
  );
  expect(Math.abs(headingFrame.left - rowFrame.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(headingFrame.right - rowFrame.right)).toBeLessThanOrEqual(1);
  // A phone row ends in its actions button rather than its counts.
  if (hasTouch) return;
  // The chevron glyph (its path, rotated open) ends where the counts do.
  const glyph = await edges(chevron.locator("svg path"));
  for (const count of await counts.all()) {
    expect(Math.abs((await edges(count)).right - glyph.right)).toBeLessThanOrEqual(1);
  }
});

test("the repository chevron receives tab focus and toggles with Enter and Space", async ({
  page,
}) => {
  await page.goto("/repository-environment-list");
  const repository = folder(page, ORK);
  const add = repository.getByTestId("repository-new-environment");
  const chevron = repository.getByTestId("repository-collapse-toggle");
  const rows = repository.getByTestId("federated-environment-row");
  await heading(page, "acme/orkestrator-v2").focus();
  await page.keyboard.press("Tab");
  await expect(add).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(chevron).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(0);
  await expect(chevron).toBeFocused();

  await page.keyboard.press("Space");
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId("sidebar-drag-overlay")).toHaveCount(0);
  await expect(page.getByTestId("opened")).toHaveText("");
  await expect(page.getByTestId("intent")).toHaveText("");
});
