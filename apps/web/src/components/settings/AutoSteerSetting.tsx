import { Navigation } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SETTINGS_CARD_CLASS, SettingsRow, SettingsSectionHeader } from "./SettingsPageLayout";

/**
 * What a message sent while an agent is still working does: steer the running
 * turn (on) or wait in the prompt queue for the next one (off, the default).
 */
export function AutoSteerSetting({
  checked,
  onCheckedChange,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3" data-testid="auto-steer-setting">
      <SettingsSectionHeader icon={<Navigation className="h-4 w-4" />} title="Messages while busy">
        What happens to a message you send while an agent is still working.
      </SettingsSectionHeader>
      <div className={cn(SETTINGS_CARD_CLASS, "overflow-hidden")}>
        <SettingsRow
          label="Auto-steer"
          htmlFor="auto-steer"
          description={
            <span id="auto-steer-description">
              {checked ? (
                <>
                  On: a new message is steered into the turn that is running now, so the agent reads
                  it straight away and changes course without stopping.
                </>
              ) : (
                <>
                  Off: a new message is added to the queue and sent as the next turn, once the agent
                  finishes the current one.
                </>
              )}{" "}
              Only plain text can steer, so messages with attachments, commands, and agents that
              cannot steer still queue. A message that arrives after the turn ends, or that the
              agent refuses, stays in the queue.
            </span>
          }
        >
          <Switch
            id="auto-steer"
            aria-label="Auto-steer"
            aria-describedby="auto-steer-description"
            checked={checked}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
          />
        </SettingsRow>
      </div>
    </div>
  );
}
