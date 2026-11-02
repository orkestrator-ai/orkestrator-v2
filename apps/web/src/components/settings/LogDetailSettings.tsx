import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { LOG_LEVELS, type LogLevel } from "@orkestrator/protocol/logger";
import { logDetailAreas, parseLogDetail, type LogDetail } from "@orkestrator/protocol/log-policy";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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

/**
 * "Log detail": a default level and per-area overrides. Separate from saving,
 * which only decides whether what is written reaches the disk.
 */
export function LogDetailSettings({
  value,
  onChange,
}: {
  value: LogDetail;
  onChange: (next: LogDetail) => void;
}) {
  const areas = useMemo(() => logDetailAreas(), []);
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
        This does not decide whether anything is saved.
      </SettingsSectionHeader>
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
    </div>
  );
}
