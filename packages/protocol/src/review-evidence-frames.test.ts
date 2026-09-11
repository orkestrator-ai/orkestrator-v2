import { describe, expect, test } from "bun:test";
import {
  SYSTEM_INSTRUCTIONS_FRAME_CLOSE,
  SYSTEM_INSTRUCTIONS_FRAME_OPEN,
  stripSystemInstructions,
  wrapSystemInstructions,
} from "./review-evidence-frames.js";

describe("system instructions frame", () => {
  test("wraps every part in one complete frame", () => {
    expect(wrapSystemInstructions("first", "second")).toBe(
      `${SYSTEM_INSTRUCTIONS_FRAME_OPEN}\nfirst\n\nsecond\n${SYSTEM_INSTRUCTIONS_FRAME_CLOSE}`,
    );
  });

  test("ignores blank parts rather than emitting empty paragraphs", () => {
    expect(wrapSystemInstructions("", "  ", "only")).toBe(
      `${SYSTEM_INSTRUCTIONS_FRAME_OPEN}\nonly\n${SYSTEM_INSTRUCTIONS_FRAME_CLOSE}`,
    );
  });

  test("strips a complete frame and collapses the blank lines it leaves", () => {
    const source = `user one\n\n${wrapSystemInstructions("provider-only guidance")}\n\nuser two`;

    expect(stripSystemInstructions(source)).toBe("user one\n\nuser two");
  });

  test("strips every frame, keeping only the user's text", () => {
    const source = `${wrapSystemInstructions("first")}\n\nvisible\n\n${wrapSystemInstructions("second")}`;

    expect(stripSystemInstructions(source)).toBe("visible");
  });

  test("returns an empty string when only guidance remains", () => {
    expect(stripSystemInstructions(wrapSystemInstructions("only guidance"))).toBe("");
  });

  test("leaves a source without a complete frame byte-for-byte", () => {
    const ordinary = "  Preserve this whitespace. \n";
    const incomplete = `${SYSTEM_INSTRUCTIONS_FRAME_OPEN}\nunterminated guidance`;

    expect(stripSystemInstructions(ordinary)).toBe(ordinary);
    expect(stripSystemInstructions(incomplete)).toBe(incomplete);
  });
});
