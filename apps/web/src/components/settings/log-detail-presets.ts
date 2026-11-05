import { parseLogDetail, sameLogDetail, type LogDetail } from "@orkestrator/protocol/log-policy";

/**
 * Named "Log detail" settings for common investigations. A preset is only a
 * shortcut: applying one writes ordinary `level` and `areaLevels`, so nothing
 * new is stored and an older client sees plain values. Which preset is current
 * is worked out by comparison, so editing a level by hand shows "Custom".
 */
export interface LogDetailPreset {
  id: string;
  label: string;
  description: string;
  detail: LogDetail;
}

export const CUSTOM_LOG_DETAIL_PRESET = "custom";

export const LOG_DETAIL_PRESETS: readonly LogDetailPreset[] = [
  {
    id: "normal",
    label: "Normal",
    description: "Info everywhere. What a new installation writes.",
    detail: { level: "info", areaLevels: {} },
  },
  {
    id: "quiet",
    label: "Quiet",
    description: "Warnings and errors only.",
    detail: { level: "warn", areaLevels: {} },
  },
  {
    id: "agent-sessions",
    label: "Agent sessions",
    description:
      "Agent bridges at Debug, with a snapshot of every running turn each minute. For a turn that stalls, hangs or stops early.",
    detail: { level: "info", areaLevels: { bridge: "debug" } },
  },
  {
    id: "crashes",
    label: "Crashes and stopped processes",
    description:
      "The desktop, the backend and local agent bridges at Debug: the lines the crash debugging guide reads.",
    detail: {
      level: "info",
      areaLevels: { backend: "debug", desktop: "debug", "local-server": "debug" },
    },
  },
  {
    id: "updates",
    label: "Updates",
    description: "The updater at Debug, for an update that does not download or install.",
    detail: { level: "info", areaLevels: { updater: "debug" } },
  },
  {
    id: "everything",
    label: "Everything",
    description: "Every part at Debug. Writes the most, so use it briefly.",
    detail: { level: "debug", areaLevels: {} },
  },
];

/** The preset this setting is exactly, or null when it is custom. */
export function matchingLogDetailPreset(detail: LogDetail): LogDetailPreset | null {
  return LOG_DETAIL_PRESETS.find((preset) => sameLogDetail(preset.detail, detail)) ?? null;
}

/** The setting a preset writes, in the sorted form the store holds. */
export function logDetailForPreset(preset: LogDetailPreset): LogDetail {
  return parseLogDetail(preset.detail) ?? preset.detail;
}
