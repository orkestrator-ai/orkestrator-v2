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

/** Each face row's name, text and box, top to bottom, plus whether the title is cut short. */
async function face(page: Page, title: string) {
  return node(page, title).evaluate((element) => {
    const titleElement = element.querySelector<HTMLElement>("[data-flow-node-title]")!;
    return {
      box: element.getBoundingClientRect().toJSON() as Box,
      rows: [...element.querySelectorAll<HTMLElement>("[data-flow-node-row]")].map((row) => ({
        name: row.getAttribute("data-flow-node-row")!,
        text: row.textContent ?? "",
        box: row.getBoundingClientRect().toJSON() as Box,
      })),
      titleTruncated: titleElement.scrollWidth > titleElement.clientWidth,
    };
  });
}

/**
 * Every edge leaves a node's right edge and enters another's left edge at
 * the node's vertical centre, so a taller node still meets its edges square.
 */
async function edgeEndsMeetNodeCentres(page: Page): Promise<string[]> {
  return graph(page).evaluate((canvas) => {
    const origin = canvas.getBoundingClientRect();
    const rects = [...canvas.querySelectorAll<HTMLElement>('[role="tab"]')].map((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left - origin.left,
        right: box.right - origin.left,
        centre: box.top - origin.top + box.height / 2,
      };
    });
    const misses: string[] = [];
    for (const path of canvas.querySelectorAll<SVGPathElement>("path[data-flow-edge]")) {
      const numbers = (path.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)!.map(Number);
      const [x1, y1] = numbers;
      const [x2, y2] = numbers.slice(-2);
      const near = (a: number, b: number) => Math.abs(a - b) <= 1;
      if (!rects.some((rect) => near(rect.right, x1!) && near(rect.centre, y1!)))
        misses.push(`${path.dataset.flowEdge} start`);
      if (!rects.some((rect) => near(rect.left, x2!) && near(rect.centre, y2!)))
        misses.push(`${path.dataset.flowEdge} end`);
    }
    return misses;
  });
}

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

test("the Ticket labels its start separately from runtime and retains it after reload", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=loops");
  const ticket = node(page, "Ticket");
  const start = ticket.locator('time[data-flow-node-row="start"]');
  await expect(start).toHaveText(/^Started /);
  const text = await start.textContent();
  await expect(ticket).toHaveAccessibleName(`Ticket, Started with, ${text}`);
  await expect(ticket.locator('[data-flow-node-row="runtime"]')).toHaveCount(0);
  expect((await face(page, "Ticket")).rows.map((row) => row.name)).toEqual([
    "title",
    "detail",
    "start",
  ]);
  expect(overlapping(await boxes(page))).toBe(0);
  if (isWide(page)) expect(await edgeEndsMeetNodeCentres(page)).toEqual([]);
  await page.reload();
  await expect(start).toHaveText(text!);
  await expect(ticket).toHaveAccessibleName(`Ticket, Started with, ${text}`);
});

test("shows the reviewer fan-out as Multi Review does", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  await expect(node(page, "Reviewer 1")).toHaveAttribute("data-flow-state", "running");
  await expect(node(page, "Reviewer 3")).toContainText("queued · #1 of 1");
  await expect(node(page, "Reviewer 4")).toContainText("starting");
  const failed = node(page, "Reviewer 2");
  await expect(failed).toHaveAttribute("data-flow-state", "failed");
  // The first line of the error on the node; the whole text in its tooltip.
  await expect(failed.locator("[data-flow-node-error]")).toHaveText(
    "Reviewer process exited with code 137",
  );
  await expect(failed).toHaveAccessibleDescription(
    "Reviewer process exited with code 137 Out of memory while reading the package",
  );
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
  await expect(ticket.getByRole("region", { name: "Summary" })).toContainText("Multi Review");
  await expect(ticket.getByRole("region", { name: "Summary" }).locator("strong")).toHaveText(
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

test("the Ticket inspector tiles the ticket's sections and stacks them when narrow", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=ticket-tiles");
  await node(page, "Ticket").click();
  const grid = page.getByTestId("ticket-sections-grid");
  await expect(grid).toBeVisible();
  const tiles = grid.locator("section");
  await expect(tiles).toHaveText([
    /Summary/,
    /Problem/,
    /Context/,
    /Constraints/,
    /Acceptance criteria/,
    /Delivery/,
    /Rollout/,
  ]);
  await expect(page.getByTestId("ticket-delivery-policy")).toHaveText(
    "Push, no PR (Multi Review next)",
  );
  // The newest Verify's ticks, on the inspector and the node face.
  const criteria = grid.getByTestId("ticket-criterion");
  await expect(criteria).toHaveCount(2);
  await expect(criteria.nth(0)).toHaveAttribute("data-status", "passed");
  await expect(criteria.nth(1)).toHaveAttribute("data-status", "not-checked");
  await expect(criteria.nth(1)).toContainText("Needs a real phone.");
  await expect(page.getByTestId("ticket-criteria-tally")).toHaveText("1/2 passed · 1 not checked");
  await expect(page.getByTestId("pipeline-ticket-verify-round")).toContainText("round 2");
  await expect(node(page, "Ticket")).toContainText("1/2 criteria");
  const layout = await grid.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    tiles: [...element.querySelectorAll("section")].map((tile) =>
      tile.getBoundingClientRect().toJSON(),
    ) as Box[],
  }));
  const problem = layout.tiles[1]!;
  const context = layout.tiles[2]!;
  // 36rem is the container width at which tiles go side by side.
  if (layout.width >= 576) {
    expect(Math.abs(problem.y - context.y)).toBeLessThan(1);
    expect(context.x).toBeGreaterThan(problem.x);
  } else {
    expect(context.y).toBeGreaterThanOrEqual(problem.y + problem.height);
  }
  for (const tile of layout.tiles) {
    expect(tile.x + tile.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
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

test("an expanded previous attempt keeps the live line beside every superseded step", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=rewound-loop");
  await node(page, "Previous attempt").click();
  await page.getByTestId("pipeline-inspector").getByRole("button", { name: "Show steps" }).click();
  // The attempt's own node stays, followed by its steps.
  const superseded = [
    "Previous attempt",
    "Verify · round 1",
    "Fix · round 2",
    "Review · round 2",
    "Verify · round 2",
  ];
  for (const title of superseded) await expect(node(page, title)).toBeVisible();
  if (isWide(page)) {
    // The wide graph routes the live line over the attempt in one bypass edge.
    await expect(
      graph(page).locator('path[data-flow-edge="review->verify-1-rerun"]'),
    ).toBeAttached();
    return;
  }
  // Stacked: each consecutive superseded step draws its own bypass beside it,
  // from the step the restart rewound to, without covering the node.
  const bypasses = page.locator('[data-flow-layout="stacked"] div[data-flow-edge^="bypass-"]');
  await expect(bypasses).toHaveCount(superseded.length);
  for (const [index, title] of superseded.entries()) {
    const nodeBox = (await node(page, title).boundingBox())!;
    const bypass = bypasses.nth(index);
    await expect(bypass).toHaveAttribute("data-flow-source", "review");
    const box = (await bypass.boundingBox())!;
    // Spans the node's height and runs past its right edge.
    expect(box.y).toBeLessThanOrEqual(nodeBox.y);
    expect(box.y + box.height).toBeGreaterThanOrEqual(nodeBox.y + nodeBox.height);
    expect(box.x + box.width).toBeGreaterThan(nodeBox.x + nodeBox.width);
  }
  expect(overlapping(await boxes(page))).toBe(0);
});

test("rewinding code names the dropped commits before it resets anything", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=code-rewind");
  await node(page, "Build").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Prepare package again" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__pipelineCommands?.find((entry) => entry.command === "restart_build_pipeline_step"),
      ),
    )
    .toMatchObject({ args: { stageId: "review-package:build" } });

  await node(page, "Build").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rewind code to here…" }).click();
  const dialog = page.getByTestId("pipeline-code-rewind-dialog");
  await expect(dialog.getByTestId("pipeline-code-rewind-commits")).toContainText(
    "fix: address the review",
  );
  await expect(dialog).toContainText("origin/flow already has 2 commits");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__pipelineCommands?.some((entry) => entry.command === "rewind_build_pipeline_code"),
      ),
    )
    .toBe(false);
  await dialog.getByRole("button", { name: "Drop 2 commits and restart" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__pipelineCommands?.find((entry) => entry.command === "rewind_build_pipeline_code"),
      ),
    )
    .toMatchObject({ args: { stageId: "build", expectedHead: "c".repeat(40) } });
});

test("collapses the graph so the inspector takes the room", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  const toggle = page.getByRole("button", { name: "Pipeline", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("tabpanel", { name: /^Reviewer 1,/ })).toBeVisible();
  const before = (await page.getByTestId("pipeline-inspector").boundingBox())!;
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(graph(page)).toHaveCount(0);
  await expect(page.getByRole("tabpanel", { name: "Reviewer 1", exact: true })).toBeVisible();
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

async function openReviewPass(page: Page) {
  await node(page, "Reviewer 1").click();
  await page
    .getByTestId("pipeline-inspector")
    .getByRole("button", { name: "Open review as Multi Review" })
    .click();
  await expect(page.getByTestId("pipeline-review-header")).toBeVisible();
  await expect(node(page, "Build")).toHaveCount(0);
}

test("failed standalone review retains its reason and accessible inspector when collapsed", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=failed-review");
  await openReviewPass(page);
  await node(page, "Consolidation").click();
  const inspector = page.getByTestId("pipeline-inspector");
  await expect(page.getByRole("tabpanel", { name: /^Consolidation,/ })).toBeVisible();
  await expect(inspector).toContainText("Consolidation could not read the review package");
  await expect(inspector.getByRole("button", { name: "Retry failed step" })).toBeEnabled();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Consolidation", exact: true })).toBeVisible();
  await expect(inspector).toContainText("Consolidation could not read the review package");
  await expect(inspector.getByRole("button", { name: "Retry failed step" })).toBeEnabled();
});

test("a mounted pipeline-pass tab retains lifecycle controls with its graph collapsed", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  await openReviewPass(page);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(graph(page)).toHaveCount(0);
  const inspector = page.getByTestId("pipeline-inspector");
  await inspector.getByRole("button", { name: "Pause pipeline" }).click();
  await expect(inspector.getByRole("button", { name: "Resume pipeline" })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Cancel pipeline" })).toBeVisible();
  await inspector.getByRole("button", { name: "Resume pipeline" }).click();
  await expect(inspector.getByRole("button", { name: "Pause pipeline" })).toBeVisible();
  await inspector.getByRole("button", { name: "Cancel pipeline" }).click();
  await expect(inspector.getByRole("button", { name: "Pause pipeline" })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "Cancel pipeline" })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.__pipelineCommands
        ?.filter((entry) => /^(pause|resume|cancel)_build_pipeline$/.test(entry.command))
        .map((entry) => entry.command),
    ),
  ).toEqual(["pause_build_pipeline", "resume_build_pipeline", "cancel_build_pipeline"]);
});

test("a review pass rehydrates progress missed while inactive and after reload", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=fanout");
  await openReviewPass(page);
  await page.getByRole("button", { name: "Switch away" }).click();
  await page.getByRole("button", { name: "Finish in background" }).click();
  await page.getByRole("button", { name: "Return to review" }).click();
  await expect(node(page, "Reviewer 1")).toHaveAttribute("data-flow-state", "complete");
  await node(page, "Reviewer 1").click();
  await expect(page.getByTestId("pipeline-inspector")).toContainText("Finished while inactive.");
  expect(
    await page.evaluate(() =>
      window.__pipelineCommands?.some((entry) => entry.command === "get_build_pipeline"),
    ),
  ).toBe(true);
  await page.goto("/pipeline-flow?scenario=fanout&restore=1");
  await page.reload();
  await expect(page.getByTestId("pipeline-review-header")).toBeVisible();
  await expect(node(page, "Reviewer 1")).toHaveAttribute("data-flow-state", "complete");
  await node(page, "Reviewer 1").click();
  await expect(page.getByTestId("pipeline-inspector")).toContainText("Finished while inactive.");
});

test("remote review passes retain their provider session and route controls to the workspace", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=fanout&remote=1");
  await openReviewPass(page);
  await node(page, "Reviewer 2").dblclick();
  expect(await page.evaluate(() => window.__openedTabs?.at(-1))).toMatchObject({
    type: "codex",
    options: {
      resumeSessionId: "remote-rev-2-session",
      requireExistingResumeSession: true,
      isReviewTab: true,
    },
  });
  await page
    .getByTestId("pipeline-inspector")
    .getByRole("button", { name: "Retry reviewer" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__pipelineCommands?.filter(
          (entry) => entry.command === "retry_build_pipeline_reviewer",
        ),
      ),
    )
    .toEqual([
      {
        command: "retry_build_pipeline_reviewer",
        args: { pipelineId: "remote-pipeline", reviewerId: "r2" },
      },
    ]);
});

test("ticket references show BMP and SVG images, preview, and the changed indicator", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=images");
  await node(page, "Ticket").click();
  const ticket = page.getByTestId("pipeline-ticket");
  await expect(page.getByTestId("pipeline-ticket-changed")).toBeVisible();
  await expect(ticket.getByRole("img")).toHaveCount(2);
  for (const filename of ["reference.svg", "reference.bmp"]) {
    await ticket.getByRole("button", { name: `Show image ${filename}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("img", { name: filename })).toBeVisible();
    await expect
      .poll(() =>
        dialog
          .getByRole("img", { name: filename })
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
});

test("a running node keeps its whole title above its model and its clock", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=building");
  const build = node(page, "Build");
  await expect(build).toHaveAttribute("data-flow-state", "running");
  await expect(build.getByLabel("Build runtime and token usage")).toHaveText(
    /^\d+m \d+s · 48k tokens$/,
  );
  const { box, rows, titleTruncated } = await face(page, "Build");
  expect(rows.map((row) => row.name)).toEqual(["title", "detail", "runtime"]);
  expect(rows[0]!.text).toBe("Build");
  expect(titleTruncated).toBe(false);
  expect(rows[1]!.text).toBe("claude · opus · high");
  expect(rows[2]!.text).toMatch(/^\d+m \d+s · 48k tokensrunning$/);
  // Three rows, top to bottom, inside the node.
  for (const [index, row] of rows.entries()) {
    expect(row.box.y).toBeGreaterThanOrEqual(box.y);
    expect(row.box.y + row.box.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
    if (index > 0) {
      const above = rows[index - 1]!.box;
      expect(row.box.y).toBeGreaterThanOrEqual(above.y + above.height - 0.5);
    }
  }
  // Steps ahead keep two rows, with their badge beside a whole title.
  const verify = await face(page, "Verify");
  expect(verify.rows.map((row) => [row.name, row.text])).toEqual([
    ["title", "Verifyahead"],
    ["detail", "claude · Provider default"],
  ]);
  expect(verify.titleTruncated).toBe(false);
  expect(verify.box.height).toBeLessThan(box.height);
  // Node widths stay one size, whatever the face holds.
  expect(Math.abs(verify.box.width - box.width)).toBeLessThanOrEqual(1);
  expect(overlapping(await boxes(page))).toBe(0);
  if (isWide(page)) expect(await edgeEndsMeetNodeCentres(page)).toEqual([]);
});

test("a running node whose provider has not reported usage shows a dash", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=building&usage=none");
  const build = node(page, "Build");
  await expect(build.getByLabel("Build runtime and token usage")).toHaveText(/^\d+m \d+s · —$/);
  await expect(page.getByText("Tokens pending")).toHaveCount(0);
});

test("finished and running nodes share one face, and edges meet every node's centre", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=loops");
  const build = await face(page, "Build");
  expect(build.rows.map((row) => [row.name, row.text])).toEqual([
    ["title", "Build"],
    ["detail", "claude · opus"],
    ["runtime", "10m 0s"],
  ]);
  expect(overlapping(await boxes(page))).toBe(0);
  if (isWide(page)) expect(await edgeEndsMeetNodeCentres(page)).toEqual([]);

  await page.goto("/pipeline-flow?scenario=fanout");
  // Reviewers of mixed heights: running and failed ones have a runtime row,
  // queued ones do not.
  const running = await face(page, "Reviewer 1");
  const queued = await face(page, "Reviewer 3");
  expect(running.rows.map((row) => row.name)).toEqual(["title", "detail", "runtime"]);
  expect(queued.rows.map((row) => row.name)).toEqual(["title", "detail"]);
  expect(running.titleTruncated).toBe(false);
  expect(overlapping(await boxes(page))).toBe(0);
  if (isWide(page)) expect(await edgeEndsMeetNodeCentres(page)).toEqual([]);
});

test("running package validation keeps Prepare and its display clock live", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=validation");
  const prepare = node(page, "Prepare");
  await expect(prepare).toHaveAttribute("data-flow-state", "running");
  const runtime = prepare.getByLabel("Prepare runtime and token usage");
  const before = await runtime.textContent();
  await expect.poll(() => runtime.textContent()).not.toBe(before);
});

test("Fit zooms the whole pipeline into view", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=loops");
  const controls = page.getByRole("group", { name: "Zoom" });
  const level = page.getByTestId("pipeline-zoom-level");
  const zoomIn = controls.getByRole("button", { name: "Zoom in" });
  while (await zoomIn.isEnabled()) await zoomIn.click();
  await expect(level).toHaveText("200%");
  await controls.getByRole("button", { name: "Fit the whole pipeline" }).click();
  await expect
    .poll(async () => Number.parseInt((await level.textContent()) ?? "", 10))
    .toBeLessThanOrEqual(100);
  // Every node is in view: inside the graph's viewport, or for the stacked
  // column, inside the page.
  const frame = isWide(page)
    ? await page.locator("[data-flow-viewport]").evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      })
    : { x: 0, y: 0, ...page.viewportSize()! };
  await expect
    .poll(async () =>
      (await boxes(page)).every(
        (box) =>
          box.x >= frame.x - 1 &&
          box.y >= frame.y - 1 &&
          box.x + box.width <= frame.x + frame.width + 1 &&
          box.y + box.height <= frame.y + frame.height + 1,
      ),
    )
    .toBe(true);
  await level.click();
  await expect(level).toHaveText("100%");
});

test("split pipeline panes give find and shell selection to the focused pane", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/pipeline-flow?scenario=fanout&split");
  const panes = page.locator("[data-pane-leaf]");
  await expect(panes).toHaveCount(2);
  const buildPane = panes.nth(0);
  const reviewPane = panes.nth(1);
  const selectedSession = page.getByRole("status", { name: "Shell selected session" });
  await expect(reviewPane.getByTestId("pipeline-review-header")).toBeVisible();
  await buildPane.getByRole("tab", { name: /^Build,/ }).click();
  await expect(selectedSession).toHaveText("build-session");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+f`);
  await expect(buildPane.getByRole("textbox", { name: "Find in chat" })).toBeFocused();
  await expect(reviewPane.getByRole("textbox", { name: "Find in chat" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await reviewPane.getByRole("tab", { name: /^Reviewer 1,/ }).click();
  await expect(selectedSession).toHaveText("rev-1-session");
  await page.keyboard.press(`${modifier}+f`);
  await expect(reviewPane.getByRole("textbox", { name: "Find in chat" })).toBeFocused();
  await expect(buildPane.getByRole("textbox", { name: "Find in chat" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Focus alone republishes the Build pane's independently pinned selection.
  await buildPane.getByRole("tab", { name: /^Build,/ }).click();
  await expect(selectedSession).toHaveText("build-session");
});

test("nested rewind history retains every transcript and validation across reload", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=nested-rewinds");
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(graph(page).locator('[data-flow-node="attempt"]')).toHaveCount(2);
    await node(page, "Previous attempt").click();
    for (const label of ["outer-build label", "outer-review label"]) {
      await page.getByRole("button", { name: `${label} · round 1`, exact: true }).click();
      await expect(
        page.getByText(`Transcript of ${label.replace(" label", "")}.`, { exact: true }),
      ).toBeVisible();
      await node(page, "Previous attempt").click();
    }
    await node(page, "Previous attempt 2").click();
    for (const [index, key] of ["review-failed", "review-retry"].entries()) {
      await page
        .getByRole("button", { name: "Review 1 · round 1", exact: true })
        .nth(index)
        .click();
      await expect(page.getByText(`Transcript of ${key}.`, { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Restart from here", exact: true }),
      ).toHaveCount(0);
      await node(page, "Previous attempt 2").click();
    }
    await page.getByRole("button", { name: "Validation", exact: true }).click();
    await expect(page.getByText("Retained validation failure", { exact: true })).toBeVisible();
    expect(overlapping(await boxes(page))).toBe(0);
  }
});

test("retained validation stays read-only beside its live replacement after reload", async ({
  page,
}) => {
  await page.goto("/pipeline-flow?scenario=validation-rewind");
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await node(page, "Previous attempt").click();
    await page.getByRole("button", { name: "Validation", exact: true }).click();
    await expect(page.getByText("Retained validation failure", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restart validation", exact: true })).toHaveCount(
      0,
    );
    await node(page, "Validation").click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Restart validation", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await node(page, "Prepare").click();
    await page.getByRole("button", { name: "Restart validation", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__pipelineCommands
              ?.filter((entry) => entry.command === "restart_build_pipeline_step")
              .at(-1)?.args,
        ),
      )
      .toEqual({ pipelineId: "flow-pipeline", stageId: "validation:replacement-validation" });
  }
});

test("validation-only history keeps the replacement reviewer panel together", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=review-after-validation-rewind");
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(node(page, "Reviewer 1")).toHaveCount(1);
    await expect(node(page, "Reviewer 2")).toHaveCount(1);
    const titles = await graph(page)
      .getByRole("tab")
      .evaluateAll((nodes) =>
        nodes.map((element) => element.getAttribute("aria-label")!.split(",")[0]),
      );
    expect(titles.indexOf("Previous attempt")).toBeLessThan(titles.indexOf("Reviewer 1"));
    for (const slot of [1, 2]) {
      await node(page, `Reviewer ${slot}`).click();
      await expect(page.getByText(`Transcript of rev-${slot}.`, { exact: true })).toBeVisible();
    }
    expect(overlapping(await boxes(page))).toBe(0);
  }
});

test("archived Prepare checks and its read-only Tests view survive reload", async ({ page }) => {
  await page.goto("/pipeline-flow?scenario=validation-history");
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    const older = node(page, "Prepare");
    await expect(older).toHaveAttribute("data-flow-state", "failed");
    await expect(older.getByTitle("old-test: failed")).toBeVisible();
    await expect(older.getByTitle("old-lint: passed")).toBeVisible();
    await expect(node(page, "Prepare 2").getByTitle("test: passed")).toBeVisible();
    await older.click();
    const inspector = page.getByTestId("pipeline-inspector");
    await inspector.getByRole("tab", { name: "Tests", exact: true }).click();
    const commands = inspector.getByRole("table", { name: "Validation commands" });
    await expect(commands.getByText("mise run old-test", { exact: true })).toBeVisible();
    await expect(commands.getByText("mise run old-lint", { exact: true })).toBeVisible();
    await inspector
      .locator("summary")
      .filter({ hasText: /^Notes$/ })
      .click();
    await expect(
      inspector.getByText(
        "An earlier pass's run: its results are kept, its command output is not.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      inspector.getByRole("button", {
        name: /Stop command|Restart validation|Skip validation|Retry failed step/,
      }),
    ).toHaveCount(0);
    expect(overlapping(await boxes(page))).toBe(0);
    expect(
      await page.evaluate(() =>
        window.__pipelineCommands?.filter((entry) =>
          /retry|restart|skip|stop|get_review_validation_output/.test(entry.command),
        ),
      ),
    ).toEqual([]);
  }
});
