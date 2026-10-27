import { Gauge } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useUIStore } from "@/stores/uiStore";

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
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Gauge className="h-4 w-4" />
          Data saving
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          For a metered or slow connection. Applies to this device only.
        </p>
      </div>
      <div className="flex items-center justify-between gap-6 rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
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
