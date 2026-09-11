import type { ApplicationMenuWindow } from "./application-menu.js";

export type MenuSourceWindow = {
  isDestroyed(): boolean;
  getTitle(): string;
};

/** A context whose only menu-relevant member is the window it wraps. */
export type MenuSourceContext = {
  window: MenuSourceWindow;
};

/**
 * Project the live desktop windows into the plain data the menu template
 * renders. Destroyed windows are skipped before their title is read so a
 * window that is mid-teardown can neither appear in the list nor throw.
 */
export function projectMenuWindows<Context extends MenuSourceContext>(
  contexts: Iterable<[number, Context]>,
  focusedWindow: MenuSourceWindow | null | undefined,
): ApplicationMenuWindow[] {
  const windows: ApplicationMenuWindow[] = [];
  for (const [id, context] of contexts) {
    if (context.window.isDestroyed()) continue;
    windows.push({
      id,
      title: context.window.getTitle(),
      focused: context.window === focusedWindow,
    });
  }
  return windows;
}

export type FocusableWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

export type FocusableContext = {
  window: FocusableWindow;
};

/**
 * Restore, show and focus the window registered under `id`. A missing or
 * destroyed id is a no-op, so a click on a stale menu entry cannot throw.
 */
export function focusWindowById<Context extends FocusableContext>(
  contexts: ReadonlyMap<number, Context>,
  id: number,
): void {
  const context = contexts.get(id);
  if (!context || context.window.isDestroyed()) return;
  if (context.window.isMinimized()) context.window.restore();
  context.window.show();
  context.window.focus();
}

export type TitledWindow = {
  setTitle(title: string): void;
};

/**
 * Apply the connection-derived window title and refresh the application menu,
 * which is what keeps the Window list in step with a retitled window.
 */
export function applyWindowTitle(
  window: TitledWindow,
  productName: string,
  activeName: string | undefined,
  refreshMenu: () => void,
): void {
  window.setTitle(`${productName} — ${activeName ?? "Local"}`);
  refreshMenu();
}
