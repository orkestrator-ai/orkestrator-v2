import { useState } from "react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  canOfferDeveloperTools,
  canOfferWebInspector,
  rendererDebugLoggingActive,
  setRendererDebugPreference,
} from "@/lib/debug-log";

import { SettingsSectionHeader } from "./SettingsPageLayout";

/**
 * "Renderer Debug Logging": the `orkestrator:debug` preference for this window
 * only. It lives in the window's own storage, not the host's settings, so a
 * browser tab or another machine's window sets its own. Changing it reloads,
 * because the renderer reads its level once at start.
 */
export function RendererDebugSettings({
  reload,
  desktop = canOfferDeveloperTools(),
  iosApp = canOfferWebInspector(),
}: {
  reload?: () => void;
  desktop?: boolean;
  /** The iOS app, whose web view opens to Safari's Web Inspector while this is on. */
  iosApp?: boolean;
}) {
  const active = rendererDebugLoggingActive();
  const [reloading, setReloading] = useState(false);
  return (
    <div className="space-y-3">
      <SettingsSectionHeader title="Renderer Debug Logging">
        Debug lines from this window&apos;s interface, written to its developer console. Applies to
        this window only, and reloads it.
        {desktop
          ? " While it is on, Help → Open Developer Tools shows them."
          : iosApp
            ? " While it is on, Safari's Web Inspector on a Mac connected to this device shows them."
            : " Your browser's developer tools show them."}
      </SettingsSectionHeader>
      <div className="flex max-w-xs items-center justify-between rounded-lg bg-zinc-900 p-3">
        <Label htmlFor="renderer-debug-logging" className="text-sm font-medium">
          {active ? "On in this window" : "Off"}
        </Label>
        <Switch
          id="renderer-debug-logging"
          checked={active}
          disabled={reloading}
          aria-label="Renderer debug logging for this window"
          onCheckedChange={(next) => {
            setReloading(true);
            if (!setRendererDebugPreference(next, reload ? { reload } : {})) setReloading(false);
          }}
        />
      </div>
      <p className="max-w-xl text-xs text-muted-foreground">
        Developer tools can show what this window holds in memory, tokens included. Turn this off
        when you are done.
      </p>
    </div>
  );
}
