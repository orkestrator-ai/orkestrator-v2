import { create } from "zustand";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";

/**
 * Whether the global Settings page is showing, and on which section.
 *
 * Settings open from surfaces that can unmount under them (the sidebar's
 * bottom bar inside the mobile projects drawer, the ⌘, shortcut, the desktop
 * menu), so the state lives here and `GlobalSettingsHost`, which `AppShell`
 * renders outside both layouts, shows the page. Other trees still ask through
 * `requestGlobalSettings` (`@/lib/settings-navigation`), which the host feeds
 * into this store, so a workspace realm keeps forwarding to its window.
 */
interface GlobalSettingsState {
  open: boolean;
  /** The section to show; without one, the first section. */
  section: GlobalSettingsSection | undefined;
  /** Bumped per section request so a repeat request for the same section navigates. */
  sectionRequest: number;
  /** Open on `section`, following it when Settings are already open. */
  openSection: (section: GlobalSettingsSection) => void;
  /** Open on the first section, or keep the open page where it is (⌘,). */
  show: () => void;
  close: () => void;
}

export const useGlobalSettingsStore = create<GlobalSettingsState>()((set) => ({
  open: false,
  section: undefined,
  sectionRequest: 0,
  openSection: (section) =>
    set((state) => ({ open: true, section, sectionRequest: state.sectionRequest + 1 })),
  show: () => set((state) => (state.open ? state : { open: true, section: undefined })),
  close: () => set({ open: false, section: undefined }),
}));
