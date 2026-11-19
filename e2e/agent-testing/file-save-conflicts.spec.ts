import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "./browser-test";
import {
  authenticatedInvoke,
  profileStatus,
  sidebarNavigator,
  type Environment,
  type Project,
} from "./slash-command-live-support";

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const previews = process.env.ORKESTRATOR_SAVE_CONFLICT_PREVIEWS;

async function placeCaretAtEnd(editor: Locator) {
  await editor.getByRole("heading").evaluate((element) => {
    (element.closest("[contenteditable]") as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

test("file save conflicts preserve both versions through comparison, recovery and navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const status = profileStatus(profile);
  const invoke = await authenticatedInvoke(page, status, profile);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  const created: Environment[] = [];

  async function create(name: string) {
    const environment = await invoke<Environment>("create_environment", {
      projectId: fixture.id,
      name,
      environmentType: "local",
    });
    created.push(environment);
    await invoke("start_environment", { environmentId: environment.id });
    return invoke<Environment>("get_environment", { environmentId: environment.id });
  }

  const select = sidebarNavigator(page, fixture.name);
  async function openFile(file: string) {
    const panel = page.getByRole("button", { name: "Show file panel", exact: true });
    if (await panel.isVisible()) await panel.click();
    await page.getByRole("tab", { name: "All files", exact: true }).click();
    await page.getByRole("button", { name: file, exact: true }).click();
    const close = page.getByRole("button", { name: "Hide file panel", exact: true });
    if (await close.isVisible()) await close.click();
  }
  async function screenshot(name: string) {
    if (previews)
      await page.screenshot({
        path: path.join(previews, `save-findings-verified-after-${name}.png`),
      });
  }

  try {
    const source = await create(`file-recovery-${Date.now()}`);
    const other = await create(`file-recovery-other-${Date.now()}`);
    const python = path.join(source.worktreePath!, "indent.py");
    const markdown = path.join(source.worktreePath!, "recovery.md");
    await fs.writeFile(python, "if True:\n    print(1)\n");
    await fs.writeFile(markdown, "# Original\n");

    await select(source.name);
    await openFile("indent.py");
    const editor = page.locator(".monaco-editor").getByRole("textbox").first();
    await expect(editor).toBeVisible();
    await editor.press("End");
    await page.keyboard.insertText(" # my draft");
    await fs.writeFile(python, "if True:\n  print(1)\n");
    await editor.press("ControlOrMeta+s");

    const banner = page.getByRole("alert", { name: "File changed on disk" });
    await expect(banner).toBeVisible();
    await screenshot("banner-desktop");
    await banner.getByRole("button", { name: "Compare", exact: true }).click();
    const comparison = page.locator(".monaco-diff-editor");
    await expect(comparison).toBeVisible();
    // The disk side changed only in indentation on the second line.
    await expect(comparison.locator(".char-delete").first()).toBeVisible();
    const modified = comparison.locator(".editor.modified").getByRole("textbox");
    await modified.press("ControlOrMeta+s");
    await expect(banner).toBeVisible();
    expect(await fs.readFile(python, "utf8")).toBe("if True:\n  print(1)\n");
    await screenshot("comparison-desktop");
    await page.setViewportSize({ width: 760, height: 850 });
    await screenshot("comparison-narrow");
    await page.setViewportSize({ width: 1440, height: 900 });

    const binary = Buffer.from([0, 1, 2]);
    await fs.writeFile(python, binary);
    await modified.press("ControlOrMeta+s");
    await expect(banner.getByRole("button", { name: "Retry save" })).toBeVisible();
    await screenshot("unreadable-desktop");
    await banner.getByRole("button", { name: "Retry save" }).click();
    expect(await fs.readFile(python)).toEqual(binary);

    await fs.unlink(python);
    await select(other.name);
    await select(source.name);
    await expect(banner.getByRole("button", { name: "Recreate file" })).toBeVisible();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("my draft");
    await screenshot("missing-desktop");
    await page.reload();
    await select(source.name);
    await expect(banner.getByRole("button", { name: "Recreate file" })).toBeVisible();
    await banner.getByRole("button", { name: "Recreate file" }).click();
    await expect(banner).toBeHidden();
    expect(await fs.readFile(python, "utf8")).toContain("my draft");

    await openFile("recovery.md");
    const rich = page.getByTestId("tiptap-markdown-editor");
    await expect(rich).toContainText("Original");
    await placeCaretAtEnd(rich);
    await page.keyboard.insertText(" draft");
    await fs.writeFile(markdown, "# Theirs\n");
    await rich.press("ControlOrMeta+s");
    await expect(banner).toBeVisible();
    await placeCaretAtEnd(rich);
    await page.keyboard.insertText(" final");
    await banner.getByRole("button", { name: "Keep mine" }).click();
    await expect.poll(() => fs.readFile(markdown, "utf8")).toContain("Original draft final");
    await page.getByRole("button", { name: "Restore theirs", exact: true }).click();
    await expect(rich).toContainText("Theirs");
    await rich.press("ControlOrMeta+s");
    await expect.poll(() => fs.readFile(markdown, "utf8")).toBe("# Theirs\n");

    await placeCaretAtEnd(rich);
    await page.keyboard.insertText(" recovery");
    await fs.writeFile(markdown, "# On disk\n");
    await rich.press("ControlOrMeta+s");
    await banner.getByRole("button", { name: "Use theirs" }).click();
    await expect(rich).toContainText("On disk");
    await screenshot("loaded-disk-markdown");
    await page.getByRole("button", { name: "Restore mine", exact: true }).click();
    await expect(rich).toContainText("Theirs recovery");
    await screenshot("restored-markdown");
    await rich.press("ControlOrMeta+s");
    await expect.poll(() => fs.readFile(markdown, "utf8")).toContain("Theirs recovery");
  } finally {
    for (const environment of created.reverse()) {
      await invoke("stop_environment", { environmentId: environment.id });
      await invoke("delete_environment", { environmentId: environment.id });
    }
  }
});
