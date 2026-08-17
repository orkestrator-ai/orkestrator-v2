import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { TruncatedPath } from "./truncated-path";

afterEach(cleanup);

// These assertions cover the markup contract only. The behaviour the markup buys
// — truncating the directory from its start, and keeping a leading neutral
// character at the start of the segment — is layout, and is covered in a real
// browser by e2e/PathTruncation.spec.ts.
describe("TruncatedPath", () => {
  test("renders the directory and basename as the container's only two children", () => {
    render(<TruncatedPath directory="src/components" filename="Button.tsx" />);

    const container = screen.getByText("src/components").parentElement!.parentElement!;
    expect(container.dataset.slot).toBe("truncated-path");
    expect(container.className).toContain("flex");
    expect(container.className).toContain("min-w-0");
    expect(container.className).toContain("overflow-hidden");
    expect(container.childElementCount).toBe(2);
    expect(container.children[0]?.textContent).toBe("src/components");
    expect(container.children[1]?.textContent).toBe("/Button.tsx");
  });

  test("truncates the directory RTL while keeping its text in an LTR bidi isolate", () => {
    render(<TruncatedPath directory=".playwright-mcp" filename="trace.yml" />);

    const isolate = screen.getByText(".playwright-mcp");
    expect(isolate.tagName).toBe("BDI");
    expect(isolate.getAttribute("dir")).toBe("ltr");

    const directory = isolate.parentElement!;
    expect(directory.className).toContain("[direction:rtl]");
    expect(directory.className).toContain("truncate");
    expect(directory.className).toContain("shrink");
    expect(directory.className).not.toContain("shrink-0");
  });

  test("keeps the basename unshrinkable so the directory absorbs the truncation", () => {
    render(<TruncatedPath directory="src" filename="Button.tsx" />);

    const filename = screen.getByText("/Button.tsx");
    expect(filename.className).toContain("shrink-0");
    expect(filename.className).toContain("max-w-full");
    expect(filename.className).toContain("truncate");
  });

  test("uses the supplied separator", () => {
    render(
      <TruncatedPath
        directory={String.raw`src\components`}
        separator={"\\"}
        filename="Button.tsx"
      />,
    );

    expect(screen.getByText(String.raw`\Button.tsx`)).toBeTruthy();
  });

  test.each([
    { name: "empty", directory: "" },
    { name: "null", directory: null },
    { name: "omitted", directory: undefined },
  ])("renders the basename alone and no separator for a $name directory", ({ directory }) => {
    render(<TruncatedPath directory={directory} filename="README.md" />);

    const filename = screen.getByText("README.md");
    expect(filename.parentElement?.childElementCount).toBe(1);
    expect(screen.queryByText("/") === null).toBe(true);
  });

  test("merges caller classes and forwards span attributes", () => {
    render(
      <TruncatedPath
        aria-hidden="true"
        className="items-baseline text-xs"
        directory="src"
        filename="Button.tsx"
        directoryClassName="text-muted-foreground"
        filenameClassName="text-foreground"
      />,
    );

    const isolate = screen.getByText("src");
    const container = isolate.parentElement!.parentElement!;
    expect(container.getAttribute("aria-hidden")).toBe("true");
    expect(container.className).toContain("items-baseline");
    expect(container.className).toContain("text-xs");
    expect(container.className).toContain("overflow-hidden");
    expect(isolate.parentElement?.className).toContain("text-muted-foreground");
    expect(screen.getByText("/Button.tsx").className).toContain("text-foreground");
  });
});
