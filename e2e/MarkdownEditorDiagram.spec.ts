import { expect, test } from "@playwright/test";
import path from "node:path";

const screenshots = path.resolve(
  import.meta.dirname,
  "../output/playwright/markdown-editor-diagram",
);

test("a mermaid fence renders as a diagram with its source editable on demand", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "desktop coverage is sufficient for the editor's diagram view",
  );

  await page.goto("/markdown-editor-diagram");
  const editor = page.getByTestId("tiptap-markdown-editor");
  const diagram = editor.getByRole("img", { name: /^Mermaid flowchart diagram/ });
  const source = editor.locator("[data-markdown-diagram-source]");

  await expect(diagram).toBeVisible();
  await expect(editor.getByRole("button", { name: "Show source" })).toHaveCount(0);
  await expect(source).toHaveAttribute("data-state", "collapsed");
  await page.screenshot({ path: path.join(screenshots, "collapsed.png") });

  await page.getByRole("button", { name: "Edit source" }).click();
  await expect(source).toHaveAttribute("data-state", "open");
  await expect(source).toBeVisible();
  await page.keyboard.type("\n  B --> C[GraphRun]");
  await expect(source).toContainText("B --> C[GraphRun]");
  await page.screenshot({ path: path.join(screenshots, "editing.png") });

  await editor.getByText("Text after the diagram.").click();
  await expect(source).toHaveAttribute("data-state", "collapsed");
  await expect(diagram).toBeVisible();
});

test("arrow keys enter and leave a collapsed diagram fence without losing source", async ({
  page,
}) => {
  await page.goto("/markdown-editor-diagram");
  const editor = page.getByTestId("tiptap-markdown-editor");
  const source = editor.locator("[data-markdown-diagram-source]");
  await expect(editor.getByRole("img", { name: /^Mermaid flowchart diagram/ })).toBeVisible();
  const original = await source.textContent();
  await editor.getByText("Text after the diagram.").click();
  await editor.evaluate((node) => {
    node.focus();
    const paragraph = node.querySelector("p:last-child")!;
    const selection = window.getSelection()!;
    selection.collapse(paragraph.firstChild, 0);
  });
  await page.keyboard.press("ArrowLeft");
  await expect(source).toHaveAttribute("data-state", "open");
  await page.keyboard.press("ArrowRight");
  await expect(source).toHaveAttribute("data-state", "collapsed");
  await expect(source).toHaveText(original!);
});

for (const control of ["canvas", "toolbar"] as const) {
  for (const modifier of ["Meta", "Control"]) {
    test(`${modifier}+S saves edits with focus on the diagram ${control}`, async ({ page }) => {
      await page.goto("/markdown-editor-diagram");
      const editor = page.getByTestId("tiptap-markdown-editor");
      await editor.getByRole("button", { name: "Edit source" }).click();
      await expect(editor.locator("[data-markdown-diagram-source]")).toHaveAttribute(
        "data-state",
        "open",
      );
      await expect(editor).toBeFocused();
      await page.keyboard.type("\n  B --> C[SavedEdit]");
      await expect(editor.locator("[data-markdown-diagram-source]")).toContainText(
        "B --> C[SavedEdit]",
      );
      await editor.getByText("Text after the diagram.").click();
      const canvas = editor.getByRole("img", { name: /^Mermaid flowchart diagram/ });
      await expect(canvas).toBeVisible();
      const target =
        control === "canvas" ? canvas : editor.getByRole("button", { name: "Zoom in" });
      await target.focus();
      await expect(target).toBeFocused();
      await page.keyboard.press(`${modifier}+s`);
      await expect(page.getByLabel("Save count")).toHaveText("1");
      await expect(page.getByLabel("Saved Markdown")).toContainText("B --> C[SavedEdit]");
      await expect(page.getByLabel("Saved Markdown")).toContainText("```mermaid");
    });
  }
}
