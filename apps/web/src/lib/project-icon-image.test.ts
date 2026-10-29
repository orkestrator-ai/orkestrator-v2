import { describe, expect, test } from "bun:test";
import { isProjectIconFile } from "./project-icon-image";

describe("isProjectIconFile", () => {
  test("accepts any image type, favicons included", () => {
    for (const type of ["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml"]) {
      expect(isProjectIconFile({ name: "icon", type })).toBe(true);
    }
  });

  test("falls back to the name when the system gives a favicon no type", () => {
    expect(isProjectIconFile({ name: "favicon.ico", type: "" })).toBe(true);
    expect(isProjectIconFile({ name: "Logo.PNG", type: "" })).toBe(true);
    expect(isProjectIconFile({ name: "notes.txt", type: "" })).toBe(false);
  });

  test("rejects a typed file that is not an image", () => {
    expect(isProjectIconFile({ name: "favicon.ico", type: "text/plain" })).toBe(false);
  });
});
