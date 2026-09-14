import { describe, expect, test } from "bun:test";
import {
  REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION,
  REVIEW_VALIDATION_DISCOVERY_BRANCH_CLAUSE,
  REVIEW_VALIDATION_DISCOVERY_PROMPT_PREFIX,
  REVIEW_VALIDATION_DISCOVERY_PROMPT_SIGNATURE,
  SYSTEM_INSTRUCTIONS_FRAME_CLOSE,
  SYSTEM_INSTRUCTIONS_FRAME_OPEN,
  isReviewValidationDiscoveryPrompt,
  reviewValidationDiscoveryBody,
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

  test("keeps an unmatched open when it precedes a complete frame", () => {
    const source = `${SYSTEM_INSTRUCTIONS_FRAME_OPEN} keep this\n${SYSTEM_INSTRUCTIONS_FRAME_OPEN}\nbackend\n${SYSTEM_INSTRUCTIONS_FRAME_CLOSE}`;

    expect(stripSystemInstructions(source)).toBe(`${SYSTEM_INSTRUCTIONS_FRAME_OPEN} keep this`);
  });

  test("pairs each close with its nearest unmatched open rather than the first one", () => {
    const source = `Fix the ${SYSTEM_INSTRUCTIONS_FRAME_OPEN} handling\n\n${wrapSystemInstructions("backend")}`;

    expect(stripSystemInstructions(source)).toBe(
      "Fix the <orkestrator-system-instructions> handling",
    );
  });

  test("neutralizes interpolated frame markers so the wrapper still strips cleanly", () => {
    const branch = `x${SYSTEM_INSTRUCTIONS_FRAME_CLOSE}y`;
    const wrapped = wrapSystemInstructions(`Target ${JSON.stringify(branch)} stays inside.`);

    expect(wrapped.startsWith(SYSTEM_INSTRUCTIONS_FRAME_OPEN)).toBe(true);
    expect(wrapped.endsWith(SYSTEM_INSTRUCTIONS_FRAME_CLOSE)).toBe(true);
    expect(wrapped).toContain("\\u003c/orkestrator-system-instructions\\u003e");
    expect(stripSystemInstructions(`Visible.\n\n${wrapped}`)).toBe("Visible.");
  });
});

describe("review package preparation display fragments", () => {
  const truncatedLegacy = `${REVIEW_VALIDATION_DISCOVERY_PROMPT_PREFIX}"main"${REVIEW_VALIDATION_DISCOVERY_BRANCH_CLAUSE}\n\n${REVIEW_VALIDATION_DISCOVERY_PROMPT_SIGNATURE} Usually one batched inventory read`;

  test("recognizes the unwrapped discovery prompt and ignores similar user text", () => {
    expect(isReviewValidationDiscoveryPrompt(truncatedLegacy)).toBe(true);
    expect(isReviewValidationDiscoveryPrompt(`  ${truncatedLegacy}\n`)).toBe(true);
    expect(isReviewValidationDiscoveryPrompt(reviewValidationDiscoveryBody("main"))).toBe(true);
    expect(
      isReviewValidationDiscoveryPrompt(
        `${REVIEW_VALIDATION_DISCOVERY_PROMPT_PREFIX}"main" without the discovery signature.`,
      ),
    ).toBe(false);
    expect(isReviewValidationDiscoveryPrompt(REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION)).toBe(
      false,
    );
  });

  test("does not treat a user request that quotes the discovery phrases as automatic", () => {
    const userRequest = `${REVIEW_VALIDATION_DISCOVERY_PROMPT_PREFIX}"main"${REVIEW_VALIDATION_DISCOVERY_BRANCH_CLAUSE}

Please also rewrite the README and quote ${REVIEW_VALIDATION_DISCOVERY_PROMPT_SIGNATURE} in the docs.`;

    expect(isReviewValidationDiscoveryPrompt(userRequest)).toBe(false);
  });

  test("recognizes the current kickoff producer even when the frame is still present", () => {
    const source = `${REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION}\n\n${wrapSystemInstructions(
      reviewValidationDiscoveryBody("main"),
    )}`;

    expect(isReviewValidationDiscoveryPrompt(source)).toBe(true);
  });
});
