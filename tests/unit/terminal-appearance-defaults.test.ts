import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  TERMINAL_BACKGROUND_COLOR,
} from "../../apps/web/src/constants/terminal";

describe("terminal appearance defaults", () => {
  test("uses the shared dark terminal background constant", () => {
    expect(TERMINAL_BACKGROUND_COLOR).toBe("#0e1014");
    expect(DEFAULT_TERMINAL_APPEARANCE.backgroundColor).toBe("#0e1014");
  });

  test("uses the updated sidebar glass background", () => {
    const css = readFileSync(join(import.meta.dir, "../../apps/web/src/index.css"), "utf8");

    expect(css).toContain(".sidebar-glass");
    expect(css).toContain("background-color: var(--color-sidebar);");
    expect(css).toContain("--color-sidebar: #101319;");
  });
});
