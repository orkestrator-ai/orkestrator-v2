import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("mobile responsive layout contracts", () => {
  test.each([
    [
      "apps/web/src/components/browser/BrowserTab.tsx",
      "@container/browser",
      "basis-full",
      "@md/browser:flex-nowrap",
      "overflow-hidden",
    ],
    ["apps/web/src/components/chat/FileMentionMenu.tsx", "w-full min-w-0", "sm:w-96"],
    ["apps/web/src/components/chat/NativeComposeDock.tsx", "px-2", "sm:px-4"],
    [
      "apps/web/src/components/chat/AgentModelPicker.tsx",
      "w-[calc(100vw-1rem)]",
      "collisionPadding={{ top: 52, right: 8, bottom: 8, left: 8 }}",
      "overflow-y-auto",
    ],
    ["apps/web/src/components/chat/VirtualizedMessageList.tsx", "min-w-0"],
    ["apps/web/src/components/chat/NativeComposeBar.tsx", "overflow-x-auto"],
    [
      "apps/web/src/components/claude/ClaudeTmuxChatTab.parts.tsx",
      "overflow-x-auto",
      "sm:w-[min(calc(100%_-_2rem),56rem)]",
    ],
    ["apps/web/src/components/docker/DockerStatsDialog.tsx", "grid-cols-1 gap-3 sm:grid-cols-3"],
    [
      "apps/web/src/components/environments/CreateEnvironmentDialog.tsx",
      "grid-cols-1 gap-2 sm:grid-cols-2",
      'aria-label="Environment configuration sections"',
      "data-[state=inactive]:hidden",
      "create-environment-mobile-tab-panel",
      "sm:!contents",
    ],
    // The agent controls the environment dialog used to own now live in the
    // panes it shares with the repository and app tiers, so the contract
    // follows them there rather than being dropped.
    [
      "apps/web/src/components/settings/agent/InheritedValue.tsx",
      "grid grid-cols-1 gap-2",
      "sm:grid-cols-3",
    ],
    [
      "apps/web/src/components/settings/agent/AgentDefaultsPane.tsx",
      "grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3",
    ],
    ["apps/web/src/components/kanban/KanbanBoard.tsx", "snap-x snap-mandatory", "sm:w-[320px]"],
    [
      "apps/web/src/components/layout/ActionBar.view.tsx",
      "data-mobile-toolbar",
      "grid-cols-2",
      "md:h-12",
    ],
    ["apps/web/src/components/pane-layout/DraggableTab.tsx", "md:opacity-0", "h-7 w-7"],
    [
      "apps/web/src/components/pane-layout/DraggableTabBar.tsx",
      "overflow-x-auto",
      "md:min-h-[32px]",
    ],
    ["apps/web/src/components/ui/alert-dialog.tsx", "max-h-[calc(100dvh-1rem)]", "overflow-y-auto"],
    ["apps/web/src/components/ui/dialog.tsx", "max-h-[calc(100dvh-1rem)]", "overflow-y-auto"],
  ])("keeps %s usable at narrow widths", (file, ...contracts) => {
    const source = read(file);
    for (const contract of contracts) expect(source).toContain(contract);
  });

  test("native model picker inherits viewport bounds and owns per-column scrolling", () => {
    const picker = read("apps/web/src/components/chat/AgentModelPicker.tsx");
    const dropdown = read("apps/web/src/components/ui/dropdown-menu.tsx");

    expect(picker).toContain("<DropdownMenuContent");
    expect(dropdown).toContain("max-h-(--radix-dropdown-menu-content-available-height)");
    expect(dropdown).toContain("overflow-y-auto");
    expect(picker).toContain("md:overflow-hidden");
    expect(picker).toContain("data-native-model-list");
    expect(picker).toContain("data-native-reasoning-list");
    expect(picker).toContain("data-native-speed-list");
  });

  test("global touch rules prevent viewport zoom and oversized menus", () => {
    const css = read("apps/web/src/index.css");
    expect(css).toContain("touch-action: manipulation");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain("font-size: 16px");
    expect(css).toContain("max-width: calc(100vw - 1rem)");
    expect(css).toContain("min-height: 2.75rem");
  });

  test("the native compose bar keeps context usage visible at mobile widths", () => {
    const source = read("apps/web/src/components/chat/NativeComposeBar.tsx");
    expect(source).toContain("<ContextUsageWheel usage={contextUsage}");
    expect(source).not.toContain("!isMobile && <ContextUsageWheel");
  });

  test("message actions only opt into hidden hover controls for precise pointers", () => {
    const css = read("apps/web/src/index.css");
    const messageShell = read("apps/web/src/components/chat/MessageShell.tsx");

    expect(css).toContain("@custom-variant hover-fine");
    expect(css).toContain("@media (hover: hover) and (pointer: fine)");
    expect(messageShell).toContain("opacity-100");
    expect(messageShell).toContain("md:hover-fine:opacity-0");
    expect(messageShell).toContain("md:hover-fine:group-hover:opacity-100");
    expect(messageShell).toContain("md:hover-fine:focus-within:opacity-100");
    expect(messageShell).not.toContain("md:opacity-0 md:group-hover:opacity-100");
  });

  test("touch compose input uses real font geometry instead of transform scaling", () => {
    const css = read("apps/web/src/index.css");
    const iosComposeRule = css.match(
      /@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?\.native-compose-input \{([\s\S]*?)\n  \}/,
    )?.[1];
    const iosPlaceholderRule = css.match(
      /@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?\.native-compose-placeholder \{([\s\S]*?)\n  \}/,
    )?.[1];

    expect(iosComposeRule).toBeTruthy();
    expect(iosComposeRule).toContain("font-size: 16px");
    expect(iosComposeRule).toContain("line-height: 1.25rem");
    expect(iosComposeRule).not.toContain("transform");
    expect(iosComposeRule).not.toContain("width:");
    expect(iosPlaceholderRule).toBeTruthy();
    expect(iosPlaceholderRule).toContain("font-size: 16px");
    expect(iosPlaceholderRule).toContain("line-height: 1.25rem");
    expect(css).not.toContain(".native-compose-input-viewport");
  });

  test("connecting logos honor reduced motion", () => {
    const css = read("apps/web/src/index.css");
    expect(css).toContain(".agent-connecting-logo {");
    expect(css).toContain("animation: agent-connecting-pulse 1.6s ease-in-out infinite;");
    expect(css).toContain(`@media (prefers-reduced-motion: reduce) {
  .agent-connecting-logo {
    animation: none;
    opacity: 1;
    filter: none;
  }
}`);
  });

  test("chat status rows keep stable geometry and honor reduced motion", () => {
    const css = read("apps/web/src/index.css");
    expect(css).toContain(`.chat-status-row {
  display: flex;
  align-items: center;
  height: 2.5rem;
}`);
    expect(css).toContain(`.chat-status-row > * {
  animation: chat-status-enter 180ms ease-out both;
}`);
    expect(css).toContain(`@media (prefers-reduced-motion: reduce) {
  .chat-status-row > * {
    animation: none;
  }
}`);
  });

  test("mobile environment tab animations preserve direction and motion preferences", () => {
    const css = read("apps/web/src/index.css");

    expect(css).toContain(`@keyframes create-environment-tab-enter-forward {
  from {
    opacity: 0;
    transform: translateX(0.75rem);
  }

  to {
    opacity: 1;
    transform: translateX(0);
  }
}`);
    expect(css).toContain(`@keyframes create-environment-tab-enter-backward {
  from {
    opacity: 0;
    transform: translateX(-0.75rem);
  }

  to {
    opacity: 1;
    transform: translateX(0);
  }
}`);
    expect(css).toContain(`@media (max-width: 639px) and (prefers-reduced-motion: no-preference) {
  .create-environment-mobile-tab-panel[data-state="active"][data-mobile-transition="forward"] {
    animation: create-environment-tab-enter-forward 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  .create-environment-mobile-tab-panel[data-state="active"][data-mobile-transition="backward"] {
    animation: create-environment-tab-enter-backward 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
}`);
  });
});
