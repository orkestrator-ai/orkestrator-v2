import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  TERMINAL_BACKGROUND_COLOR,
} from "../../src/constants/terminal";

describe("terminal appearance defaults", () => {
  test("uses the shared dark terminal background constant", () => {
    expect(TERMINAL_BACKGROUND_COLOR).toBe("#141414");
    expect(DEFAULT_TERMINAL_APPEARANCE.backgroundColor).toBe("#141414");
  });

  test("uses the updated sidebar glass background", () => {
    const css = readFileSync(join(import.meta.dir, "../../src/index.css"), "utf8");

    expect(css).toContain(".sidebar-glass");
    expect(css).toContain("background-color: #18191c;");
  });
});
