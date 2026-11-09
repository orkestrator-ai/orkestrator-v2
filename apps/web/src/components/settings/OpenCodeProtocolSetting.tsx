import { FlaskConical } from "lucide-react";
import type { OpenCodeProtocol } from "@orkestrator/protocol/opencode-protocol";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SETTINGS_CARD_CLASS, SettingsRow, SettingsSectionHeader } from "./SettingsPageLayout";

/**
 * The OpenCode 2 preview opt-in (docs/todo/agent-engines/0008-opencode-v2.md):
 * new interactive OpenCode tabs in local environments start on OpenCode 2.
 * Existing sessions keep the line they were created on whatever this says.
 */
export function OpenCodeProtocolSetting({
  value,
  onChange,
  disabled,
}: {
  value: OpenCodeProtocol;
  onChange: (value: OpenCodeProtocol) => void;
  disabled?: boolean;
}) {
  const checked = value === "v2";
  return (
    <div className="space-y-3" data-testid="opencode-protocol-setting">
      <SettingsSectionHeader icon={<FlaskConical className="h-4 w-4" />} title="OpenCode 2">
        Try the next major version of OpenCode before it becomes the default.
      </SettingsSectionHeader>
      <div className={cn(SETTINGS_CARD_CLASS, "overflow-hidden")}>
        <SettingsRow
          label="Use OpenCode 2 for new sessions (preview)"
          htmlFor="opencode-protocol-v2"
          description={
            <span id="opencode-protocol-v2-description">
              New OpenCode tabs in local environments start on OpenCode 2, which can steer a running
              turn. Existing sessions stay on OpenCode 1, and container environments keep using it.
              Structured output is not available on OpenCode 2 yet.
            </span>
          }
        >
          <Switch
            id="opencode-protocol-v2"
            aria-label="Use OpenCode 2 for new sessions (preview)"
            aria-describedby="opencode-protocol-v2-description"
            checked={checked}
            disabled={disabled}
            onCheckedChange={(next) => onChange(next ? "v2" : "legacy")}
          />
        </SettingsRow>
      </div>
    </div>
  );
}
