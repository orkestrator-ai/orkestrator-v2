import { Wrench } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SETTINGS_CARD_CLASS, SettingsRow, SettingsSectionHeader } from "./SettingsPageLayout";

/** The switch's accessible name, also its visible label. */
export const ADDRESS_FINDINGS_PRE_EXISTING_LABEL =
  "Address Findings also fixes pre-existing test failures on the base branch";

/**
 * Whether Address Findings (build pipeline, Multi Review, a graph's Address
 * node) also repairs recorded validation failures that already fail on the
 * base branch, instead of only excusing them with evidence. Off by default
 * (`address-findings-pre-existing.ts` in the protocol package).
 */
export function AddressFindingsPreExistingSetting({
  checked,
  onCheckedChange,
  supported,
  disabled,
}: {
  checked: boolean;
  supported: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3" data-testid="address-findings-pre-existing-setting">
      <SettingsSectionHeader
        icon={<Wrench className="h-4 w-4" />}
        title="Pre-existing test failures"
      >
        What Address Findings does with a recorded test failure that also fails on the base branch.
      </SettingsSectionHeader>
      <div className={cn(SETTINGS_CARD_CLASS, "overflow-hidden")}>
        <SettingsRow
          label={ADDRESS_FINDINGS_PRE_EXISTING_LABEL}
          htmlFor="address-findings-pre-existing"
          description={
            <span id="address-findings-pre-existing-description">
              {supported
                ? "Repairs them in separate commits instead of only excusing them. Pull requests get larger, and builds running at the same time may race to fix the same test."
                : "The command node does not support this setting. Update it to enable pre-existing repairs."}
            </span>
          }
        >
          <Switch
            id="address-findings-pre-existing"
            aria-label={ADDRESS_FINDINGS_PRE_EXISTING_LABEL}
            aria-describedby="address-findings-pre-existing-description"
            checked={supported && checked}
            disabled={!supported || disabled}
            onCheckedChange={onCheckedChange}
          />
        </SettingsRow>
      </div>
    </div>
  );
}
