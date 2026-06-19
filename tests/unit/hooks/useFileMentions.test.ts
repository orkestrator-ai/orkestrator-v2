import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useFileMentions } from "@/hooks/useFileMentions";
import type { FileCandidate } from "@/types";
import type { KeyboardEvent } from "react";

const files: FileCandidate[] = [
  { filename: "alpha.ts", relativePath: "src/alpha.ts", isDirectory: false },
  { filename: "beta.ts", relativePath: "src/beta.ts", isDirectory: false },
  { filename: "gamma.ts", relativePath: "src/gamma.ts", isDirectory: false },
];

function keyEvent(key: string) {
  return {
    key,
    preventDefault: mock(() => {}),
    stopPropagation: mock(() => {}),
  } as unknown as KeyboardEvent;
}

describe("useFileMentions", () => {
  test("navigates file suggestions with arrow keys and selects with Enter", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
    });

    expect(result.current.isMenuOpen).toBe(true);
    expect(result.current.selectedIndex).toBe(0);

    const downEvent = keyEvent("ArrowDown");
    act(() => {
      expect(result.current.handleKeyDown(downEvent, onSelect)).toBe(true);
    });

    expect(downEvent.preventDefault).toHaveBeenCalled();
    expect(downEvent.stopPropagation).toHaveBeenCalled();
    expect(result.current.selectedIndex).toBe(1);

    const upEvent = keyEvent("ArrowUp");
    act(() => {
      expect(result.current.handleKeyDown(upEvent, onSelect)).toBe(true);
    });

    expect(upEvent.preventDefault).toHaveBeenCalled();
    expect(upEvent.stopPropagation).toHaveBeenCalled();
    expect(result.current.selectedIndex).toBe(0);

    const enterEvent = keyEvent("Enter");
    act(() => {
      expect(result.current.handleKeyDown(enterEvent, onSelect)).toBe(true);
    });

    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(enterEvent.stopPropagation).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(files[0]);
    expect(result.current.isMenuOpen).toBe(false);
  });

  test("wraps arrow navigation at menu boundaries", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
    });

    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowUp"), () => {});
    });
    expect(result.current.selectedIndex).toBe(files.length - 1);

    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowDown"), () => {});
    });
    expect(result.current.selectedIndex).toBe(0);
  });

  test("selects with Tab and resets menu state", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(3, "@be");
    });

    const tabEvent = keyEvent("Tab");
    act(() => {
      expect(result.current.handleKeyDown(tabEvent, onSelect)).toBe(true);
    });

    expect(tabEvent.preventDefault).toHaveBeenCalled();
    expect(tabEvent.stopPropagation).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(files[0]);
    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("does not reopen after Enter selects a file and cursor briefly lands inside the accepted mention", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(2, "@a");
    });

    const enterEvent = keyEvent("Enter");
    act(() => {
      expect(result.current.handleKeyDown(enterEvent, onSelect)).toBe(true);
    });

    expect(onSelect).toHaveBeenCalledWith(files[0]);
    expect(result.current.isMenuOpen).toBe(false);

    act(() => {
      result.current.handleCursorChange(3, "@alpha.ts ");
    });

    expect(result.current.isMenuOpen).toBe(false);

    act(() => {
      result.current.handleCursorChange("@alpha.ts ".length, "@alpha.ts ");
    });

    expect(result.current.isMenuOpen).toBe(false);
  });

  test("does not reopen after Tab or Space selects a file and cursor briefly lands inside the accepted mention", () => {
    for (const key of ["Tab", " "]) {
      const onSelect = mock(() => {});
      const { result, unmount } = renderHook(() =>
        useFileMentions({
          searchFiles: () => files,
        }),
      );

      act(() => {
        result.current.handleCursorChange(2, "@a");
      });

      act(() => {
        expect(result.current.handleKeyDown(keyEvent(key), onSelect)).toBe(true);
      });

      expect(onSelect).toHaveBeenCalledWith(files[0]);

      act(() => {
        result.current.handleCursorChange(3, "@alpha.ts ");
      });

      expect(result.current.isMenuOpen).toBe(false);
      unmount();
    }
  });

  test("suppresses transient reopen with case-insensitive accepted filenames", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.closeMenu({ suppressReopenFor: "Alpha.TS" });
    });

    act(() => {
      result.current.handleCursorChange(3, "@alpha.ts ");
    });

    expect(result.current.isMenuOpen).toBe(false);
  });

  test("does not reopen after closing for a mouse-selected file from an empty at trigger", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.closeMenu({ suppressReopenFor: "alpha.ts" });
    });

    act(() => {
      result.current.handleCursorChange(1, "@alpha.ts ");
    });

    expect(result.current.isMenuOpen).toBe(false);

    act(() => {
      result.current.handleCursorChange(1, "@");
    });

    expect(result.current.isMenuOpen).toBe(true);
  });

  test("selects with Space and resets menu state", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.setSelectedIndex(1);
    });

    const spaceEvent = keyEvent(" ");
    act(() => {
      expect(result.current.handleKeyDown(spaceEvent, onSelect)).toBe(true);
    });

    expect(spaceEvent.preventDefault).toHaveBeenCalled();
    expect(spaceEvent.stopPropagation).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(files[1]);
    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("selects with legacy Spacebar and resets menu state", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.setSelectedIndex(2);
    });

    const spacebarEvent = keyEvent("Spacebar");
    act(() => {
      expect(result.current.handleKeyDown(spacebarEvent, onSelect)).toBe(true);
    });

    expect(spacebarEvent.preventDefault).toHaveBeenCalled();
    expect(spacebarEvent.stopPropagation).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(files[2]);
    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("closes and resets selection with Escape", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.setSelectedIndex(2);
    });

    const escapeEvent = keyEvent("Escape");
    act(() => {
      expect(result.current.handleKeyDown(escapeEvent, () => {})).toBe(true);
    });

    expect(escapeEvent.preventDefault).toHaveBeenCalled();
    expect(escapeEvent.stopPropagation).toHaveBeenCalled();
    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("handles empty suggestion lists without falling through handled keys", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => [],
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
    });

    const enterEvent = keyEvent("Enter");
    act(() => {
      expect(result.current.handleKeyDown(enterEvent, onSelect)).toBe(true);
    });

    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(enterEvent.stopPropagation).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(result.current.isMenuOpen).toBe(true);

    act(() => {
      result.current.handleKeyDown(keyEvent("Escape"), onSelect);
    });
    expect(result.current.isMenuOpen).toBe(false);
  });

  test("lets Space continue text input when the menu has no suggestions", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => [],
      }),
    );

    act(() => {
      result.current.handleCursorChange(8, "@missing");
      result.current.setSelectedIndex(2);
    });

    const spaceEvent = keyEvent(" ");
    act(() => {
      expect(result.current.handleKeyDown(spaceEvent, onSelect)).toBe(false);
    });

    expect(spaceEvent.preventDefault).not.toHaveBeenCalled();
    expect(spaceEvent.stopPropagation).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("does not handle keys when the menu is closed", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    const enterEvent = keyEvent("Enter");

    expect(result.current.handleKeyDown(enterEvent, () => {})).toBe(false);
    expect(enterEvent.preventDefault).not.toHaveBeenCalled();
    expect(enterEvent.stopPropagation).not.toHaveBeenCalled();
  });

  test("resets selection when the search query changes", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.setSelectedIndex(2);
    });
    expect(result.current.selectedIndex).toBe(2);

    act(() => {
      result.current.handleCursorChange(2, "@b");
    });

    expect(result.current.searchQuery).toBe("b");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("closes through the explicit close callback", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.setSelectedIndex(1);
      result.current.closeMenu();
    });

    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("serializes mentions and creates mention metadata", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    const created = result.current.createMention(files[0]);

    expect(created.id).toBeTruthy();
    expect(created.filename).toBe("alpha.ts");
    expect(created.relativePath).toBe("src/alpha.ts");
    expect(
      result.current.serializeForLLM("Read @alpha.ts and @beta.ts", [
        created,
        { id: "mention-2", filename: "beta.ts", relativePath: "src/beta.ts" },
      ]),
    ).toBe("Read [@alpha.ts](src/alpha.ts) and [@beta.ts](src/beta.ts)");
  });

  test("serializes repeated mentions with regex-special filenames", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    expect(
      result.current.serializeForLLM("Open @foo.test.ts and @foo.test.ts", [
        {
          id: "mention-special",
          filename: "foo.test.ts",
          relativePath: "src/foo.test.ts",
        },
      ]),
    ).toBe(
      "Open [@foo.test.ts](src/foo.test.ts) and [@foo.test.ts](src/foo.test.ts)",
    );
  });
});
