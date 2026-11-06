import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { LOG_LEVELS, type LogLevel } from "@orkestrator/protocol/logger";
import {
  logDetailAreas,
  logDetailIsRaised,
  parseLogDetail,
  parseLogDetailExpiresAt,
  type LogDetail,
} from "@orkestrator/protocol/log-policy";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import {
  CUSTOM_LOG_DETAIL_PRESET,
  LOG_DETAIL_PRESETS,
  logDetailForPreset,
  matchingLogDetailPreset,
} from "./log-detail-presets";
import { SettingsSectionHeader } from "./SettingsPageLayout";

const LEVEL_LABELS: Readonly<Record<LogLevel, string>> = {
  error: "Errors",
  warn: "Warnings",
  info: "Info",
  debug: "Debug",
  trace: "Trace",
};

const INHERIT = "inherit";

function LevelSelect({
  id,
  label,
  value,
  inherit,
  onChange,
}: {
  id?: string;
  label: string;
  value: LogLevel | typeof INHERIT;
  inherit?: string;
  onChange: (value: LogLevel | typeof INHERIT) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as LogLevel | typeof INHERIT)}>
      <SelectTrigger id={id} aria-label={label} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inherit ? <SelectItem value={INHERIT}>{inherit}</SelectItem> : null}
        {LOG_LEVELS.map((level) => (
          <SelectItem key={level} value={level}>
            {LEVEL_LABELS[level]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** When stored raised detail goes back to Info, in the reader's own clock and words. */
function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ExpiryNotice({
  value,
  stored,
  expiresAt,
  keepRaised,
  onKeepRaisedChange,
  expirySupported,
}: {
  expirySupported: boolean;
  value: LogDetail;
  stored: LogDetail;
  expiresAt?: string;
  keepRaised: boolean;
  onKeepRaisedChange?: (keep: boolean) => void;
}) {
  if (!logDetailIsRaised(value)) return null;
  const expiry = parseLogDetailExpiresAt(expiresAt);
  // An expiry belongs to what is stored; an unsaved change starts a new day.
  const pending = JSON.stringify(stored) !== JSON.stringify(value);
  const notice =
    pending && !expirySupported
      ? "Save raised detail to confirm whether this backend supports automatic expiry."
      : !expirySupported
        ? "Automatic expiry is not confirmed by this backend. Raised detail stays on until you set it back."
        : keepRaised
          ? "Raised detail stays on until you set it back."
          : expiry !== null && !pending
            ? `Raised detail goes back to Info at ${formatExpiry(expiry)}. Saving logs to disk is not changed.`
            : "Raised detail goes back to Info 24 hours after it is saved. Saving logs to disk is not changed.";
  return (
    <div className="max-w-xl space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <p className="text-xs text-muted-foreground" data-testid="log-detail-expiry">
        {notice}
      </p>
      {expirySupported && onKeepRaisedChange ? (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="log-detail-keep-raised" className="text-sm">
              Keep raised detail on
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              For an investigation that takes more than a day.
            </p>
          </div>
          <Switch
            id="log-detail-keep-raised"
            checked={keepRaised}
            onCheckedChange={onKeepRaisedChange}
            aria-label="Keep raised log detail on"
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Log detail": presets, a default level and per-area overrides. Separate from
 * saving, which only decides whether what is written reaches the disk. Raised
 * detail expires through the backend after 24 hours unless kept on.
 */
export function LogDetailSettings({
  value,
  onChange,
  stored = value,
  expiresAt,
  keepRaised = false,
  expirySupported = parseLogDetailExpiresAt(expiresAt) !== null || keepRaised,
  onKeepRaisedChange,
}: {
  value: LogDetail;
  onChange: (next: LogDetail) => void;
  /** What is saved now, so a pending change is not shown the saved expiry. */
  stored?: LogDetail;
  /** The backend's `logDetailExpiresAt` for what is saved. */
  expiresAt?: string;
  keepRaised?: boolean;
  expirySupported?: boolean;
  onKeepRaisedChange?: (keep: boolean) => void;
}) {
  const areas = useMemo(() => logDetailAreas(), []);
  const preset = matchingLogDetailPreset(value);
  const overrideCount = Object.keys(value.areaLevels).length;
  const [areasOpen, setAreasOpen] = useState(overrideCount > 0);

  const setAreaLevel = (area: string, level: LogLevel | typeof INHERIT) => {
    const areaLevels = { ...value.areaLevels };
    if (level === INHERIT) delete areaLevels[area];
    else areaLevels[area] = level;
    // Sorted the way the store holds it, so an undone edit is not a change.
    onChange(parseLogDetail({ level: value.level, areaLevels }) ?? { ...value, areaLevels });
  };

  return (
    <div className="space-y-3">
      <SettingsSectionHeader title="Log Detail">
        How much each part of Orkestrator writes, including agent bridges that are already running.
        This does not decide whether anything is saved. Logs are designed to leave out prompts,
        terminal output, file contents and credentials.
      </SettingsSectionHeader>
      <div className="max-w-xs space-y-2">
        <Label htmlFor="log-detail-preset" className="text-sm">
          Preset
        </Label>
        <Select
          value={preset?.id ?? CUSTOM_LOG_DETAIL_PRESET}
          onValueChange={(id) => {
            const chosen = LOG_DETAIL_PRESETS.find((candidate) => candidate.id === id);
            if (chosen) onChange(logDetailForPreset(chosen));
          }}
        >
          <SelectTrigger id="log-detail-preset" aria-label="Log detail preset" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOG_DETAIL_PRESETS.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_LOG_DETAIL_PRESET} disabled>
              Custom
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground" data-testid="log-detail-preset-description">
          {preset?.description ?? "Levels set by hand below."}
        </p>
      </div>
      <div className="max-w-xs space-y-2">
        <Label htmlFor="log-detail-level" className="text-sm">
          Default level
        </Label>
        <LevelSelect
          id="log-detail-level"
          label="Default log level"
          value={value.level}
          onChange={(level) => {
            if (level !== INHERIT) onChange({ ...value, level });
          }}
        />
      </div>
      <Collapsible open={areasOpen} onOpenChange={setAreasOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ChevronRight className={cn("h-4 w-4 transition-transform", areasOpen && "rotate-90")} />
          Levels by area
          {overrideCount > 0 ? <span>({overrideCount} set)</span> : null}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800">
            {areas.map(({ area, description }) => (
              <li
                key={area}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-foreground">{area}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{description}</p>
                </div>
                <div className="shrink-0">
                  <LevelSelect
                    label={`Log level for ${area}`}
                    value={value.areaLevels[area] ?? INHERIT}
                    inherit="Inherit"
                    onChange={(level) => setAreaLevel(area, level)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
      <ExpiryNotice
        expirySupported={expirySupported}
        value={value}
        stored={stored}
        expiresAt={expiresAt}
        keepRaised={keepRaised}
        onKeepRaisedChange={onKeepRaisedChange}
      />
    </div>
  );
}
