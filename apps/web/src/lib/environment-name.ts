const LEGACY_TIMESTAMP_ENVIRONMENT_NAME = /^\d{8}-\d{6}$/;
const ELECTRON_COMPACT_TIMESTAMP_ENVIRONMENT_NAME = /^\d{15}$/;

/**
 * Returns true for names generated automatically before an environment has a
 * prompt-derived title. Electron briefly generated compact 15-digit names, so
 * keep recognizing those to rename existing unnamed environments on first use.
 */
export function isDefaultTimestampEnvironmentName(name: string): boolean {
  return LEGACY_TIMESTAMP_ENVIRONMENT_NAME.test(name)
    || ELECTRON_COMPACT_TIMESTAMP_ENVIRONMENT_NAME.test(name);
}
