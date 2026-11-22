import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "./browser-test";
import {
  authenticatedInvoke,
  profileStatus,
  sidebarNavigator,
  type Environment,
  type Project,
} from "./slash-command-live-support";

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const previews = process.env.ORKESTRATOR_FOLDER_DROP_PREVIEWS;

async function dropFromDisk(page: Page, target: Locator, files: string[]) {
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error("The file panel drop target is hidden");
  const cdp = await page.context().newCDPSession(page);
  try {
    const position = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    // Chromium converts native file paths into directory entries for the page.
    const data = { items: [], files, dragOperationsMask: 1 };
    await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...position, data });
    await cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...position, data });
    await cdp.send("Input.dispatchDragEvent", { type: "drop", ...position, data });
  } finally {
    await cdp.detach();
  }
}

test("copies real Chromium directory drops to the workspace root and a folder row", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "Driving native drag data requires Chromium CDP");
  const status = profileStatus(profile);
  const invoke = await authenticatedInvoke(page, status, profile);
  const project = (await invoke<Project[]>("get_projects")).find(
    (candidate) => candidate.localPath === status.testProject,
  )!;
  const select = sidebarNavigator(page, project.name);
  const created: Environment[] = [];
  async function create(label: string) {
    const environment = await invoke<Environment>("create_environment", {
      projectId: project.id,
      name: `folder-drop-${label}-${Date.now()}`,
      environmentType: "local",
    });
    created.push(environment);
    await invoke("start_environment", { environmentId: environment.id });
    return invoke<Environment>("get_environment", { environmentId: environment.id });
  }
  async function openTree() {
    const show = page.getByRole("button", { name: "Show file panel", exact: true });
    if (await show.isVisible()) await show.click();
    await page.getByRole("tab", { name: "All files", exact: true }).click();
    await expect(page.getByLabel("Workspace root drop target")).toBeVisible();
  }
  async function screenshot(state: string) {
    if (!previews) return;
    const { width, height } = page.viewportSize()!;
    await page.screenshot({
      path: path.join(previews, `folder-import-panel-${state}.png`),
      clip: { x: width - 400, y: 0, width: 400, height },
      style: ".xterm { visibility: hidden }",
    });
  }

  const first = testInfo.outputPath("source", "photos ");
  const nested = testInfo.outputPath("source", "sample");
  const metadata = testInfo.outputPath("source", ".Git");
  await fs.mkdir(path.join(first, "empty"), { recursive: true });
  await fs.writeFile(path.join(first, "image.txt"), "root file");
  await fs.writeFile(path.join(first, ".DS_Store"), "skip metadata");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "nested.txt"), "row file");
  await fs.mkdir(metadata, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  try {
    const workspace = await create("workspace");
    const other = await create("other");
    const root = workspace.worktreePath!;
    await fs.mkdir(path.join(root, "destination"));
    // The trimmed sibling makes the literal path observable even on a filesystem
    // that does not distinguish case.
    await fs.mkdir(path.join(root, "photos"));
    await select(workspace.name);
    await openTree();
    const rootTarget = page.getByLabel("Workspace root drop target");
    await screenshot("before");
    await dropFromDisk(page, rootTarget, [first]);
    await expect(page.getByText("Folder copied", { exact: true })).toBeVisible();
    await expect(fs.readFile(path.join(root, "photos ", "image.txt"), "utf8")).resolves.toBe(
      "root file",
    );
    await expect(
      fs.readdir(path.join(root, "photos ")).then((names) => names.sort()),
    ).resolves.toEqual(["empty", "image.txt"]);
    await expect(fs.readdir(path.join(root, "photos"))).resolves.toEqual([]);
    await screenshot("success");

    await dropFromDisk(page, rootTarget, [first]);
    await expect(page.getByText("Failed to copy folder", { exact: true })).toBeVisible();
    await expect(
      fs.readdir(path.join(root, "photos ")).then((names) => names.sort()),
    ).resolves.toEqual(["empty", "image.txt"]);
    expect((await fs.readdir(root)).some((entry) => entry.startsWith(".orkestrator-import-"))).toBe(
      false,
    );
    await screenshot("conflict");

    await dropFromDisk(page, rootTarget, [metadata]);
    await expect(page.getByText("No items copied", { exact: true })).toBeVisible();
    await screenshot("skipped");

    const row = page.getByRole("button", { name: "destination", exact: true });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invokeRoute = "**/__orkestrator/invoke";
    await page.route(invokeRoute, async (route) => {
      const args = route.request().postDataJSON() as {
        command?: string;
        args?: { action?: { kind?: string; name?: string } };
      } | null;
      if (
        args?.command === "import_external_entry" &&
        args.args?.action?.kind === "stage" &&
        args.args.action.name === "sample"
      )
        await resume;
      await route.fallback();
    });
    try {
      await dropFromDisk(page, row, [nested]);
      await expect(page.getByText("0 of 1 files prepared")).toBeVisible();
      await screenshot("progress");
      await select(other.name);
      release();
      await expect
        .poll(() =>
          fs
            .readFile(path.join(root, "destination", "sample", "nested.txt"), "utf8")
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return undefined;
            }),
        )
        .toBe("row file");
      await expect(
        fs.stat(path.join(other.worktreePath!, "destination", "sample")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      await page.unroute(invokeRoute);
    }

    await page.reload();
    await select(workspace.name);
    await openTree();
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    await expect(page.getByRole("button", { name: "sample", exact: true })).toBeVisible();
  } finally {
    for (const environment of created.reverse()) {
      await invoke("delete_environment", { environmentId: environment.id });
    }
  }
});
