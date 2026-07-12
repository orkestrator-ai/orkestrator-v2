import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FileMentionMenu } from "./FileMentionMenu";
import type { FileCandidate } from "@/types";

const files: FileCandidate[] = [
  { filename: "Button.tsx", relativePath: "src/components/Button.tsx", isDirectory: false },
  { filename: "hooks", relativePath: "src/hooks", isDirectory: true },
];

describe("FileMentionMenu", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    cleanup();
  });

  test("renders an empty state when no files match", () => {
    render(<FileMentionMenu files={[]} selectedIndex={0} onSelect={() => {}} onClose={() => {}} />);

    expect(screen.getByRole("status").textContent).toBe("No files or folders found");
  });

  test("selects a file on left mouse down without waiting for blur-prone click", () => {
    const onSelect = mock(() => {});

    render(<FileMentionMenu files={files} selectedIndex={0} onSelect={onSelect} onClose={() => {}} />);

    fireEvent.mouseDown(screen.getByRole("option", { name: /Button.tsx/ }), { button: 0 });

    expect(onSelect).toHaveBeenCalledWith(files[0]);
  });

  test("ignores non-left mouse down (e.g. right click)", () => {
    const onSelect = mock(() => {});

    render(<FileMentionMenu files={files} selectedIndex={0} onSelect={onSelect} onClose={() => {}} />);

    fireEvent.mouseDown(screen.getByRole("option", { name: /Button.tsx/ }), { button: 2 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  test("supports keyboard-originated button activation", () => {
    const onSelect = mock(() => {});

    render(<FileMentionMenu files={files} selectedIndex={1} onSelect={onSelect} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("option", { name: /hooks/ }), { detail: 0 });

    expect(onSelect).toHaveBeenCalledWith(files[1]);
  });

  test("highlights the selected option with the input-bar popup treatment", () => {
    render(<FileMentionMenu files={files} selectedIndex={0} onSelect={() => {}} onClose={() => {}} />);

    const selectedOption = screen.getByRole("option", { name: /Button.tsx/ });
    const unselectedOption = screen.getByRole("option", { name: /hooks/ });

    expect(selectedOption.className).toContain("bg-zinc-800/80");
    expect(selectedOption.className).toContain("text-foreground");
    expect(unselectedOption.className).not.toContain("bg-zinc-800/80");
  });

  test("closes when clicking outside the menu", () => {
    const onClose = mock(() => {});

    render(<FileMentionMenu files={files} selectedIndex={0} onSelect={() => {}} onClose={onClose} />);

    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalled();
  });

  test("keeps the selected option scrolled into view", () => {
    const scrollIntoView = mock(() => {});
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const { rerender } = render(
      <FileMentionMenu files={files} selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    );

    rerender(
      <FileMentionMenu files={files} selectedIndex={1} onSelect={() => {}} onClose={() => {}} />,
    );

    expect(scrollIntoView).toHaveBeenCalled();
  });
});
