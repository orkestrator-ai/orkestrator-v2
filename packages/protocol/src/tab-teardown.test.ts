import { describe, expect, test } from "bun:test";
import { isTabTeardownKind, TAB_TEARDOWN_KINDS } from "./tab-teardown";

describe("tab teardown protocol", () => {
  test("accepts every supported resource kind and rejects arbitrary commands", () => {
    for (const kind of TAB_TEARDOWN_KINDS) expect(isTabTeardownKind(kind)).toBe(true);
    expect(isTabTeardownKind("browser")).toBe(false);
    expect(isTabTeardownKind(1)).toBe(false);
  });
});
