import { expect, test } from "@playwright/test";

test("a workflow card keeps its name and lists its agents inside it", async ({
  page,
}, testInfo) => {
  await page.goto("/workflow-agents");
  const card = page.getByRole("button", { name: /^Workflow Build investor Discover/ });
  await expect(card).toBeVisible();
  // One card: the workflow's agents are not cards of their own.
  await expect(page.locator("[data-background-task-id]")).toHaveCount(1);
  await expect(
    page.getByText("3 running · 1 queued · 1/5 done — Build: introductions"),
  ).toBeVisible();

  const title = card.getByText(/^Build investor Discover/);
  const titleBounds = await title.boundingBox();
  expect(titleBounds?.width).toBeGreaterThan(100);
  const root = page.locator("[data-background-task-id]");
  if (process.env.WORKFLOW_AGENTS_CAPTURE === "1") {
    await root.screenshot({
      path: `output/visual-previews/workflow-review-running-collapsed-${testInfo.project.name}.png`,
    });
  }

  await card.focus();
  await page.keyboard.press("Enter");
  const agents = page.getByRole("region", { name: "5 workflow agents" });
  await expect(agents).toBeVisible();
  await expect(agents.getByRole("listitem")).toHaveCount(5);
  await expect(
    agents.getByText("Editing src/components/discover/info-request-section.tsx"),
  ).toBeVisible();
  await expect(agents.getByText("Using Read")).toBeVisible();
  await expect(agents.getByText("Explore", { exact: true })).toBeVisible();
  await expect(agents.getByText("workflow-subagent", { exact: true })).toHaveCount(0);
  const phase = agents.getByText("Foundations", { exact: true });
  if (testInfo.project.name.startsWith("mobile")) {
    await expect(phase).toBeHidden();
  } else {
    await expect(phase).toBeVisible();
  }
  if (process.env.WORKFLOW_AGENTS_CAPTURE === "1") {
    await root.screenshot({
      path: `output/visual-previews/workflow-review-running-expanded-${testInfo.project.name}.png`,
    });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("the launch keeps one workflow card and its agent outcomes after settlement and reload", async ({
  page,
}, testInfo) => {
  await page.goto("/workflow-agents");
  const root = page.locator("[data-background-task-id]");
  await expect(root).toHaveAttribute("data-background-task-status", "running");
  await page.getByRole("button", { name: "Settle workflow" }).click();
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(root).toHaveCount(1);
    await expect(root).toHaveAttribute("data-background-task-status", "killed");
    const card = page.getByRole("button", { name: /^Workflow Build investor Discover/ });
    await expect(card).toBeVisible();
    if (!reload && process.env.WORKFLOW_AGENTS_CAPTURE === "1") {
      await root.screenshot({
        path: `output/visual-previews/workflow-review-stopped-collapsed-${testInfo.project.name}.png`,
      });
    }
    await card.focus();
    await card.press("Enter");
    await expect(card).toHaveAttribute("aria-expanded", "true");
    const agents = page.getByRole("region", { name: "3 workflow agents" });
    const stopped = agents.locator('[data-workflow-agent-status="stopped"]');
    await expect(stopped.getByText("Workflow stopped before this agent finished")).toBeVisible();
    await expect(stopped.getByTitle("0 tool uses")).toBeVisible();
    await expect(stopped.getByTitle("0 tokens")).toBeVisible();
    await expect(agents.getByText("Fixture check failed")).toBeVisible();
    await expect(agents.getByText(/ active$/)).toHaveCount(0);
    await expect(root.getByText(/Workflow launched in background/)).toHaveCount(0);
    if (reload && process.env.WORKFLOW_AGENTS_CAPTURE === "1") {
      await root.screenshot({
        path: `output/visual-previews/workflow-review-stopped-expanded-${testInfo.project.name}.png`,
      });
    }
  }
});
