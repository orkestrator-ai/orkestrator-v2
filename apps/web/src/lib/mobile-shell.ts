export const MOBILE_SHELL_MEDIA_QUERY = "(max-width: 767px)";

const drawerNavigationListeners = new Set<() => void>();

/**
 * An environment was chosen from the projects list. The phone layout's
 * drawer gives way to it even when the choice is the environment already
 * shown: a reload restores the last selection (plan item 3006) while the
 * drawer opens on first load, and choosing that same row changes no
 * selection for the drawer to close on (4006's capped-file-tree smoke
 * failure). Nothing listens on a desktop-width layout.
 */
export function noteDrawerNavigation(): void {
  for (const listener of Array.from(drawerNavigationListeners)) listener();
}

/** Follow {@link noteDrawerNavigation}; returns the stop. */
export function onDrawerNavigation(listener: () => void): () => void {
  drawerNavigationListeners.add(listener);
  return () => {
    drawerNavigationListeners.delete(listener);
  };
}
