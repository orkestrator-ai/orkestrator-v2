/**
 * Agent Capabilities in the browser: the plan's UI journeys and an
 * accessibility pass over Settings → Capabilities, the agent information
 * panel's capability section, the project and environment cards and a graph
 * agent node's Toolkits section, against the in-memory `capabilities` domain
 * in `fixture/CapabilitiesFixture.tsx`
 * (docs/architecture/agent-capabilities-management.md).
 *
 * Both projects run every test: 390×844 with touch (phone) and 1024×900.
 * The repository has no axe-core, so the automated checks are Chromium's
 * accessibility tree (role queries and `ariaSnapshot`, where an unnamed
 * control shows as a bare role), focus tracking and layout geometry. This is
 * not a screen-reader pass.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

type FixtureCall = { command: string; args: Record<string, unknown> };

async function calls(page: Page, command: string): Promise<FixtureCall[]> {
  return page.evaluate(
    (name) => (window.capabilityFixtureCalls ?? []).filter((call) => call.command === name),
    command,
  );
}

/** Controls the accessibility tree exposes without a name. */
async function unnamedControls(scope: Locator): Promise<string[]> {
  const snapshot = await scope.ariaSnapshot();
  return snapshot
    .split("\n")
    .filter((line) =>
      /^\s*- (button|checkbox|textbox|combobox|link|radio|switch|tab|region|dialog)\s*(\[.*\])?:?\s*$/.test(
        line,
      ),
    );
}

/**
 * Elements that stick out past the right edge of the viewport without a
 * scrolling (or clipping) ancestor that keeps them inside it, plus any
 * horizontal scroll of the page itself.
 */
async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const offenders: string[] = [];
    if (document.scrollingElement && document.scrollingElement.scrollWidth > width + 1) {
      offenders.push(`page scrolls sideways: ${document.scrollingElement.scrollWidth} > ${width}`);
    }
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.right <= width + 1) continue;
      let contained = false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX !== "visible" && parent.getBoundingClientRect().right <= width + 1) {
          contained = true;
          break;
        }
      }
      if (!contained) {
        offenders.push(
          `${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 60)} right=${Math.round(rect.right)} "${(element.textContent ?? "").trim().slice(0, 40)}"`,
        );
      }
    }
    return offenders;
  });
}

/** Presses Tab (or Shift+Tab) until `target` has focus, failing after `limit` presses. */
async function tabTo(page: Page, target: Locator, limit = 40, key = "Tab") {
  for (let press = 0; press < limit; press += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

async function openSettings(page: Page, query = "") {
  await page.goto(`/capabilities${query}`);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("list", { name: "Packages" }).getByRole("button")).toHaveCount(3);
  return settings;
}

test("the library is named, keyboard-operable both ways, and fits the window", async ({ page }) => {
  const settings = await openSettings(page);
  await expect(settings.getByRole("tablist", { name: "Capabilities views" })).toMatchAriaSnapshot(`
    - tablist "Capabilities views":
      - tab "My library" [selected]
      - tab "Setups"
      - tab "Machines"
      - tab "Updates"
      - tab "Activity"
      - tab "Installed on this machine"
  `);
  await expect(settings.getByRole("textbox", { name: "Search capabilities" })).toBeVisible();
  await expect(settings.getByRole("combobox", { name: "Type" })).toBeVisible();
  await expect(settings.getByRole("combobox", { name: "Setup" })).toBeVisible();
  expect(await unnamedControls(settings)).toEqual([]);
  expect(await horizontalOverflow(page)).toEqual([]);

  // Arrow keys move between the views; the library tab is the way back.
  await settings.getByRole("tab", { name: "My library" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(settings.getByRole("tab", { name: "Setups" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(settings.getByRole("tab", { name: "My library" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Keyboard only: from the search field to a package row, open it, and back.
  await settings.getByRole("textbox", { name: "Search capabilities" }).focus();
  const row = settings.getByRole("button", { name: /^docs-search/ });
  await tabTo(page, row);
  await expect(row).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  const detail = settings.getByTestId("capability-package-detail");
  const heading = detail.getByRole("heading", { name: "docs-search", level: 3 });
  await expect(heading).toBeFocused();

  // Where available: every cell says its agent, machine and status.
  const matrix = detail.getByRole("region", { name: "Availability by machine and agent" });
  await expect(matrix.getByRole("table")).toBeVisible();
  await expect(matrix.getByRole("button", { name: "Claude Code on Desk: Ready" })).toBeVisible();
  await expect(
    matrix.getByRole("button", { name: "Claude Code on Build box: Waiting for machine" }),
  ).toBeVisible();
  await expect(
    matrix.getByRole("button", { name: "Cursor Agent on Laptop: Unsupported" }),
  ).toBeVisible();
  const failed = matrix.getByRole("button", { name: "Claude Code on Laptop: Failed" });
  await tabTo(page, failed);
  await expect(failed).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(failed).toHaveAttribute("aria-expanded", "true");
  const cellDetails = detail.getByRole("region", { name: "Claude Code on Laptop" });
  await expect(cellDetails).toContainText("npx is not on this machine's PATH.");
  await expect(cellDetails).toContainText("Install Node.js on Laptop, then apply again.");
  await page.keyboard.press("Enter");
  await expect(cellDetails).toBeHidden();

  // A narrow window scrolls the matrix inside its own focusable region.
  await expect(matrix).toHaveAttribute("tabindex", "0");
  expect(await unnamedControls(detail)).toEqual([]);
  expect(await horizontalOverflow(page)).toEqual([]);

  const back = detail.getByRole("button", { name: "My library" });
  await tabTo(page, back, 60, "Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(settings.getByRole("button", { name: /^docs-search/ })).toBeFocused();
});

test("Add once: inspect, choose targets with exceptions, preview each target, approve", async ({
  page,
}) => {
  const settings = await openSettings(page, "?offline");
  const add = settings.getByTestId("capability-add");
  await add.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Add a capability" });
  await expect(dialog).toBeVisible();

  // Focus stays inside the dialog however far Tab goes.
  for (let press = 0; press < 20; press += 1) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
    ).toBeTruthy();
  }
  for (let press = 0; press < 5; press += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
    ).toBeTruthy();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
  await expect(settings).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Repository" })
    .fill("https://github.com/org/agent-tools");
  await dialog.getByRole("textbox", { name: "Folder (optional)" }).fill("frontend-review");
  await dialog.getByRole("button", { name: "Inspect" }).click();

  const targets = page.getByRole("dialog", { name: "Choose where to use it" });
  await expect(targets).toContainText("frontend-review");
  await expect(targets).toContainText("Instructions only");
  const agents = targets.getByRole("group", { name: "Agents" });
  await expect(agents.getByRole("checkbox", { name: /Claude Code/ })).toBeChecked();
  await expect(agents.getByRole("checkbox", { name: /Grok Build/ })).toBeDisabled();
  await expect(agents).toContainText("Grok Build has no skills.");
  await agents.getByRole("checkbox", { name: /^Codex/ }).uncheck();
  const machinesGroup = targets.getByRole("group", { name: "Machines" });
  await expect(machinesGroup).toContainText("(waiting to connect)");
  await machinesGroup.getByRole("checkbox", { name: "Laptop" }).uncheck();
  expect(await unnamedControls(targets)).toEqual([]);
  expect(await horizontalOverflow(page)).toEqual([]);
  await targets.getByRole("button", { name: "Preview" }).click();

  const review = page.getByRole("dialog", { name: "Review the plan" });
  const plan = review.getByRole("region", { name: "Planned changes" });
  await expect(plan).toHaveAttribute("tabindex", "0");
  // Each target is a row: what it gets, what is not delivered and why.
  const rows = plan.getByRole("row");
  await expect(
    rows.filter({ hasText: "Desk" }).filter({ hasText: "Install" }).first(),
  ).toContainText("Available next turn");
  await expect(rows.filter({ hasText: "Build box" }).first()).toContainText("Waiting for machine");
  await expect(plan).toContainText("Exception: not for Laptop · Claude Code.");
  await expect(plan).toContainText("Exception: not for Desk · Codex.");
  await expect(plan).toContainText("Cursor Agent is not installed on Desk.");
  expect(await horizontalOverflow(page)).toEqual([]);

  const [preview] = await calls(page, "preview_capability_change");
  expect(preview!.args.change).toMatchObject({
    kind: "add-to-setup",
    inspectionId: "insp-1",
    setupId: "my-setup",
    excludedMachines: ["bk_laptop"],
  });
  expect((preview!.args.change as { excludedProviders: string[] }).excludedProviders).toEqual(
    expect.arrayContaining(["codex", "grok"]),
  );

  await review.getByRole("button", { name: "Apply" }).click();
  await expect(review).toBeHidden();
  await expect(settings.getByRole("status")).toContainText(
    "Statuses update as each machine reports back.",
  );
  const [apply] = await calls(page, "apply_capability_change");
  expect(apply!.args).toMatchObject({ operationId: "op-add" });
  expect(apply!.args.approvedDigest).toMatch(/^sha256:/);
  await expect(add).toBeFocused();
});

test("the update inbox asks for review before approval, and rollback previews first", async ({
  page,
}) => {
  const settings = await openSettings(page);
  await settings.getByRole("tab", { name: "Updates" }).click();
  const updates = settings.getByTestId("capability-updates");
  await expect(updates).toContainText("The new revision adds a hook that runs a program.");
  await expect(updates).toContainText("runs a program");
  const reviewButton = updates.getByRole("button", { name: "Review" });
  await reviewButton.click();

  const dialog = page.getByRole("dialog", { name: "Review the update" });
  await expect(dialog).toContainText("Review before approving");
  const approve = dialog.getByRole("button", { name: "Approve and apply" });
  await expect(approve).toBeDisabled();
  const acknowledge = dialog.getByRole("checkbox", {
    name: "I reviewed what this package runs and connects to.",
  });
  await acknowledge.focus();
  await page.keyboard.press("Space");
  await expect(approve).toBeEnabled();
  await expect(dialog.getByRole("region", { name: "Planned changes" })).toContainText(
    "New session required",
  );
  expect(await unnamedControls(dialog)).toEqual([]);
  expect(await horizontalOverflow(page)).toEqual([]);
  await approve.click();
  await expect(dialog).toBeHidden();
  await expect(settings.getByRole("status")).toHaveText(
    "Update approved; machines are applying it.",
  );
  const [apply] = await calls(page, "apply_capability_change");
  expect(apply!.args).toMatchObject({ operationId: "op-update" });

  // Rollback: a plan to review, kept copies named, nothing applied on Escape.
  await settings.getByRole("tab", { name: "My library" }).click();
  await settings.getByRole("button", { name: /^review/ }).click();
  const rollback = settings.getByRole("button", { name: "Roll back" });
  await rollback.click();
  const plan = page.getByRole("dialog", { name: "Review the plan" });
  await expect(plan).toContainText("Shared with 1 other setup(s)");
  await expect(plan).toContainText("Exception: Frontend is not used on Laptop.");
  await page.keyboard.press("Escape");
  await expect(plan).toBeHidden();
  await expect(rollback).toBeFocused();
  expect(await calls(page, "apply_capability_change")).toHaveLength(1);
  expect((await calls(page, "rollback_capability_package"))[0]!.args).toEqual({
    packageId: "managed:review",
    toRevision: "0011223344556677",
  });
});

test("adding a library package to another setup previews before applying", async ({
  page,
}, info) => {
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: /^docs-search/ }).click();
  const detail = settings.getByTestId("capability-package-detail");
  await detail.getByRole("combobox", { name: "Use on a setup" }).selectOption("frontend");
  const visualDir = process.env.ORKESTRATOR_CAPABILITY_VISUALS;
  if (visualDir)
    await page.screenshot({
      path: `${visualDir}/package-assignment-review-${info.project.name}.png`,
    });
  await detail.getByRole("button", { name: "Add", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Review the plan" });
  await expect(preview.getByRole("region", { name: "Planned changes" })).toBeVisible();
  expect((await calls(page, "preview_capability_change"))[0]?.args.change).toMatchObject({
    kind: "add-to-setup",
    packageId: "git:org/agent-tools#docs-search",
    setupId: "frontend",
  });
  expect(await calls(page, "set_capability_setup")).toHaveLength(0);
  expect(await calls(page, "apply_capability_change")).toHaveLength(0);
  if (visualDir)
    await page.screenshot({
      path: `${visualDir}/package-assignment-review-approval-${info.project.name}.png`,
    });
  await expect(preview.getByRole("button", { name: "Approve and apply" })).toBeDisabled();
  await preview.getByRole("checkbox", { name: /I reviewed/ }).check();
  await preview.getByRole("button", { name: "Approve and apply" }).click();
  await expect(preview).toBeHidden();
  expect(await calls(page, "apply_capability_change")).toHaveLength(1);
});

test("fleet delivery opens an approval preview before applying", async ({ page }, info) => {
  const settings = await openSettings(page);
  await settings.getByRole("tab", { name: "Setups" }).click();
  const fleet = settings.getByRole("checkbox", { name: "Use on every enrolled machine" }).first();
  await expect(fleet).not.toBeChecked();
  const visualDir = process.env.ORKESTRATOR_CAPABILITY_VISUALS;
  if (visualDir)
    await page.screenshot({ path: `${visualDir}/fleet-before-preview-${info.project.name}.png` });
  await fleet.click();
  const preview = settings.getByTestId("capability-change-preview");
  await expect(preview).toContainText("This toolkit will be used on every enrolled machine.");
  await expect(fleet).not.toBeChecked();
  expect(await calls(page, "set_capability_setup")).toHaveLength(0);
  expect(await calls(page, "apply_capability_change")).toHaveLength(0);
  expect((await calls(page, "preview_capability_change"))[0]?.args.change).toEqual({
    kind: "use-toolkit-on-fleet",
    setupId: "frontend",
    expectedRevision: 2,
  });
  await preview.scrollIntoViewIfNeeded();
  if (visualDir)
    await page.screenshot({ path: `${visualDir}/fleet-approval-${info.project.name}.png` });
});

test("toolkits show their exceptions; export and import are previews", async ({ page }) => {
  const settings = await openSettings(page);
  await settings.getByRole("tab", { name: "Setups" }).click();
  const setups = settings.getByTestId("capability-setups");
  await expect(setups.getByRole("button", { name: /Except machine:bk_laptop/ })).toBeVisible();
  await expect(setups.getByRole("combobox", { name: "Updates" }).first()).toBeVisible();
  await expect(setups.getByRole("button", { name: "Delete Frontend" })).toBeVisible();
  expect(await horizontalOverflow(page)).toEqual([]);

  await setups.getByRole("button", { name: "Export" }).nth(1).click();
  await expect(setups.getByRole("heading", { name: "Export" })).toBeVisible();
  await expect(setups).toContainText("orkestrator.capabilities.lock.json");
  await expect(setups.locator("textarea[readonly]").first()).toHaveValue(/name: Frontend/);

  await setups.getByPlaceholder("orkestrator.capabilities.yaml").fill("setups: []");
  await setups.getByPlaceholder("orkestrator.capabilities.lock.json").fill("{}");
  await setups.getByRole("button", { name: "Preview import" }).click();
  await expect(setups).toContainText("packages[2].source: A host path is not portable.");
  await expect(setups).toContainText("Your library has a newer revision");
  await expect(setups).toContainText("docs-search connects to docs.example.com.");
  expect(await calls(page, "import_capability_setup")).toHaveLength(0);
  await setups.getByRole("button", { name: "Import", exact: true }).click();
  await expect.poll(async () => (await calls(page, "import_capability_setup")).length).toBe(1);
  expect(await horizontalOverflow(page)).toEqual([]);
});

test("the administrator policy lists, adds and refuses entries, and wins over setups", async ({
  page,
}) => {
  const settings = await openSettings(page);
  await settings.getByRole("tab", { name: "Setups" }).click();
  const policy = settings.getByRole("region", { name: "Policy" });
  await expect(policy).toContainText("win over every setup");
  await expect(policy.getByRole("list", { name: "Forbidden sources" })).toContainText(
    "git:github.com/untrusted-org/",
  );
  await expect(policy).toContainText("No component is forbidden.");

  // A kind is normalised and sent against the loaded revision; what it blocks is listed.
  await policy.getByRole("textbox", { name: "Forbid a component" }).fill("mcp-server");
  await policy.getByRole("textbox", { name: "Forbid a component" }).press("Enter");
  await expect.poll(async () => (await calls(page, "set_capability_admin_policy")).length).toBe(1);
  expect((await calls(page, "set_capability_admin_policy"))[0]!.args).toEqual({
    expectedRevision: 2,
    forbiddenComponents: ["kind:mcp-server"],
  });
  await expect(policy.getByRole("list", { name: "Forbidden components" })).toContainText(
    "kind:mcp-server",
  );
  const blocked = policy.getByRole("list", { name: "Packages blocked by policy" });
  await expect(blocked).toContainText("docs-search");
  await expect(blocked).toContainText("Blocked by policy");

  // An entry that could never match is refused in the form, with its reason.
  const source = policy.getByRole("textbox", { name: "Forbid a source" });
  await source.fill("github.com");
  await source.press("Enter");
  await expect(source).toHaveAttribute("aria-invalid", "true");
  await expect(policy).toContainText("Start with git:");
  expect(await calls(page, "set_capability_admin_policy")).toHaveLength(1);

  // Someone else changed it meanwhile: the conflict is announced.
  await page.evaluate(() =>
    window.capabilityFixtureFailNext?.(
      "set_capability_admin_policy",
      "The policy changed since it was loaded. Review the current policy and try again.",
    ),
  );
  await policy.getByRole("button", { name: "Allow registry:legacy/ again" }).click();
  await expect(policy.getByRole("alert")).toContainText("The policy changed since it was loaded.");
  expect(await unnamedControls(policy)).toEqual([]);
  expect(await horizontalOverflow(page)).toEqual([]);
});

test("stale data stays visible with the error, and an offline machine says it is waiting", async ({
  page,
}) => {
  const settings = await openSettings(page, "?offline");
  await page.evaluate(() =>
    window.capabilityFixtureFailNext?.(
      "list_capability_packages",
      "The command node did not answer.",
    ),
  );
  await settings.getByRole("textbox", { name: "Search capabilities" }).fill("re");
  await expect(settings.getByRole("alert")).toHaveText("The command node did not answer.");
  // The last good list is kept rather than blanked.
  await expect(settings.getByRole("list", { name: "Packages" }).getByRole("button")).toHaveCount(3);
  await settings.getByRole("textbox", { name: "Search capabilities" }).fill("rev");
  await expect(settings.getByRole("alert")).toBeHidden();
  await expect(settings.getByRole("list", { name: "Packages" }).getByRole("button")).toHaveCount(1);

  await settings.getByRole("tab", { name: "Machines" }).click();
  const machines = settings.getByTestId("capability-machines");
  const build = machines.getByRole("listitem").filter({ hasText: "Build box" });
  await expect(build).toContainText("Offline");
  await expect(build).toContainText("Will apply the latest setup when it reconnects");
  await expect(build).toContainText("Waiting for machine");
  await expect(machines.getByRole("textbox", { name: "Groups for Build box" })).toBeVisible();
  await expect(machines.getByRole("checkbox", { name: "Follows My setup" })).toHaveCount(3);
  expect(await unnamedControls(machines)).toEqual([]);
  expect(await horizontalOverflow(page)).toEqual([]);

  await settings.getByRole("tab", { name: "Activity" }).click();
  const activity = settings.getByTestId("capability-activity");
  // A partly applied operation lists each outcome, failures included.
  await expect(activity).toContainText("partially-completed");
  await expect(activity).toContainText("Failed");
  await expect(activity).toContainText("Waiting for machine");
});

test("the session chip changes toolkits without a restart and announces its test", async ({
  page,
}) => {
  await page.goto("/capabilities?surface=session");
  const chip = page.getByRole("region", { name: "Capabilities: My setup + Frontend" });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Ready");
  expect(await unnamedControls(chip)).toEqual([]);

  const change = chip.getByRole("button", { name: "Change" });
  await expect(change).toHaveAttribute("aria-expanded", "false");
  await change.focus();
  await page.keyboard.press("Enter");
  await expect(change).toHaveAttribute("aria-expanded", "true");
  const toolkits = chip.getByRole("group", {
    name: "Toolkits for this session (in addition to My setup)",
  });
  await expect(toolkits.getByRole("checkbox", { name: "Frontend" })).toBeChecked();
  await expect(toolkits).toContainText("Nothing restarts");
  await page.evaluate(() => window.capabilityFixtureHoldNext?.("assign_capability_setup"));
  await toolkits.getByRole("checkbox", { name: "Research" }).focus();
  await page.keyboard.press("Space");
  await expect(toolkits.getByRole("checkbox", { name: "Frontend" })).toBeDisabled();
  await expect(toolkits.getByRole("checkbox", { name: "Research" })).toBeDisabled();
  await page.evaluate(() => window.capabilityFixtureRelease?.());

  await expect(
    page.getByRole("region", { name: "Capabilities: My setup + Frontend + Research" }),
  ).toContainText("Next session");
  expect((await calls(page, "assign_capability_setup"))[0]!.args).toEqual({
    scope: "session",
    scopeId: "session-1",
    setupIds: ["frontend", "research"],
    expectedRevision: 1,
  });

  const details = chip.getByRole("button", { name: "See details" });
  await details.click();
  await expect(chip.getByRole("button", { name: "Hide details" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const list = chip.getByRole("list", { name: "Capabilities in this session" });
  await expect(list).toContainText("New session required");
  await expect(list).toContainText("MCP servers load when a session starts.");

  await chip.getByRole("button", { name: "Test" }).click();
  await expect(chip.getByTestId("capability-chip-announcement")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(chip.getByTestId("capability-chip-announcement")).toHaveText(
    "2 of 2 checks found the files in place. None is confirmed loaded by the session yet.",
  );
  expect(await horizontalOverflow(page)).toEqual([]);
});

test("project, environment and graph node toolkits resolve through the same model", async ({
  page,
}) => {
  await page.goto("/capabilities?surface=scopes");
  const [project, environment] = [
    page.getByTestId("capability-scope-card").nth(0),
    page.getByTestId("capability-scope-card").nth(1),
  ];
  await expect(project).toContainText("every agent session in this project");
  await expect(environment).toContainText("every agent session in this environment");
  await expect(project).toContainText("Claude Code gets 1 package(s).");
  await project.getByRole("checkbox", { name: "Frontend" }).check();
  await expect.poll(async () => (await calls(page, "assign_capability_setup")).length).toBe(1);
  expect((await calls(page, "assign_capability_setup"))[0]!.args).toEqual({
    scope: "project",
    scopeId: "project-1",
    setupIds: ["frontend"],
    expectedRevision: 0,
  });
  await expect(project.getByRole("checkbox", { name: "Frontend" })).toBeChecked();
  await expect(environment.getByRole("checkbox", { name: "Frontend" })).not.toBeChecked();

  const node = page.getByRole("region", { name: "Toolkits" });
  await expect(node).toContainText("The permissions above stay the ceiling.");
  await node.getByRole("checkbox", { name: "Research" }).check();
  await expect(node).toContainText("Blocked by policy");
  await expect(node).toContainText(
    "The node is not granted user MCP servers. The toolkit cannot widen the node's grant.",
  );
  expect((await calls(page, "assign_capability_setup"))[1]!.args).toEqual({
    scope: "graph-node",
    scopeId: "template-1/worker",
    setupIds: ["research"],
    expectedRevision: 0,
  });
  expect(await unnamedControls(page.locator("main"))).toEqual([]);
  expect(await horizontalOverflow(page)).toEqual([]);
});
