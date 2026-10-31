import { Gauge } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useUIStore } from "@/stores/uiStore";
import { SETTINGS_CARD_CLASS, SettingsSectionHeader } from "./SettingsPageLayout";
import { cn } from "@/lib/utils";

/**
 * This client's data-saving preference. It is stored on this device only and
 * slows only this device's background refreshes; other devices and the
 * backend keep their own cadence.
 */
export function DataSavingSetting() {
  const dataSaving = useUIStore((state) => state.dataSaving);
  const setDataSaving = useUIStore((state) => state.setDataSaving);
  return (
    <div className="space-y-3" data-testid="data-saving-setting">
      <SettingsSectionHeader icon={<Gauge className="h-4 w-4" />} title="Data saving">
        For a metered or slow connection. Applies to this device only.
      </SettingsSectionHeader>
      <div className={cn(SETTINGS_CARD_CLASS, "flex items-center justify-between gap-6 p-4")}>
        <div className="min-w-0 space-y-1">
          <Label htmlFor="data-saving" className="text-sm font-medium">
            Refresh less often in the background
          </Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            A running agent refreshes every second instead of every half second, and an open Files
            panel or reviewer tab slows down while nothing changes. Approvals, questions, errors and
            finished turns still appear as soon as the machine announces them.
          </p>
        </div>
        <Switch
          id="data-saving"
          aria-label="Data saving"
          checked={dataSaving}
          onCheckedChange={setDataSaving}
        />
      </div>
    </div>
  );
}
