import { Bug } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { SETTINGS_CARD_CLASS, SettingsSectionHeader } from "./SettingsPageLayout";

/**
 * Settings → Debug → "Debug button": shows the bottom bar's debug button.
 * Stored with this window's chrome; it changes nothing on any machine until
 * the button is used.
 */
export function DebugButtonSetting() {
  const enabled = useUIChromeStore((state) => state.debugButtonEnabled);
  const setEnabled = useUIChromeStore((state) => state.setDebugButtonEnabled);
  return (
    <div className="space-y-3" data-testid="debug-button-setting">
      <SettingsSectionHeader icon={<Bug className="h-4 w-4" />} title="Debug button">
        A one-click way to hand a problem in an environment to a pipeline. Applies to this window.
      </SettingsSectionHeader>
      <div className={cn(SETTINGS_CARD_CLASS, "flex items-center justify-between gap-6 p-4")}>
        <div className="min-w-0 space-y-1">
          <Label htmlFor="debug-button" className="text-sm font-medium">
            Show the debug button in the bottom bar
          </Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The button captures the window, then asks what is wrong or what should be done. Creating
            it starts one pipeline environment whose ticket carries your text, the screenshot if you
            keep it, and the environment&apos;s details and agent transcript.
          </p>
        </div>
        <Switch
          id="debug-button"
          aria-label="Debug button"
          checked={enabled}
          onCheckedChange={setEnabled}
        />
      </div>
    </div>
  );
}
