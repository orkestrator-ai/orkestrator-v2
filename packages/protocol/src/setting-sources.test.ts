import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_GLOBAL_SETTING_KEYS,
  MAX_RESET_SETTING_KEYS,
  RESETTABLE_GLOBAL_SETTING_KEYS,
  globalSettingSources,
  parseResetSettingsRequest,
  settingValuesEqual,
  unmetResetExpectations,
} from "./setting-sources";
import { INHERITED_GLOBAL_SETTING_KEYS } from "./controller-settings";

describe("globalSettingSources", () => {
  test("lists set keys sorted, without credentials or undefined values", () => {
    expect(
      globalSettingSources(
        { b: 1, a: false, githubToken: "x", anthropicApiKeyConfigured: true, gone: undefined },
        null,
      ),
    ).toEqual({ storedKeys: ["a", "b"], inheritedKeys: null });
  });

  test("an inherited layer, even an empty one, is not null", () => {
    expect(globalSettingSources({}, {}).inheritedKeys).toEqual([]);
    expect(globalSettingSources(null, { autoSteer: true }).inheritedKeys).toEqual(["autoSteer"]);
  });
});

describe("parseResetSettingsRequest", () => {
  test("accepts resettable keys with one expectation each", () => {
    expect(
      parseResetSettingsRequest(
        ["autoSteer", "autoSteer"],
        [{ key: "autoSteer", present: true, value: true }],
      ),
    ).toEqual({
      keys: ["autoSteer"],
      expect: [{ key: "autoSteer", present: true, value: true }],
    });
  });

  test("refuses credentials, unknown keys and malformed expectations", () => {
    for (const key of CREDENTIAL_GLOBAL_SETTING_KEYS) {
      expect(() => parseResetSettingsRequest([key], [{ key, present: false }])).toThrow(
        "cannot be reset",
      );
    }
    expect(() => parseResetSettingsRequest([], [])).toThrow();
    expect(() =>
      parseResetSettingsRequest(
        Array.from({ length: MAX_RESET_SETTING_KEYS + 1 }, () => "autoSteer"),
        [],
      ),
    ).toThrow();
    expect(() => parseResetSettingsRequest(["autoSteer"], [{ key: "debugLogging" }])).toThrow();
    expect(() => parseResetSettingsRequest(["autoSteer"], [{ key: "autoSteer" }])).toThrow(
      "present",
    );
  });

  test("no credential is resettable, and every resettable key is a known setting name", () => {
    const credentials = new Set<string>(CREDENTIAL_GLOBAL_SETTING_KEYS);
    for (const key of RESETTABLE_GLOBAL_SETTING_KEYS) expect(credentials.has(key)).toBe(false);
    // Inherited keys a reset may touch are routed to the command node by the client.
    expect(INHERITED_GLOBAL_SETTING_KEYS).toContain("autoSteer");
  });
});

describe("reset expectations", () => {
  test("compare structurally and treat undefined members as absent", () => {
    expect(settingValuesEqual({ a: [1, { b: 2 }], c: undefined }, { a: [1, { b: 2 }] })).toBe(true);
    expect(settingValuesEqual([1, 2], [2, 1])).toBe(false);
    expect(settingValuesEqual(null, undefined)).toBe(false);
  });

  test("report keys whose stored value moved", () => {
    expect(
      unmetResetExpectations({ autoSteer: true, debugLogging: false }, [
        { key: "autoSteer", present: true, value: true },
        { key: "debugLogging", present: true, value: true },
        { key: "experimentalTmux", present: false },
      ]),
    ).toEqual(["debugLogging"]);
    expect(
      unmetResetExpectations({ experimentalTmux: true }, [
        { key: "experimentalTmux", present: false },
      ]),
    ).toEqual(["experimentalTmux"]);
  });
});
