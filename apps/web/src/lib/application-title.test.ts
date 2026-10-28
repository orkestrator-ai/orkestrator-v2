import { describe, expect, test } from "bun:test";
import { getApplicationTitle, splitTitleEnvironmentName } from "./application-title";

describe("getApplicationTitle", () => {
  test("includes the active project in the desktop title", () => {
    expect(getApplicationTitle("pgstack1", false)).toBe("Orkestrator AI - pgstack1");
  });

  test("uses only the active project for the mobile title", () => {
    expect(getApplicationTitle("pgstack1", true)).toBe("pgstack1");
  });

  test("includes the active environment in the mobile title", () => {
    expect(getApplicationTitle("pgstack1", true, "feature-auth")).toBe("pgstack1 - feature-auth");
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

  test("keeps development profile identity in renderer titles", () => {
    expect(getApplicationTitle(null, false, null, "agent-123")).toBe(
      "Orkestrator AI — DEV [agent-123]",
    );
    expect(getApplicationTitle("fixture", false, null, "agent-123")).toBe(
      "Orkestrator AI — DEV [agent-123] - fixture",
    );
  });
});

describe("splitTitleEnvironmentName", () => {
  test("splits a title that ends with the environment", () => {
    expect(splitTitleEnvironmentName("pgstack1 - feature-auth", "feature-auth")).toEqual({
      prefix: "pgstack1 - ",
      environmentName: "feature-auth",
    });
    // A name containing the separator still splits at the real suffix.
    expect(splitTitleEnvironmentName("proj - a - b", "a - b")).toEqual({
      prefix: "proj - ",
      environmentName: "a - b",
    });
  });

  test("leaves a title without that environment whole", () => {
    expect(splitTitleEnvironmentName("Orkestrator AI - pgstack1", "feature-auth")).toBeNull();
    expect(splitTitleEnvironmentName("pgstack1", null)).toBeNull();
    expect(splitTitleEnvironmentName("pgstack1 - x", "")).toBeNull();
  });
});
