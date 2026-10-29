import { lazy, useCallback, useEffect } from "react";
import { LazyDialogLoadingFallback, LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { useAccountMachineStore } from "@/components/settings/account-machine";
import { onAppShortcut } from "@/lib/app-shortcuts";
import { isWorkspaceRealm } from "@/lib/federation/workspace-realm";
import {
  onGlobalSettingsCloseRequest,
  onGlobalSettingsRequest,
  requestGlobalSettings,
} from "@/lib/settings-navigation";
import { useGlobalSettingsStore } from "@/stores/globalSettingsStore";

const LazySettingsPage = lazy(async () => ({
  default: (await import("@/components/settings/SettingsPage")).SettingsPage,
}));

/**
 * Close Settings. The next visit follows the machine on screen again, rather
 * than the one picked in the Settings header this time.
 */
function closeGlobalSettings(): void {
  useGlobalSettingsStore.getState().close();
  useAccountMachineStore.getState().choose(undefined);
}

/**
 * Renders the global Settings page wherever it was asked for: the sidebar,
 * ⌘, (the `open-settings` app shortcut, which the desktop menu's Settings…
 * also sends), and every `requestGlobalSettings` deep link. `AppShell` mounts
 * it outside both layouts, so Settings outlive the mobile drawer that opened
 * them and a window crossing the mobile breakpoint.
 */
export function GlobalSettingsHost() {
  const open = useGlobalSettingsStore((state) => state.open);
  const section = useGlobalSettingsStore((state) => state.section);
  const sectionRequest = useGlobalSettingsStore((state) => state.sectionRequest);

  useEffect(
    () => onGlobalSettingsRequest((next) => useGlobalSettingsStore.getState().openSection(next)),
    [],
  );
  useEffect(
    () =>
      onAppShortcut("open-settings", () => {
        // Settings belong to the command node: a workspace realm opens its
        // window's. The shortcut is window-owned, so a realm forwards it
        // before this runs; this keeps any direct request there consistent.
        if (isWorkspaceRealm()) {
          requestGlobalSettings("general");
          return;
        }
        useGlobalSettingsStore.getState().show();
      }),
    [],
  );
  useEffect(() => onGlobalSettingsCloseRequest(closeGlobalSettings), []);

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) useGlobalSettingsStore.getState().show();
    else closeGlobalSettings();
  }, []);

  if (!open) return null;
  return (
    <LazyLoadBoundary
      loadingFallback={<LazyDialogLoadingFallback label="Loading global settings…" />}
    >
      <LazySettingsPage
        open
        onOpenChange={handleOpenChange}
        defaultSection={section}
        sectionRequest={sectionRequest}
      />
    </LazyLoadBoundary>
  );
}
