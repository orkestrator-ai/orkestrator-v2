import {
  isTerminalLinkDefaultTarget,
  type TerminalLinkDefaultTarget,
} from "@orkestrator/protocol/terminal-link-target";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsSectionHeader } from "./SettingsPageLayout";

/** Where a modified click on a terminal link opens. The global settings form saves it. */
export function TerminalLinkTargetSetting({
  value,
  onChange,
}: {
  value: TerminalLinkDefaultTarget;
  onChange: (value: TerminalLinkDefaultTarget) => void;
}) {
  return (
    <section className="space-y-3">
      <SettingsSectionHeader title="Terminal links" />
      <Label htmlFor="terminal-link-default-target">Open terminal links in</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (isTerminalLinkDefaultTarget(next)) onChange(next);
        }}
      >
        <SelectTrigger
          id="terminal-link-default-target"
          aria-describedby="terminal-link-default-target-description"
          className="w-full max-w-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="external">External browser</SelectItem>
          <SelectItem value="browser-tab">Preview tab</SelectItem>
        </SelectContent>
      </Select>
      <p id="terminal-link-default-target-description" className="text-xs text-muted-foreground">
        ⌘-click (Ctrl-click) opens a link in{" "}
        {value === "external"
          ? "your external browser; ⌘⇧-click (Ctrl+Shift-click) opens it in a preview tab."
          : "a preview tab; ⌘⇧-click (Ctrl+Shift-click) opens it in your external browser."}
      </p>
    </section>
  );
}
