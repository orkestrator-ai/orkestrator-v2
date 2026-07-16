import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("mobile responsive layout contracts", () => {
  test.each([
    ["apps/web/src/components/chat/FileMentionMenu.tsx", "w-full min-w-0", "sm:w-96"],
    ["apps/web/src/components/chat/NativeComposeDock.tsx", "px-2", "sm:px-4"],
    ["apps/web/src/components/chat/VirtualizedMessageList.tsx", "min-w-0"],
    ["apps/web/src/components/claude/ClaudeComposeBar.tsx", "overflow-x-auto", "sm:min-w-[340px]"],
    ["apps/web/src/components/claude/ClaudeTmuxChatTab.tsx", "overflow-x-auto", "sm:w-[min(calc(100%_-_2rem),56rem)]"],
    ["apps/web/src/components/codex/CodexComposeBar.tsx", "overflow-x-auto", "w-[calc(100vw-1rem)]"],
    ["apps/web/src/components/opencode/OpenCodeComposeBar.tsx", "overflow-x-auto", "w-[calc(100vw-1rem)]"],
    ["apps/web/src/components/docker/DockerStatsDialog.tsx", "grid-cols-1 gap-3 sm:grid-cols-3"],
    [
      "apps/web/src/components/environments/CreateEnvironmentDialog.tsx",
      "grid-cols-1 gap-2 sm:grid-cols-2",
      'aria-label="Environment configuration sections"',
      "data-[state=inactive]:hidden",
      "sm:!contents",
    ],
    ["apps/web/src/components/environments/EnvironmentSettingsDialog.tsx", "grid-cols-2 gap-2 sm:grid-cols-4"],
    ["apps/web/src/components/kanban/KanbanBoard.tsx", "snap-x snap-mandatory", "sm:w-[320px]"],
    ["apps/web/src/components/layout/ActionBar.tsx", "data-mobile-toolbar", "grid-cols-2", "md:h-12"],
    ["apps/web/src/components/pane-layout/DraggableTab.tsx", "md:opacity-0", "h-7 w-7"],
    ["apps/web/src/components/pane-layout/DraggableTabBar.tsx", "overflow-x-auto", "md:min-h-[32px]"],
    ["apps/web/src/components/ui/alert-dialog.tsx", "max-h-[calc(100dvh-1rem)]", "overflow-y-auto"],
    ["apps/web/src/components/ui/dialog.tsx", "max-h-[calc(100dvh-1rem)]", "overflow-y-auto"],
  ])("keeps %s usable at narrow widths", (file, ...contracts) => {
    const source = read(file);
    for (const contract of contracts) expect(source).toContain(contract);
  });

  test("global touch rules prevent viewport zoom and oversized menus", () => {
    const css = read("apps/web/src/index.css");
    expect(css).toContain("touch-action: manipulation");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain("font-size: 16px");
    expect(css).toContain("max-width: calc(100vw - 1rem)");
    expect(css).toContain("min-height: 2.75rem");
  });
});
