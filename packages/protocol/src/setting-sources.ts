/**
 * Where a machine's global settings come from, and which of them can be reset.
 *
 * Settings shows each field's effective value with its source: stored on this
 * machine, stored on the command node and inherited, or the product default.
 * The config a client reads (`get_config`) is normalised, so a key being
 * present there does not prove the user stored it. `get_global_setting_sources`
 * answers from the stored file instead, naming keys only, never values.
 *
 * Resetting removes the stored key (`reset_global_settings`), so the machine
 * follows the default again. Only keys whose absence the backend keeps through
 * later saves are resettable: a key that normalisation or validation writes
 * back on every save would look reset and then reappear, and a key the
 * settings schema requires (terminal appearance and scrollback) cannot be
 * absent at all.
 *
 * Browser-safe.
 */

/** Credentials have their own commands and never appear in a source list. */
export const CREDENTIAL_GLOBAL_SETTING_KEYS = [
  "githubToken",
  "githubTokenConfigured",
  "anthropicApiKey",
  "anthropicApiKeyConfigured",
  "anthropicApiKeySource",
  "cursorApiKey",
  "cursorApiKeyConfigured",
  "cursorApiKeySource",
  "openCodeZenApiKey",
  "openCodeZenApiKeyConfigured",
  "openCodeZenApiKeySource",
] as const;

const CREDENTIAL_KEYS: ReadonlySet<string> = new Set(CREDENTIAL_GLOBAL_SETTING_KEYS);

/**
 * Global settings a reset may remove. Each stays absent through later saves
 * (`storage-config-setting-sources.test.ts` proves it per key), so the
 * machine follows the product default until the user sets it again.
 */
export const RESETTABLE_GLOBAL_SETTING_KEYS = [
  "autoSteer",
  "preferredEditor",
  "defaultProjectsDirectory",
  "sshAgentSocketPath",
  "autoMergeRequireChecks",
  "claudeBackgroundCommandLimitHours",
  "sessionTitleGeneration",
  "terminalLinkDefaultTarget",
  "reviewInstruction",
  "reviewLensPresets",
  "coordinatorWebResearch",
  "coordinatorResearchMcpServers",
  "experimentalGraphs",
  "experimentalScheduling",
  "experimentalSelfImprovement",
  "experimentalTmux",
  "localWindowGatewayTransport",
  "webClientEnabled",
  "debugLogging",
] as const;

export type ResettableGlobalSettingKey = (typeof RESETTABLE_GLOBAL_SETTING_KEYS)[number];

const RESETTABLE_KEYS: ReadonlySet<string> = new Set(RESETTABLE_GLOBAL_SETTING_KEYS);

export function isResettableGlobalSettingKey(key: unknown): key is ResettableGlobalSettingKey {
  return typeof key === "string" && RESETTABLE_KEYS.has(key);
}

/** Bounds on a source list: one per top-level key, which is far fewer. */
export const MAX_SETTING_SOURCE_KEYS = 512;
export const MAX_SETTING_KEY_CHARS = 64;
/** At most this many keys reset together. */
export const MAX_RESET_SETTING_KEYS = 16;

/** Which of a machine's global settings are stored, and which it takes from a command node. */
export interface GlobalSettingSources {
  /** Top-level keys in this machine's own stored settings; credentials excluded. */
  readonly storedKeys: string[];
  /**
   * Keys this machine currently takes from a command node it follows.
   * `null` when it follows none.
   */
  readonly inheritedKeys: string[] | null;
}

function settingKeys(source: object | null | undefined): string[] {
  if (!source || typeof source !== "object") return [];
  const keys: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || CREDENTIAL_KEYS.has(key)) continue;
    if (key.length === 0 || key.length > MAX_SETTING_KEY_CHARS) continue;
    keys.push(key);
    if (keys.length >= MAX_SETTING_SOURCE_KEYS) break;
  }
  return keys.sort();
}

/** The source list for a stored global and the inherited settings laid over it. */
export function globalSettingSources(
  storedGlobal: object | null | undefined,
  inherited: object | null | undefined,
): GlobalSettingSources {
  return {
    storedKeys: settingKeys(storedGlobal),
    inheritedKeys: inherited ? settingKeys(inherited) : null,
  };
}

/**
 * What a reset expects to find, so a value that changed after the user saw
 * the preview is not removed: `present: false` expects the key absent, and
 * `present: true` expects exactly `value` (the normalised value the client
 * read with `get_config`).
 */
export type ResetSettingExpectation =
  | { readonly key: string; readonly present: false }
  | { readonly key: string; readonly present: true; readonly value: unknown };

/** Validate a reset request; throws with a message that names no value. */
export function parseResetSettingsRequest(
  keys: unknown,
  expect: unknown,
): { keys: ResettableGlobalSettingKey[]; expect: ResetSettingExpectation[] } {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_RESET_SETTING_KEYS) {
    throw new Error(`Expected keys to be a list of 1 to ${MAX_RESET_SETTING_KEYS} settings`);
  }
  const unique = [...new Set(keys)];
  for (const key of unique) {
    if (!isResettableGlobalSettingKey(key)) {
      throw new Error("A setting in keys cannot be reset");
    }
  }
  if (!Array.isArray(expect) || expect.length !== unique.length) {
    throw new Error("Expected one expectation for every key");
  }
  const expectations: ResetSettingExpectation[] = [];
  for (const entry of expect as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Expected each expectation to be an object");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.key !== "string" || !unique.includes(record.key as never)) {
      throw new Error("Expected each expectation to name one of the keys");
    }
    if (record.present === false) expectations.push({ key: record.key, present: false });
    else if (record.present === true) {
      expectations.push({ key: record.key, present: true, value: record.value });
    } else throw new Error("Expected present to be true or false");
  }
  if (new Set(expectations.map((entry) => entry.key)).size !== unique.length) {
    throw new Error("Expected one expectation for every key");
  }
  return { keys: unique as ResettableGlobalSettingKey[], expect: expectations };
}

/** Structural JSON equality, the comparison a reset expectation uses. */
export function settingValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => settingValuesEqual(item, right[index]));
  }
  if (typeof left !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => settingValuesEqual(leftRecord[key], rightRecord[key]));
}

/** Which expectations the stored global no longer meets. */
export function unmetResetExpectations(
  global: object,
  expect: readonly ResetSettingExpectation[],
): string[] {
  const record = global as Record<string, unknown>;
  return expect
    .filter((entry) =>
      entry.present
        ? record[entry.key] === undefined || !settingValuesEqual(record[entry.key], entry.value)
        : record[entry.key] !== undefined,
    )
    .map((entry) => entry.key);
}
