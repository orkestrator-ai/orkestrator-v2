function isUnfocusedTarget(target: EventTarget | null): boolean {
  // Keydown lands on the window, document or body when nothing has focus.
  return (
    !(target instanceof Node) ||
    target === document ||
    target === document.body ||
    target === document.documentElement
  );
}

function isOutsideModalOpen(pane: Element | null): boolean {
  for (const modal of document.querySelectorAll('[aria-modal="true"]')) {
    if (!pane || !modal.contains(pane)) return true;
  }
  return false;
}

/** Shared pane ownership for window-level agent keyboard shortcuts. */
export function isAgentShortcutInScope(
  target: EventTarget | null,
  scope: HTMLElement | null,
): boolean {
  // PaneLeafContainer and pane-less hosts mark the full agent surface.
  const pane = scope?.closest("[data-pane-leaf], [data-agent-scope]") ?? scope;
  return (
    (target instanceof Node && Boolean(pane?.contains(target))) ||
    (isUnfocusedTarget(target) && !isOutsideModalOpen(pane))
  );
}
