import { ensureProjectExpanded } from "./sidebar-project";
import { expect, test } from "@playwright/test";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { DesignCanvas, DesignFrame } from "@orkestrator/protocol/design-canvas";

test.use({ actionTimeout: 15_000 });

/** The phone layout's tools trigger, found by CSS so an open modal does not hide it. */
const MOBILE_TOOLS_TRIGGER = 'button[aria-label="Open tools"]';

test("real gateway saves a design and rehydrates another client's edits", async ({
  page,
}, testInfo) => {
  const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
  const status = JSON.parse(
    spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
  expect(status.status).toBe("ready");
  const login = JSON.parse(
    spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
  // This credential-free fixture exercises design I/O, not host Claude login.
  // Keep unrelated host-tool onboarding independent of the machine's PATH.
  await page.route("**/__orkestrator/invoke", async (route) => {
    const request = route.request().postDataJSON();
    if (request?.command === "check_claude_cli") await route.fulfill({ json: { result: false } });
    else await route.continue();
  });
  await page.goto(login.loginUrl);
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    expect(response.ok(), command).toBe(true);
    return (await response.json()).result;
  };
  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((project) => project.localPath === status.testProject)!;
  expect(project).toBeTruthy();
  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "design-canvas-smoke",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: env.id });
    const action = <T>(action: string, input: Record<string, unknown>) =>
      invoke<T>("design_action", { environmentId: env.id, action, input });
    const canvas = await action<DesignCanvas>("create_canvas", { name: "Gateway design" });
    const { frame } = await action<{ frame: DesignFrame }>("create_frame", {
      canvasId: canvas.id,
      expectedRevision: 1,
      name: "Screen",
      x: 0,
      y: 0,
      width: 480,
      height: 320,
      html: "<h1 id='title'>Shared design</h1>",
    });
    // Designs are .orkdes files in the repository: save one, then open it from the file tree.
    const exportPath = `designs/gateway-design-${canvas.id.replaceAll("-", "").slice(0, 8)}.orkdes`;
    await invoke("design_export_save", {
      environmentId: env.id,
      canvasId: canvas.id,
      relativePath: exportPath,
      revision: 2,
    });
    await page.reload();
    await ensureProjectExpanded(page, project.name);
    await page.getByText(env.name, { exact: true }).first().click();
    await page.getByRole("button", { name: "Show file panel", exact: true }).click();
    // The panel starts on Changes; explicitly select the tree before routing.
    await page.getByRole("tab", { name: "All files", exact: true }).click();
    await page.getByRole("button", { name: "designs", exact: true }).click();
    await page.getByRole("button", { name: exportPath.split("/")[1]!, exact: true }).click();

    const embedded = page.frameLocator('iframe[title="Screen"]');
    await expect(embedded.getByRole("heading")).toHaveText("Shared design");
    // Links rehydrate through the real gateway. An unsent conversation must
    // never offer an endpoint action that requires a saved resume identity.
    const linkConversation = async (tabId: string, label: string, sessionId?: string) => {
      const result = await invoke<{ ok: true; value: { id: string } }>("design_session_link", {
        environmentId: env.id,
        canvasId: canvas.id,
        link: { tabId, label, sessionId, platform: "codex", role: "design" },
      });
      expect(result.ok).toBe(true);
      return result.value;
    };
    const unsent = await linkConversation("unsent-design-tab", "Unsent design chat");
    const savedLink = await linkConversation(
      "closed-design-tab",
      "Saved design chat",
      "saved-thread",
    );
    expect(
      await invoke("design_session_resume", {
        environmentId: env.id,
        canvasId: canvas.id,
        linkId: unsent.id,
        expectedTabId: "unsent-design-tab",
        tabId: "must-not-open",
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    await page.reload();
    await ensureProjectExpanded(page, project.name);
    await page.getByText(env.name, { exact: true }).first().click();
    await expect(embedded.getByRole("heading")).toHaveText("Shared design");
    await page.getByRole("button", { name: "Ask agent about the selection" }).click();
    const agentDialog = page.getByRole("dialog", { name: "Ask agent about this design" });
    await expect(agentDialog.getByTestId(`design-link-${unsent.id}`)).toContainText(
      "Closed — no conversation to resume",
    );
    await expect(
      agentDialog.getByRole("button", { name: "Resume Unsent design chat" }),
    ).toHaveCount(0);
    await expect(
      agentDialog.getByRole("button", { name: "Resume Saved design chat" }),
    ).toBeVisible();
    await agentDialog.getByRole("button", { name: "Close", exact: true }).click();
    const unsupportedCheck = async (route: import("@playwright/test").Route) => {
      if (route.request().postDataJSON()?.command === "design_session_link_states")
        await route.fulfill({
          status: 500,
          json: { error: "Unknown backend command: design_session_link_states" },
        });
      else await route.fallback();
    };
    await page.route("**/__orkestrator/invoke", unsupportedCheck);
    await page.getByRole("button", { name: "Ask agent about the selection" }).click();
    await expect(agentDialog.getByTestId(`design-link-${savedLink.id}`)).toContainText(
      "Closed — conversation ended",
    );
    await expect(agentDialog.getByRole("button", { name: "Resume Saved design chat" })).toHaveCount(
      0,
    );
    await agentDialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.unroute("**/__orkestrator/invoke", unsupportedCheck);
    for (const link of [unsent, savedLink])
      await invoke("design_session_unlink", {
        environmentId: env.id,
        canvasId: canvas.id,
        linkId: link.id,
      });
    // Save As remembers the file the design was opened from.
    await page.getByRole("button", { name: "Export design to repository" }).click();
    const exportDialog = page.getByRole("dialog", { name: "Export design to repository" });
    await expect(exportDialog.getByLabel("Folder")).toHaveValue("designs");
    await expect(exportDialog.getByText(`${exportPath} is your previous export`)).toBeVisible();
    // Hold the real preview request to check the reserved layout and disabled controls.
    await exportDialog.getByLabel("File name").fill("preview.orkdes");
    await expect(
      exportDialog.getByText("New file: designs/preview.orkdes will be created."),
    ).toBeVisible();
    const revisionLabel = exportDialog.getByText("Exports committed revision 2.");
    const settledY = (await revisionLabel.boundingBox())!.y;
    let releasePreview!: () => void;
    const heldPreview = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const holdPreview = async (route: import("@playwright/test").Route) => {
      if (route.request().postDataJSON()?.command === "design_export_preview") await heldPreview;
      await route.fallback();
    };
    await page.route("**/__orkestrator/invoke", holdPreview);
    try {
      await exportDialog.getByLabel("File name").fill("next.orkdes");
      const loading = exportDialog.getByText("Checking designs/next.orkdes…");
      await expect(loading).toBeVisible();
      const previewLayout = await loading.evaluate((node) => ({
        height: node.parentElement!.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(node).lineHeight),
      }));
      expect(previewLayout.height).toBeGreaterThanOrEqual(previewLayout.lineHeight * 2);
      expect((await revisionLabel.boundingBox())!.y).toBe(settledY);
      await expect(
        exportDialog.getByRole("button", { name: "Export revision 2", exact: true }),
      ).toBeDisabled();
    } finally {
      releasePreview();
      await page.unroute("**/__orkestrator/invoke", holdPreview);
    }
    await expect(
      exportDialog.getByText("New file: designs/next.orkdes will be created."),
    ).toBeVisible();
    await expect(
      exportDialog.getByRole("button", { name: "Export revision 2", exact: true }),
    ).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    // The open dialog survives the swap to the phone layout. Wait for that
    // layout (by CSS: the modal dialog hides the rest of the page from roles)
    // so the bounds are measured after it, not before.
    await expect(page.locator(MOBILE_TOOLS_TRIGGER)).toBeVisible();
    await expect(exportDialog).toBeVisible();
    const exportBounds = (await exportDialog.boundingBox())!;
    expect(exportBounds.x).toBeGreaterThanOrEqual(0);
    expect(exportBounds.x + exportBounds.width).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 900 });
    await exportDialog.getByRole("button", { name: "Cancel" }).click();
    const environment = await invoke<{ worktreePath: string }>("get_environment", {
      environmentId: env.id,
    });
    const saved = await invoke<{ content: string }>("read_local_file", {
      worktreePath: environment.worktreePath,
      filePath: exportPath,
    });
    expect(JSON.parse(saved.content)).toMatchObject({
      id: canvas.id,
      format: "orkdes",
      revision: 2,
    });
    // Path shapes rejected by design validation remain available in the editor.
    const textPaths = [
      "UPPER.ORKDES",
      "has space.orkdes",
      "a".repeat(102) + ".orkdes",
      ".private/hidden.orkdes",
      "b".repeat(65) + "/overlong.orkdes",
      "d1/d2/d3/d4/d5/d6/d7/d8/deep.orkdes",
    ];
    for (const filePath of textPaths) {
      await invoke("write_local_file", {
        worktreePath: environment.worktreePath,
        filePath,
        base64Data: Buffer.from("plain text fallback").toString("base64"),
      });
    }
    await page.reload();
    await ensureProjectExpanded(page, project.name);
    await page.getByText(env.name, { exact: true }).first().click();
    await page.getByRole("button", { name: "Show file panel", exact: true }).click();
    await page.getByRole("tab", { name: "All files", exact: true }).click();
    for (const filePath of textPaths) {
      const segments = filePath.split("/");
      const name = segments.pop()!;
      for (const folder of segments)
        await page.getByRole("button", { name: folder, exact: true }).click();
      await page.getByRole("button", { name, exact: true }).click();
      await expect
        .poll(async () =>
          JSON.stringify(await invoke("get_pane_layout", { environmentId: env.id })),
        )
        .toContain(`"filePath":"${filePath}"`);
      await page.getByRole("button", { name: `Close ${name}`, exact: true }).click();
    }
    // Return to the design after editing other tabs and reconcile missed updates.
    await page
      .getByText(/^Design \d+$/, { exact: true })
      .first()
      .click();
    await action("replace_frame_html", {
      canvasId: canvas.id,
      frameId: frame.id,
      expectedRevision: 1,
      html: "<h1 id='title'>Updated by another client</h1>",
    });
    await expect(embedded.getByRole("heading")).toHaveText("Updated by another client");
    await page.getByRole("button", { name: "Undo design change" }).click();
    await expect(embedded.getByRole("heading")).toHaveText("Shared design");
    await page.getByRole("button", { name: "Redo design change" }).click();
    await expect(embedded.getByRole("heading")).toHaveText("Updated by another client");
    await page.reload();
    await ensureProjectExpanded(page, project.name);
    await page.getByText(env.name, { exact: true }).first().click();
    await expect(embedded.getByRole("heading")).toHaveText("Updated by another client");
    const layout = await invoke<{ root: unknown }>("get_pane_layout", { environmentId: env.id });
    const serialized = JSON.stringify(layout.root);
    expect(serialized).toContain(canvas.id);
    expect(serialized).not.toContain("<h1");
    await page.getByRole("button", { name: "New design workspace" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Guided design");
    await page.getByRole("combobox", { name: "Design agent", exact: true }).click();
    await page.getByRole("option", { name: "Codex", exact: true }).click();
    await page.getByRole("textbox", { name: "Design brief" }).fill("Mock up the sidebar");
    await page.getByRole("button", { name: "Create design workspace", exact: true }).click();
    await expect(page.getByText("Guided design", { exact: true })).toBeVisible();
    await expect(
      page.getByText("A blank canvas for your next idea", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Mock up the sidebar", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Use the orkestrator-design MCP server", { exact: false }),
    ).toHaveCount(0);
    await page.reload();
    await ensureProjectExpanded(page, project.name);
    await page.getByText(env.name, { exact: true }).first().click();
    await expect(page.getByText("Mock up the sidebar", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Use the orkestrator-design MCP server", { exact: false }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("design-workspace.png") });
  } finally {
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
  }
});

test("private canvases survive reload and can be retired to recover quota", async ({ page }) => {
  const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
  const status = JSON.parse(
    spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
  const login = JSON.parse(
    spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
  await page.route("**/__orkestrator/invoke", async (route) => {
    if (route.request().postDataJSON()?.command === "check_claude_cli")
      await route.fulfill({ json: { result: false } });
    else await route.continue();
  });
  await page.goto(login.loginUrl);
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    expect(response.ok(), command).toBe(true);
    return (await response.json()).result;
  };
  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((project) => project.localPath === status.testProject)!;
  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "design-private-smoke",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  const action = <T>(action: string, input: Record<string, unknown>) =>
    invoke<T>("design_action", { environmentId: env.id, action, input });
  const selectEnvironment = async () => {
    await ensureProjectExpanded(page, project.name);
    await page.getByText(env.name, { exact: true }).first().click();
  };
  const openLibrary = async () => {
    const tools = page.getByRole("button", { name: "Open tools", exact: true });
    if ((page.viewportSize()?.width ?? 1440) < 768) {
      // The phone layout opens its projects drawer only on a phone-sized first
      // load, so wait for the layout before checking for the drawer.
      await expect(page.locator(MOBILE_TOOLS_TRIGGER)).toBeVisible();
      const closeProjects = page
        .getByRole("button", { name: "Close projects and environments", exact: true })
        .first();
      if (await closeProjects.isVisible()) await closeProjects.click();
      await tools.click();
    }
    await page.getByRole("button", { name: "New design workspace" }).click();
    await page.getByRole("tab", { name: "Saved designs" }).click();
  };
  try {
    await invoke("start_environment", { environmentId: env.id });
    // An existing private record models an upgrade before repository exports.
    const existing = await action<DesignCanvas>("create_canvas", {
      name: "Existing private canvas",
    });
    await page.reload();
    await selectEnvironment();
    await page.getByRole("button", { name: "New design workspace" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Private canvas");
    await page.getByRole("combobox", { name: "Design agent", exact: true }).click();
    await page.getByRole("option", { name: "Blank canvas (no agent)", exact: true }).click();
    await page.getByRole("button", { name: "Create blank canvas" }).click();
    await expect(page.getByText("Private canvas", { exact: true })).toBeVisible();
    const privatePage = await invoke<{ value: { entries: Array<{ id: string }> } }>(
      "design_library",
      {
        environmentId: env.id,
        query: { search: "Private canvas" },
      },
    );
    const privateId = privatePage.value.entries.find((entry) => entry.id !== existing.id)!.id;
    await action("create_frame", {
      canvasId: privateId,
      expectedRevision: 1,
      name: "Private screen",
      x: 0,
      y: 0,
      width: 480,
      height: 320,
      html: "<h1>Private changes</h1>",
    });
    await expect(
      page.frameLocator('iframe[title="Private screen"]').getByRole("heading"),
    ).toHaveText("Private changes");
    await page.getByRole("button", { name: /^Close Design/ }).click();
    await page.reload();
    await selectEnvironment();
    await openLibrary();
    await page.getByRole("button", { name: /^Private canvas/ }).click();
    await page.getByRole("button", { name: "Open beside", exact: true }).click();
    await expect(page.getByText("Private canvas", { exact: true })).toBeVisible();
    await expect(
      page.frameLocator('iframe[title="Private screen"]').getByRole("heading"),
    ).toHaveText("Private changes");
    await page.getByRole("button", { name: /^Close Design/ }).click();
    await openLibrary();
    await page.getByRole("button", { name: /^Existing private canvas/ }).click();
    await page.getByRole("button", { name: "Open beside", exact: true }).click();
    await expect(page.getByText("Existing private canvas", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Close Design/ }).click();
    await page.getByRole("button", { name: "New design workspace" }).click();
    await page.getByRole("tab", { name: "Open design", exact: true }).click();
    const importPath = join(status.testProject, "private-import.orkdes");
    await writeFile(importPath, "{");
    const chooseFile = async () => {
      await page.getByRole("button", { name: "Choose .orkdes file…" }).click();
      const picker = page.getByRole("dialog", { name: "Open design (.orkdes)", exact: true });
      await expect(picker).toBeVisible();
      await picker.getByLabel("Path", { exact: true }).fill(importPath);
      await picker.getByLabel("Path", { exact: true }).press("Enter");
      await expect(picker.getByRole("button", { name: "Select file", exact: true })).toBeEnabled();
      await picker.getByRole("button", { name: "Select file", exact: true }).click();
      await expect(picker).toHaveCount(0);
    };
    await chooseFile();
    await expect(
      page.getByRole("dialog", { name: "Design workspace" }).getByRole("alert"),
    ).toBeVisible();
    await writeFile(importPath, JSON.stringify({ ...existing, name: "Imported private canvas" }));
    await chooseFile();
    await expect(page.getByText("Imported private canvas", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Close Design/ }).click();
    await page.reload();
    await selectEnvironment();
    await page.setViewportSize({ width: 720, height: 900 });
    await openLibrary();
    await page.getByRole("searchbox", { name: "Search designs" }).fill("Imported private");
    await page.getByRole("button", { name: /^Imported private canvas/ }).click();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByLabel("New name for Imported private canvas").fill("Imported private renamed");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await page.getByRole("button", { name: /^Imported private renamed/ }).click();
    await page.getByRole("button", { name: "Open beside", exact: true }).click();
    await expect(page.getByText("Imported private renamed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Close Design/ }).click();
    await page.setViewportSize({ width: 1440, height: 900 });

    const result = await invoke<{ value: { quota: { live: number; liveLimit: number } } }>(
      "design_library",
      { environmentId: env.id, query: {} },
    );
    for (let i = result.value.quota.live; i < result.value.quota.liveLimit; i++)
      await action("create_canvas", { name: `Quota canvas ${i}` });
    await openLibrary();
    await expect(page.getByText(/Design limit reached/)).toBeVisible();
    await page.getByRole("tab", { name: "New design", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Blocked by quota");
    await page.getByRole("combobox", { name: "Design agent", exact: true }).click();
    await page.getByRole("option", { name: "Blank canvas (no agent)", exact: true }).click();
    await page.getByRole("button", { name: "Create blank canvas", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Canvas limit reached");
    await page.getByRole("tab", { name: "Saved designs", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search designs" }).fill("Private canvas");
    await page.getByRole("button", { name: /^Private canvas/ }).click();
    await page.getByRole("button", { name: "Move to trash", exact: true }).click();
    await page.getByRole("button", { name: "Move to trash", exact: true }).click();
    await expect(page.getByText(/Design limit reached/)).toHaveCount(0);
    await page.getByRole("tab", { name: "New design", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("After quota recovery");
    await page.getByRole("combobox", { name: "Design agent", exact: true }).click();
    await page.getByRole("option", { name: "Blank canvas (no agent)", exact: true }).click();
    await page.getByRole("button", { name: "Create blank canvas" }).click();
    await expect(page.getByText("After quota recovery", { exact: true })).toBeVisible();
  } finally {
    await rm(join(status.testProject, "private-import.orkdes"), { force: true });
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
  }
});

test("an image brief drains after enqueue acknowledgement and fallback failure while inactive", async ({
  page,
}) => {
  const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
  const status = JSON.parse(
    spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
  const login = JSON.parse(
    spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
  let allowEnqueue!: () => void;
  let allowAck!: () => void;
  let failFallback!: () => void;
  let queueDurable!: () => void;
  const enqueueGate = new Promise<void>((resolve) => {
    allowEnqueue = resolve;
  });
  const ackGate = new Promise<void>((resolve) => {
    allowAck = resolve;
  });
  const fallbackGate = new Promise<void>((resolve) => {
    failFallback = resolve;
  });
  const durable = new Promise<void>((resolve) => {
    queueDurable = resolve;
  });
  let tabDispatches = 0;
  let agentTabId: string | undefined;
  await page.route("**/__orkestrator/invoke", async (route) => {
    const request = route.request().postDataJSON();
    if (request?.command === "check_claude_cli") await route.fulfill({ json: { result: false } });
    else if (request?.command === "enqueue_prompt_queue_message") {
      agentTabId = String(request.args.message.requestId).split(":").at(-1);
      // Hydrate and flush the tab before allowing the durable hand-off.
      await enqueueGate;
      const response = await route.fetch();
      queueDurable();
      await ackGate;
      await route.fulfill({ response });
    } else if (
      request?.command === "dispatch_native_agent_intent" &&
      String(request.args?.requestId ?? "").startsWith("initial-prompt:")
    ) {
      tabDispatches += 1;
      // Fail only after queue ownership has been acknowledged off screen.
      await fallbackGate;
      await route.abort();
    } else await route.continue();
  });
  await page.goto(login.loginUrl);
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    expect(response.ok(), command).toBe(true);
    return (await response.json()).result;
  };
  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((project) => project.localPath === status.testProject)!;
  const create = (name: string) =>
    invoke<{ id: string; name: string }>("create_environment", {
      projectId: project.id,
      name,
      environmentType: "local",
      networkAccessMode: "restricted",
    });
  const env = await create("design-brief-inactive");
  const other = await create("design-brief-elsewhere");
  const select = async (target: { name: string }) => {
    await ensureProjectExpanded(page, project.name);
    await page.getByText(target.name, { exact: true }).first().click();
  };
  try {
    await invoke("start_environment", { environmentId: env.id });
    await invoke("start_environment", { environmentId: other.id });
    await page.reload();
    await select(env);
    await page.getByRole("button", { name: "New design workspace" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Inactive brief");
    await page.getByRole("combobox", { name: "Design agent", exact: true }).click();
    await page.getByRole("option", { name: "Codex", exact: true }).click();
    const brief = page.getByRole("textbox", { name: "Design brief" });
    await brief.fill("Mock up the header");
    await brief.evaluate(async (input) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), "image/png"),
      );
      const data = new DataTransfer();
      data.items.add(new File([blob], "header.png", { type: "image/png" }));
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
    });
    await expect(page.getByRole("list", { name: "Attached images" }).locator("img")).toHaveCount(1);
    await page.getByRole("button", { name: "Create design workspace", exact: true }).click();
    // A freshly created provider session can take longer than the default UI poll.
    await expect.poll(() => tabDispatches, { timeout: 30_000 }).toBe(1);
    const draftKey = () => `codex:${env.id}:${encodeURIComponent(`env-${env.id}:${agentTabId}`)}`;
    const readDraft = () =>
      invoke<{ value: { text: string; attachments: unknown[] } } | null>("get_compose_draft", {
        draftKey: draftKey(),
      });
    await expect.poll(async () => (await readDraft())?.value.attachments.length).toBe(1);
    await select(other);
    allowEnqueue();
    await durable;
    const queueKey = `codex\u0000env-${env.id}:${agentTabId}`;
    expect(await invoke("get_prompt_queue", { queueKey })).toMatchObject({
      messages: [expect.objectContaining({ id: `initial-prompt:${env.id}:${agentTabId}` })],
    });
    allowAck();
    await expect.poll(async () => (await readDraft())?.value.attachments.length ?? 0).toBe(0);
    failFallback();

    await expect
      .poll(async () => {
        const layout = await invoke<{ root: unknown } | null>("get_pane_layout", {
          environmentId: env.id,
        });
        agentTabId = /"id":"(design-agent-[^"]+)"/.exec(JSON.stringify(layout?.root ?? {}))?.[1];
        return agentTabId;
      })
      .toBeTruthy();
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await invoke("get_native_agent_projection", {
              environmentId: env.id,
              agent: "codex",
              logicalSessionKey: `env-${env.id}:${agentTabId}`,
            }),
          ),
        { timeout: 30_000 },
      )
      .toContain("Mock up the header");

    await select(env);
    await expect(page.getByText("Mock up the header", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Use the orkestrator-design MCP server", { exact: false }),
    ).toHaveCount(0);
    expect(tabDispatches).toBe(1);
    expect((await readDraft())?.value.text ?? "").toBe("");
    expect((await readDraft())?.value.attachments ?? []).toEqual([]);
  } finally {
    allowEnqueue();
    allowAck();
    failFallback();
    for (const target of [env, other]) {
      await invoke("stop_environment", { environmentId: target.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: target.id }).catch(() => undefined);
    }
  }
});
