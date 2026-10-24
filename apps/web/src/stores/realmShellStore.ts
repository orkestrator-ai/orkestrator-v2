import { create } from "zustand";
import type { RealmGrouping } from "@/lib/federation/workspace-realm";

/**
 * Realm side: what the window this realm is embedded in has said about
 * itself. A realm has its own storage, so it cannot read the window's
 * presentation state; the window sends it (see `WorkspaceRealmHost`).
 */
interface RealmShellState {
  /** The window's sidebar grouping; null until the window has said. */
  grouping: RealmGrouping | null;
}

export const useRealmShellStore = create<RealmShellState>()(() => ({ grouping: null }));
