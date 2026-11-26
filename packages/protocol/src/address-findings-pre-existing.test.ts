import { describe, expect, test } from "bun:test";
import {
  addressFindingsPreExistingFailurePolicy,
  isAddressFindingsPreExistingFailurePolicy,
  recordedAddressFindingsPreExistingFailurePolicy,
} from "./address-findings-pre-existing.js";
import { INHERITED_GLOBAL_SETTING_KEYS } from "./controller-settings.js";
import { RESETTABLE_GLOBAL_SETTING_KEYS } from "./setting-sources.js";

describe("Address Findings pre-existing failure policy", () => {
  test("only an explicit true repairs; a missing or malformed setting is off", () => {
    expect(
      addressFindingsPreExistingFailurePolicy({ addressFindingsRepairsPreExisting: true }),
    ).toBe("repair");
    expect(
      addressFindingsPreExistingFailurePolicy({ addressFindingsRepairsPreExisting: false }),
    ).toBe("excuse");
    // An older config or peer has no field.
    expect(addressFindingsPreExistingFailurePolicy({})).toBe("excuse");
    expect(addressFindingsPreExistingFailurePolicy(undefined)).toBe("excuse");
    expect(
      addressFindingsPreExistingFailurePolicy({ addressFindingsRepairsPreExisting: "true" }),
    ).toBe("excuse");
  });

  test("a recorded policy reads back, and a record without one is excuse", () => {
    expect(recordedAddressFindingsPreExistingFailurePolicy("repair")).toBe("repair");
    expect(recordedAddressFindingsPreExistingFailurePolicy("excuse")).toBe("excuse");
    expect(recordedAddressFindingsPreExistingFailurePolicy(undefined)).toBe("excuse");
    expect(recordedAddressFindingsPreExistingFailurePolicy("always")).toBe("excuse");
    expect(isAddressFindingsPreExistingFailurePolicy("repair")).toBe(true);
    expect(isAddressFindingsPreExistingFailurePolicy(true)).toBe(false);
  });

  test("the setting is a review preference: inherited from a command node and resettable", () => {
    expect(INHERITED_GLOBAL_SETTING_KEYS).toContain("addressFindingsRepairsPreExisting");
    expect(RESETTABLE_GLOBAL_SETTING_KEYS).toContain("addressFindingsRepairsPreExisting");
  });
});
