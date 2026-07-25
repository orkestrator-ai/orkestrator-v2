import { expect, test, type Locator } from "@playwright/test";

const pathCases = [
  {
    kind: "posix",
    fullPath: "packages/a-very-long-directory-name/src/components/ImportantButton.tsx",
    directory: "packages/a-very-long-directory-name/src/components",
    separator: "/",
    filename: "ImportantButton.tsx",
  },
  {
    kind: "windows",
    fullPath: String.raw`packages\a-very-long-directory-name\src\components\ImportantPanel.tsx`,
    directory: String.raw`packages\a-very-long-directory-name\src\components`,
    separator: "\\",
    filename: "ImportantPanel.tsx",
  },
] as const;

async function setPaneWidth(pane: Locator, width: number) {
  await pane.evaluate((element, nextWidth) => {
    element.style.width = `${nextWidth}px`;
  }, width);
}

async function pathGeometry(
  path: Locator,
  directory: string,
  separator: string,
  filename: string,
  renderer: "changed-file" | "diff-header",
) {
  return path.evaluate(
    (element, expected) => {
      const visualPath = expected.renderer === "diff-header"
        ? element.querySelector('[aria-hidden="true"]')
        : element.children[1];
      if (!visualPath) throw new Error("Missing visual path");

      const [directoryElement, filenameElement] = Array.from(visualPath.children);
      if (!(directoryElement instanceof HTMLElement) || !(filenameElement instanceof HTMLElement)) {
        throw new Error("Expected directory and filename elements");
      }

      const characterBox = (container: HTMLElement, characterIndex: number) => {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let remaining = characterIndex;
        let node = walker.nextNode();
        while (node instanceof Text) {
          if (remaining < node.length) {
            const range = document.createRange();
            range.setStart(node, remaining);
            range.setEnd(node, remaining + 1);
            return range.getBoundingClientRect();
          }
          remaining -= node.length;
          node = walker.nextNode();
        }
        throw new Error(`Missing character at index ${characterIndex}`);
      };

      const visualBox = visualPath.getBoundingClientRect();
      const directoryBox = directoryElement.getBoundingClientRect();
      const filenameBox = filenameElement.getBoundingClientRect();
      const directoryCharacters = Array.from(
        { length: expected.directory.length },
        (_, index) => characterBox(directoryElement, index),
      );
      const directoryLast = directoryCharacters.at(-1)!;
      const separatorBox = characterBox(filenameElement, 0);
      const filenameFirst = characterBox(filenameElement, expected.separator.length);
      const filenameLast = characterBox(
        filenameElement,
        expected.separator.length + expected.filename.length - 1,
      );
      const isVisible = (box: DOMRect) =>
        box.right > visualBox.left && box.left < visualBox.right;

      return {
        renderedDirectory: directoryElement.textContent,
        renderedFilename: filenameElement.textContent,
        adjacentSegments: Math.abs(directoryBox.right - filenameBox.left) <= 1,
        directoryCharactersStayLtr: directoryCharacters.every(
          (box, index) => index === 0 || directoryCharacters[index - 1]!.left <= box.left + 1,
        ),
        separatorBeforeFilename: separatorBox.left < filenameFirst.left,
        directoryEndsBeforeSeparator: directoryLast.right <= separatorBox.left + 1,
        separatorVisible: isVisible(separatorBox),
        filenameFirstVisible: isVisible(filenameFirst),
        filenameLastVisible: isVisible(filenameLast),
        directoryIsTruncated:
          directoryElement.scrollWidth > directoryElement.clientWidth,
      };
    },
    { directory, separator, filename, renderer },
  );
}

async function expectPathLayout({
  path,
  pane,
  directory,
  separator,
  filename,
  renderer,
  wideWidth,
  narrowWidth,
}: {
  path: Locator;
  pane: Locator;
  directory: string;
  separator: string;
  filename: string;
  renderer: "changed-file" | "diff-header";
  wideWidth: number;
  narrowWidth: number;
}) {
  const expectedBase = {
    renderedDirectory: directory,
    renderedFilename: `${separator}${filename}`,
    adjacentSegments: true,
    directoryCharactersStayLtr: true,
    separatorBeforeFilename: true,
    directoryEndsBeforeSeparator: true,
    separatorVisible: true,
    filenameFirstVisible: true,
    filenameLastVisible: true,
  };

  await setPaneWidth(pane, wideWidth);
  await expect
    .poll(() => pathGeometry(path, directory, separator, filename, renderer))
    .toEqual({
      ...expectedBase,
      directoryIsTruncated: false,
    });

  await setPaneWidth(pane, narrowWidth);
  await expect
    .poll(() => pathGeometry(path, directory, separator, filename, renderer))
    .toEqual({
      ...expectedBase,
      directoryIsTruncated: true,
  });
}

async function expectAccessibleFullPath(path: Locator, fullPath: string) {
  const accessibilitySnapshot = await path.ariaSnapshot();
  expect(accessibilitySnapshot.replaceAll(/\s/g, "")).toContain(
    fullPath.replaceAll(/\s/g, ""),
  );
}

test("wide and narrow paths keep their separator and filename in visual order", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "one Chromium layout engine run covers both explicit pane widths",
  );
  await page.goto("/path-truncation");

  const changedFilePane = page.getByTestId("changed-file-path-pane");
  const changedFilePath = changedFilePane.getByTitle(pathCases[0].fullPath);
  await expect(changedFilePath).toBeVisible();
  await expectPathLayout({
    path: changedFilePath,
    pane: changedFilePane,
    directory: pathCases[0].directory,
    separator: pathCases[0].separator,
    filename: pathCases[0].filename,
    renderer: "changed-file",
    wideWidth: 640,
    narrowWidth: 260,
  });
  await expectAccessibleFullPath(changedFilePath, pathCases[0].fullPath);

  for (const pathCase of pathCases) {
    const pane = page.getByTestId(`${pathCase.kind}-path-pane`);
    const path = pane.getByTitle(pathCase.fullPath);
    await expect(path).toBeVisible();
    await expectPathLayout({
      path,
      pane,
      directory: pathCase.directory,
      separator: pathCase.separator,
      filename: pathCase.filename,
      renderer: "diff-header",
      wideWidth: 900,
      narrowWidth: 440,
    });
    await expectAccessibleFullPath(path, pathCase.fullPath);
  }
});
