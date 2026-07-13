import { describe, expect, test } from "bun:test";
import { getApplicationTitle } from "./application-title";

describe("getApplicationTitle", () => {
  test("includes the active project in the desktop title", () => {
    expect(getApplicationTitle("pgstack1", false)).toBe("Orkestrator AI - pgstack1");
  });

  test("uses only the active project for the mobile title", () => {
    expect(getApplicationTitle("pgstack1", true)).toBe("pgstack1");
  });

  test("includes the active environment in the mobile title", () => {
    expect(getApplicationTitle("pgstack1", true, "feature-auth")).toBe(
      "pgstack1 - feature-auth",
    );
  });

  test("does not include the active environment in the desktop title", () => {
    expect(getApplicationTitle("pgstack1", false, "feature-auth")).toBe(
      "Orkestrator AI - pgstack1",
    );
  });

  test("falls back to the product name before a project is selected", () => {
    expect(getApplicationTitle(null, false)).toBe("Orkestrator AI");
    expect(getApplicationTitle(null, true)).toBe("Orkestrator AI");
  });
});
