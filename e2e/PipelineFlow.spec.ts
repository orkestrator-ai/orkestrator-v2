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
