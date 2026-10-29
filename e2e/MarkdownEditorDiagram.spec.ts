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
