import { expect, test, type Page } from "@playwright/test";

type Box = { x: number; y: number; width: number; height: number };

function graph(page: Page) {
  return page.getByRole("tablist", { name: "Build pipeline" });
}

function node(page: Page, title: string) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return graph(page).getByRole("tab", { name: new RegExp(`^${escaped},`) });
}

async function boxes(page: Page): Promise<Box[]> {
  return graph(page)
    .getByRole("tab")
    .evaluateAll((nodes) =>
      nodes.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
}

function overlapping(list: Box[]): number {
  let pairs = 0;
  list.forEach((a, i) =>
    list.slice(i + 1).forEach((b) => {
      if (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      )
        pairs += 1;
    }),
  );
  return pairs;
}

const isWide = (page: Page) => page.viewportSize()!.width >= 960;

test("draws the pipeline left to right, with definite steps ahead and faded", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  await expect(graph(page).getByRole("tab")).toHaveCount(12);
  expect(overlapping(await boxes(page))).toBe(0);
  const layout = await page.locator("[data-flow-layout]").getAttribute("data-flow-layout");
  expect(layout).toBe(isWide(page) ? "graph" : "stacked");
  // Ticket and Setup first; Verify, Ship and the PR ahead as placeholders.
  const titles = await graph(page)
    .getByRole("tab")
    .evaluateAll((nodes) =>
      nodes.map((element) => element.getAttribute("aria-label")!.split(",")[0]),
    );
  expect(titles).toEqual([
    "Ticket",
    "Setup",
    "Build",
    "Prepare",
    "Reviewer 1",
    "Reviewer 2",
    "Reviewer 3",
    "Reviewer 4",
    "Consolidation",
    "Verify",
    "Ship",
    "PR",
  ]);
  for (const title of ["Consolidation", "Verify", "Ship", "PR"]) {
    await expect(node(page, title)).toHaveAttribute("data-flow-placeholder", "");
  }
  // Address and Fix only sometimes run, so nothing stands for them ahead.
  await expect(
    graph(page).locator('[data-flow-node="address"], [data-flow-node="fix"]'),
  ).toHaveCount(0);
  await expect(node(page, "Reviewer 1")).not.toHaveAttribute("data-flow-placeholder", "");
});

test("shows the reviewer fan-out as Multi Review does", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  await expect(node(page, "Reviewer 1")).toHaveAttribute("data-flow-state", "running");
  await expect(node(page, "Reviewer 3")).toContainText("queued · #1 of 1");
  await expect(node(page, "Reviewer 4")).toContainText("starting");
  const failed = node(page, "Reviewer 2");
  await expect(failed).toHaveAttribute("data-flow-state", "failed");
  // The first line of the error on the node; the whole text in its tooltip.
  await expect(failed.locator("[data-flow-node-error]")).toContainText("exited with code 137");
  await failed.hover();
  await expect(page.getByTestId("pipeline-node-error-tooltip")).toContainText(
    "Out of memory while reading the package",
  );
  await expect(node(page, "Reviewer 1")).toContainText("claude · opus");
  if (isWide(page)) {
    await expect(page.locator('path[data-flow-edge][data-edge-state="active"]')).toHaveCount(1);
  }
});

test("unrolls repeated passes to the right instead of looping back", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=loops");
  const titles = await graph(page)
    .getByRole("tab")
    .evaluateAll((nodes) =>
      nodes.map((element) => element.getAttribute("aria-label")!.split(",")[0]),
    );
  expect(titles).toEqual([
    "Ticket",
    "Setup",
    "Build",
    "Review",
    "Address",
    "Verify",
    "Fix",
    "Review 2",
    "Verify 2",
    "Ship",
    "Resolve conflicts",
    "PR",
  ]);
  const list = await boxes(page);
  expect(overlapping(list)).toBe(0);
  for (let index = 1; index < list.length; index += 1) {
    if (isWide(page)) expect(list[index]!.x).toBeGreaterThan(list[index - 1]!.x);
    else expect(list[index]!.y).toBeGreaterThan(list[index - 1]!.y);
  }
  // A finished pipeline has nothing ahead.
  await expect(graph(page).locator("[data-flow-placeholder]")).toHaveCount(0);
  // Review shows its issue counts.
  await expect(node(page, "Review")).toContainText("2");
});

test("selects the running step on arrival and a node on a click", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  await expect(node(page, "Reviewer 1")).toHaveAttribute("aria-selected", "true");
  const inspector = page.getByTestId("pipeline-inspector");
  await expect(inspector).toContainText("Transcript of rev-1.");
  await node(page, "Build").click();
  await expect(node(page, "Build")).toHaveAttribute("aria-selected", "true");
  await expect(inspector).toHaveAttribute(
    "aria-labelledby",
    (await node(page, "Build").getAttribute("id"))!,
  );
  await expect(inspector).toContainText("Transcript of build.");
  // Messages go to the running stage only.
  await expect(page.getByRole("textbox", { name: "Send a message to the agent" })).toHaveCount(0);
});

test("double-clicking a step opens its session in a tab of its own", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  await node(page, "Build").dblclick();
  const opened = await page.evaluate(() => window.__openedTabs);
  expect(opened).toHaveLength(1);
  expect(opened![0]!.options).toMatchObject({
    resumeSessionId: "build-session",
    requireExistingResumeSession: true,
  });
});

test("shows the ticket the pipeline started with, never the prompt", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  await node(page, "Ticket").click();
  const ticket = page.getByTestId("pipeline-ticket");
  await expect(ticket.getByRole("heading", { name: "Build pipeline flow graph" })).toBeVisible();
  await expect(ticket.getByRole("region", { name: "Description" })).toContainText("Multi Review");
  await expect(ticket.getByRole("region", { name: "Description" }).locator("strong")).toHaveText(
    "Multi Review",
  );
  await expect(ticket.getByRole("region", { name: "Acceptance criteria" })).toContainText(
    "Inspector below",
  );
  await expect(ticket.getByRole("region", { name: /Comments/ })).toContainText("mobile");
  // No images were attached, so that section is left out.
  await expect(ticket.getByRole("region", { name: /Reference images/ })).toHaveCount(0);
  await expect(page.getByText("You are building a feature")).toHaveCount(0);
});

test("the PR node shows the link, its state and CI checks", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=loops");
  const pr = node(page, "PR");
  await expect(pr).toContainText("acme/app/pull/42");
  await expect(pr.locator("[data-pr-checks]")).toHaveAttribute("data-pr-checks", "failing");
  await expect(pr).toContainText("CI failing · 2/4");
  await pr.click();
  await expect(page.getByTestId("pipeline-pr-state")).toHaveText("Open");
  await expect(page.getByTestId("pipeline-pr-checks")).toHaveText(
    "2 of 4 checks passed · 1 failing · 1 pending",
  );
});

test("node actions run from the context menu and the inspector", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  await node(page, "Reviewer 2").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Retry reviewer" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__pipelineCommands?.map((entry) => entry.command)))
    .toContain("retry_build_pipeline_reviewer");
  await expect(node(page, "Reviewer 2")).toHaveAttribute("data-flow-state", "not-started");

  await node(page, "Build").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open session" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Cancel pipeline" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Pause pipeline" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__pipelineCommands?.map((entry) => entry.command)))
    .toContain("pause_build_pipeline");

  await node(page, "Reviewer 1").click();
  await page
    .getByTestId("pipeline-inspector")
    .getByRole("button", { name: "Open review as Multi Review" })
    .click();
  const opened = await page.evaluate(() => window.__openedTabs);
  expect(opened!.at(-1)).toMatchObject({
    type: "multi-review",
    options: { multiReviewId: "flow-pipeline" },
  });
});

test("collapses the graph so the inspector takes the room", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  const toggle = page.getByRole("button", { name: "Pipeline" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const before = (await page.getByTestId("pipeline-inspector").boundingBox())!;
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(graph(page)).toHaveCount(0);
  const after = (await page.getByTestId("pipeline-inspector").boundingBox())!;
  expect(after.y).toBeLessThan(before.y);
  await toggle.click();
  await expect(graph(page).getByRole("tab")).toHaveCount(12);
});

test("a new pipeline shows its setup running", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=new");
  await expect(node(page, "Setup")).toHaveAttribute("data-flow-state", "running");
  await expect(node(page, "Setup")).toHaveAttribute("aria-selected", "true");
  await expect(graph(page).locator("[data-flow-placeholder]")).toHaveCount(5);
});
