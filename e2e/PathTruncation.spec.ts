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
  {
    // A leading "." and a leading "(" are bidi-neutral. Under the RTL truncation
    // direction the bidi algorithm resolves them to the embedding level and moves
    // them to the visual end — ".playwright-mcp" renders as "playwright-mcp." —
    // unless the directory text sits in its own LTR isolate. Both segments are
    // shorter than the posix case, so a wide pane must not truncate this one.
    kind: "dotted",
    fullPath: ".playwright-mcp/(a-very-long-group)/src/ImportantTrace.yml",
    directory: ".playwright-mcp/(a-very-long-group)/src",
    separator: "/",
    filename: "ImportantTrace.yml",
  },
] as const;

const changedFilePanes = [
  { pane: "changed-file-path-pane", pathCase: pathCases[0] },
  { pane: "changed-file-dotted-path-pane", pathCase: pathCases[2] },
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
) {
  return path.evaluate(
    (element, expected) => {
      // Both renderers delegate to the same TruncatedPath component.
      const visualPath = element.querySelector('[data-slot="truncated-path"]');
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
    { directory, separator, filename },
  );
}

async function expectPathLayout({
  path,
  pane,
  directory,
  separator,
  filename,
  wideWidth,
  narrowWidth,
}: {
  path: Locator;
  pane: Locator;
  directory: string;
  separator: string;
  filename: string;
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
    .poll(() => pathGeometry(path, directory, separator, filename))
    .toEqual({
      ...expectedBase,
      directoryIsTruncated: false,
    });

  await setPaneWidth(pane, narrowWidth);
  await expect
    .poll(() => pathGeometry(path, directory, separator, filename))
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

async function changedFileTypography(path: Locator) {
  return path.evaluate((element) => {
    const visualPath = element.querySelector('[data-slot="truncated-path"]');
    if (!(visualPath instanceof HTMLElement)) {
      throw new Error("Missing changed-file visual path");
    }

    const [directoryElement, filenameElement] = Array.from(visualPath.children);
    if (
      !(directoryElement instanceof HTMLElement)
      || !(filenameElement instanceof HTMLElement)
    ) {
      throw new Error("Expected changed-file directory and filename elements");
    }

    const textBox = (container: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(container);
      return range.getBoundingClientRect();
    };
    const directoryBox = textBox(directoryElement);
    const filenameBox = textBox(filenameElement);

    return {
      alignItems: getComputedStyle(visualPath).alignItems,
      directoryFontSize: getComputedStyle(directoryElement).fontSize,
      filenameFontSize: getComputedStyle(filenameElement).fontSize,
      textBottomDelta: Math.abs(directoryBox.bottom - filenameBox.bottom),
    };
  });
}

test("wide and narrow paths preserve filename order and changed-file typography", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "one Chromium layout engine run covers both explicit pane widths",
  );
  await page.goto("/path-truncation");

  for (const { pane: paneId, pathCase } of changedFilePanes) {
    const pane = page.getByTestId(paneId);
    const path = pane.getByTitle(pathCase.fullPath);
    await expect(path).toBeVisible();
    await expectPathLayout({
      path,
      pane,
      directory: pathCase.directory,
      separator: pathCase.separator,
      filename: pathCase.filename,
      wideWidth: 640,
      narrowWidth: 260,
    });
    await expectAccessibleFullPath(path, pathCase.fullPath);
  }

  const changedFilePath = page
    .getByTestId(changedFilePanes[0].pane)
    .getByTitle(changedFilePanes[0].pathCase.fullPath);
  const typography = await changedFileTypography(changedFilePath);
  expect(typography).toMatchObject({
    alignItems: "baseline",
    directoryFontSize: "12px",
    filenameFontSize: "12px",
  });
  expect(typography.textBottomDelta).toBeLessThanOrEqual(1);

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
      wideWidth: 900,
      narrowWidth: 440,
    });
    await expectAccessibleFullPath(path, pathCase.fullPath);
  }
});
