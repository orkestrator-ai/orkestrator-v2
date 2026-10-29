import { describe, expect, test } from "bun:test";
import { MAX_PROJECT_ICON_LENGTH, normalizeProjectIcon } from "./project-icon";

describe("normalizeProjectIcon", () => {
  test("keeps a base64 raster data URL", () => {
    for (const type of ["png", "jpeg", "webp", "gif"]) {
      const icon = `data:image/${type};base64,iVBORw0KGgo=`;
      expect(normalizeProjectIcon(icon)).toBe(icon);
    }
  });

  test("rejects SVG, other URLs and non-base64 payloads", () => {
    expect(normalizeProjectIcon("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(normalizeProjectIcon("https://example.com/icon.png")).toBeNull();
    expect(normalizeProjectIcon("data:image/png,<svg>")).toBeNull();
    expect(normalizeProjectIcon('data:image/png;base64,abc"onerror')).toBeNull();
  });

  test("rejects empty, non-string and oversized values", () => {
    expect(normalizeProjectIcon("")).toBeNull();
    expect(normalizeProjectIcon(null)).toBeNull();
    expect(normalizeProjectIcon(42)).toBeNull();
    const prefix = "data:image/png;base64,";
    expect(
      normalizeProjectIcon(prefix + "A".repeat(MAX_PROJECT_ICON_LENGTH - prefix.length + 4)),
    ).toBeNull();
  });
});
