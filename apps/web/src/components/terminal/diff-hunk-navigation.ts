/**
 * Hunk and file navigation for the diff tab (`DiffViewerTab.tsx`).
 *
 * Navigation walks the backend's hunks in display order: every hunk of the
 * first file, then every hunk of the next. A position is an index into that
 * order. Files without hunks (binary, unavailable) are skipped by file
 * navigation, because there is nothing in them to land on.
 */

export interface HunkPosition {
  fileIndex: number;
  hunkIndex: number;
}

export interface HunkLayout {
  positions: HunkPosition[];
  /** Position of each file's first hunk; null for a file with none. */
  fileStarts: Array<number | null>;
}

export function hunkLayout(files: readonly { hunks: readonly unknown[] }[]): HunkLayout {
  const positions: HunkPosition[] = [];
  const fileStarts: Array<number | null> = [];
  files.forEach((file, fileIndex) => {
    fileStarts.push(file.hunks.length > 0 ? positions.length : null);
    file.hunks.forEach((_hunk, hunkIndex) => positions.push({ fileIndex, hunkIndex }));
  });
  return { positions, fileStarts };
}

export type DiffNavigationCommand = "next-hunk" | "previous-hunk" | "next-file" | "previous-file";

/** The position a command moves to from `current` (null: nothing selected yet). */
export function navigate(
  layout: HunkLayout,
  current: number | null,
  command: DiffNavigationCommand,
): number | null {
  const count = layout.positions.length;
  if (count === 0) return null;
  if (command === "next-hunk") return current === null ? 0 : Math.min(current + 1, count - 1);
  if (command === "previous-hunk") return current === null ? 0 : Math.max(current - 1, 0);
  const file = current === null ? null : (layout.positions[current]?.fileIndex ?? null);
  const starts = layout.fileStarts;
  if (command === "next-file") {
    for (let index = file === null ? 0 : file + 1; index < starts.length; index++) {
      if (starts[index] !== null) return starts[index]!;
    }
    return current;
  }
  if (file === null) return layout.fileStarts.find((start) => start !== null) ?? null;
  // Previous file: from inside a file, go to the start of the one before it.
  for (let index = file - 1; index >= 0; index--) {
    if (starts[index] !== null) return starts[index]!;
  }
  return starts[file] ?? current;
}

/** Keyboard shortcuts, shown in the navigation buttons' titles. */
export const NAVIGATION_SHORTCUTS: Record<DiffNavigationCommand, { label: string; aria: string }> =
  {
    "next-hunk": { label: "] or Alt+↓", aria: "] Alt+ArrowDown" },
    "previous-hunk": { label: "[ or Alt+↑", aria: "[ Alt+ArrowUp" },
    "next-file": { label: "} or Alt+Shift+↓", aria: "} Alt+Shift+ArrowDown" },
    "previous-file": { label: "{ or Alt+Shift+↑", aria: "{ Alt+Shift+ArrowUp" },
  };

/** The navigation command a key press asks for, or null. */
export function navigationCommandForKey(event: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): DiffNavigationCommand | null {
  if (event.ctrlKey || event.metaKey) return null;
  if (event.altKey) {
    if (event.key === "ArrowDown") return event.shiftKey ? "next-file" : "next-hunk";
    if (event.key === "ArrowUp") return event.shiftKey ? "previous-file" : "previous-hunk";
    return null;
  }
  switch (event.key) {
    case "]":
      return "next-hunk";
    case "[":
      return "previous-hunk";
    case "}":
      return "next-file";
    case "{":
      return "previous-file";
    default:
      return null;
  }
}

/** Whether a key press belongs to a text field rather than the diff. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  return (
    element.isContentEditable ||
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  );
}
