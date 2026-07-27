import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPOSE_LINE_HEIGHT,
  COMPOSE_MAX_INPUT_HEIGHT,
  COMPOSE_MAX_LINES,
  COMPOSE_MIN_INPUT_HEIGHT,
} from "./compose-metrics";

const COMPOSE_BARS = [
  "claude/ClaudeComposeBar.tsx",
  "codex/CodexComposeBar.tsx",
  "opencode/OpenCodeComposeBar.tsx",
];

describe("compose metrics", () => {
  test("derives a 256px cap from the shared line height", () => {
    // Codex used to cap at 160px, so the same prompt scrolled in one tab and
    // not the others.
    expect(COMPOSE_MAX_INPUT_HEIGHT).toBe(256);
    expect(COMPOSE_MAX_INPUT_HEIGHT).toBe(
      COMPOSE_MAX_LINES * COMPOSE_LINE_HEIGHT + 16,
    );
    expect(COMPOSE_MIN_INPUT_HEIGHT).toBe(28);
    expect(COMPOSE_MIN_INPUT_HEIGHT).toBeLessThan(COMPOSE_MAX_INPUT_HEIGHT);
  });

  test.each(COMPOSE_BARS)(
    "%s sizes its input from the shared constants",
    (relativePath) => {
      /**
       * `MentionableInput` defaults `maxHeight` to 216px, so a bar that simply
       * forgets to pass these silently reverts to a third, different cap — the
       * exact drift this module exists to prevent, and one no rendering test
       * would catch.
       */
      const source = readFileSync(
        join(import.meta.dir, "..", relativePath),
        "utf8",
      );
      expect(source).toContain("minHeight={COMPOSE_MIN_INPUT_HEIGHT}");
      expect(source).toContain("maxHeight={COMPOSE_MAX_INPUT_HEIGHT}");
    },
  );
});
