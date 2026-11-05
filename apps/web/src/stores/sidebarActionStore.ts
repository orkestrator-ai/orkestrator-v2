import { create } from "zustand";

/** Claims live beyond a row mount and are released only when its request settles. */
export const useSidebarActionStore = create<{ pending: ReadonlySet<string> }>(() => ({
  pending: new Set<string>(),
}));

export function claimSidebarAction(id: string): boolean {
  const { pending } = useSidebarActionStore.getState();
  if (pending.has(id)) return false;
  useSidebarActionStore.setState({ pending: new Set([...pending, id]) });
  return true;
}

export function releaseSidebarAction(id: string): void {
  const pending = new Set(useSidebarActionStore.getState().pending);
  pending.delete(id);
  useSidebarActionStore.setState({ pending });
}
