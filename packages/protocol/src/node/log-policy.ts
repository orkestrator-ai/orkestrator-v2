import { configureLogger, type LogRecord } from "../logger.js";
import { formatLogAreaLevels, type LogDetail } from "../log-policy.js";
import type { ApplicationLogPolicy, InstalledApplicationLogging } from "./application-logging.js";
import { LOG_LEVEL_ENV, parseLogLevels } from "./logger-environment.js";

/**
 * Levels from the settings with `ORKESTRATOR_LOG_LEVEL` on top. A person who
 * started a process with that variable asked for those levels explicitly, so a
 * settings save does not undo it. Unset, which is the normal case, the settings
 * are the whole answer.
 */
export function effectiveLogDetail(
  detail: LogDetail,
  env: NodeJS.ProcessEnv = process.env,
): LogDetail {
  const overrides = parseLogLevels(env[LOG_LEVEL_ENV]);
  return {
    level: overrides.level ?? detail.level,
    areaLevels: { ...detail.areaLevels, ...overrides.areaLevels },
  };
}

/** Replaces this process's levels at once; each logger re-reads them on its next call. */
export function applyLogDetail(detail: LogDetail, env: NodeJS.ProcessEnv = process.env): LogDetail {
  const effective = effectiveLogDetail(detail, env);
  configureLogger(effective);
  return effective;
}

/** Equal exactly when two policies mean the same thing. */
export function logPolicyKey(policy: ApplicationLogPolicy): string {
  return JSON.stringify([
    policy.saving.enabled,
    policy.saving.retentionDays,
    policy.detail.level,
    formatLogAreaLevels(policy.detail),
  ]);
}

/**
 * The audit line of one settings change. It goes straight to the sink because a
 * reader needs it most when the new level is `error`, which would filter it.
 * Names, levels and numbers only.
 */
export function logPolicyChangedRecord(policy: ApplicationLogPolicy): LogRecord {
  const areas = formatLogAreaLevels(policy.detail);
  return {
    orklog: 1,
    ts: new Date().toISOString(),
    level: "info",
    area: "logging",
    event: "policy.changed",
    fields: {
      saving: policy.saving.enabled,
      retentionDays: policy.saving.retentionDays,
      level: policy.detail.level,
      ...(areas ? { areaLevels: areas } : {}),
    },
  };
}

export function isLogPolicyChangedRecord(record: LogRecord): boolean {
  return record.area === "logging" && record.event === "policy.changed";
}

/**
 * Applies a policy to this process. `audit` writes the change into the log, so
 * its order against saving matters: turning saving on writes it after the writer
 * starts, and off writes it before the writer stops, so that either way the saved
 * log says why its detail changed.
 */
export function applyApplicationLogPolicy(
  policy: ApplicationLogPolicy,
  logging: Pick<InstalledApplicationLogging, "updateSettings"> | null,
  audit?: (policy: ApplicationLogPolicy) => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  applyLogDetail(policy.detail, env);
  if (policy.saving.enabled) logging?.updateSettings(policy.saving);
  audit?.(policy);
  if (!policy.saving.enabled) logging?.updateSettings(policy.saving);
}
