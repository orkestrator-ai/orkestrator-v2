/**
 * The opt-in "Address Findings also fixes pre-existing test failures"
 * setting (`address-findings-pre-existing.ts`) as the prompt builders see it.
 *
 * With the default policy every Address Findings and Verify prompt must stay
 * byte-for-byte what it was before the setting existed. The digests below
 * were taken from the builders as they were before the setting was added;
 * change them only when the default-path text is meant to change.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ReviewPackageReference } from "@orkestrator/protocol/review-workflow";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  addressFindingsReportPrompt,
  addressFindingsValidationGuidance,
  addressFindingsValidationInstruction,
  MULTI_REVIEW_ADDRESS_FINDINGS_VALIDATION_REPORTING,
  multiReviewAddressFindingsValidationInstruction,
  VERIFICATION_PRE_EXISTING_REPAIR_RULE,
  verificationFailureInstruction,
  verificationTaskPrompt,
} from "./prompts.js";

const reviewPackage: ReviewPackageReference = {
  kind: "file",
  id: "package-1",
  round: 1,
  preparedAt: "2026-07-29T09:00:00.000Z",
  targetBranch: "release",
  baseRef: "base-sha",
  headRef: "validated-sha",
  filePath: ".orkestrator/review/package-1.json",
  sha256: "abc",
  bytes: 10,
  changedFileCount: 2,
  limitations: [],
};

const checks = [{ command: "bun test", status: "failed" }];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Each builder, called with the policy arguments given (none, or one policy). */
const builders: Array<{
  name: string;
  digest: string;
  build: (...policy: ["excuse" | "repair"] | []) => string;
}> = [
  {
    name: "pipeline Address instruction",
    digest: "da7e97e3390cbe8784051bc1535d648353d69d86bfbcec2f3ff8414c7cf862b0",
    build: (...policy) => addressFindingsValidationInstruction(reviewPackage, "release", ...policy),
  },
  {
    name: "pipeline Address instruction without a package",
    digest: "e30d812d0ff66dcde356b4711d8d8c417a9a93e7c9aa5517d7f1e78315caa6f8",
    build: (...policy) => addressFindingsValidationInstruction(undefined, "release", ...policy),
  },
  {
    name: "graph Address node guidance",
    digest: "6e71b7d0ac70c9ce3079f469ad91376bf9559d4cc719770a4560c021f5b251bd",
    build: (...policy) => addressFindingsValidationGuidance(reviewPackage, "release", ...policy),
  },
  {
    name: "Multi Review instruction with the rerun rule",
    digest: "370265ec182a8c256c7dd543c4d5d3a264d03a9a3a94c3a10705d06649257f72",
    build: (...policy) =>
      multiReviewAddressFindingsValidationInstruction(
        reviewPackage,
        "release",
        true,
        undefined,
        ...policy,
      ),
  },
  {
    name: "Multi Review instruction with verified checks",
    digest: "e858d6ac2c3ea309011c51f774283710aa530369a5a81c23aa9c8fb8275d0020",
    build: (...policy) =>
      multiReviewAddressFindingsValidationInstruction(
        reviewPackage,
        "release",
        false,
        checks,
        ...policy,
      ),
  },
  {
    name: "Verify recorded-failure rule",
    digest: "99b1cd41268eaa88202a743aee7fef14b613a2b970b7a9f565e0ffbf2fb0305f",
    build: (...policy) => verificationFailureInstruction("release", ...policy),
  },
];

describe("pre-existing failure policy: off (the default)", () => {
  for (const { name, digest, build } of builders) {
    test(`${name} is byte-for-byte today's text, omitted or explicit`, () => {
      expect(sha256(build())).toBe(digest);
      expect(build("excuse")).toBe(build());
    });
  }

  test("no default-path prompt mentions the pre-existing repair rule", () => {
    for (const { build } of builders) {
      expect(build()).not.toContain("**Pre-existing failures**");
      expect(build()).not.toContain("**Pre-existing repairs**");
      expect(build()).not.toContain("Pre-existing repair:");
    }
  });
});

describe("pre-existing failure policy: repair", () => {
  test("the pipeline Address instruction repairs pre-existing failures in their own commits", () => {
    const off = addressFindingsValidationInstruction(reviewPackage, "release");
    const on = addressFindingsValidationInstruction(reviewPackage, "release", "repair");
    const rule = on.slice(on.indexOf("**Pre-existing failures**"));
    // Today's rule is kept whole, so flaky, unrelated and undetermined
    // failures keep their handling; the new rule follows it.
    expect(on).toContain("Fix every recorded failure that relates to the ticket");
    expect(on.indexOf("Do not change unrelated code or tests to hide a failure.")).toBeLessThan(
      on.indexOf("**Pre-existing failures**"),
    );
    expect(rule).toContain("labels `pre-existing`");
    expect(rule).toContain("Commit each pre-existing repair on its own");
    expect(rule).toContain("separate from this branch's own fixes");
    expect(rule).toContain("already present on origin/release");
    expect(rule).toContain("then rerun only the repaired check");
    expect(rule).toContain("never weaken, skip or delete the test");
    expect(rule).toContain(
      "Do not change code or tests for a failure labelled `flaky`: record it in the repository's flaky-test register",
    );
    expect(rule).toContain("Failures labelled `unrelated` or `undetermined` keep the rule above.");
    expect(rule).toContain("its own `notes` entry beginning `Pre-existing repair:`");
    // Only the rule is added: the rest of the off-path text is unchanged.
    expect(on.replace(`\n\n${rule.split("\n\n")[0]}`, "")).toBe(off);
  });

  test("the graph Address node's guidance carries the same rule", () => {
    const guidance = addressFindingsValidationGuidance(reviewPackage, "release", "repair");
    expect(guidance).toContain("**Pre-existing failures**");
    expect(guidance).toContain("`Pre-existing repair:`");
  });

  test("without recorded validation there is nothing labelled pre-existing to repair", () => {
    expect(addressFindingsValidationInstruction(undefined, "release", "repair")).toBe(
      addressFindingsValidationInstruction(undefined, "release"),
    );
    expect(multiReviewAddressFindingsValidationInstruction(undefined, "main", true)).toBe("");
    expect(
      multiReviewAddressFindingsValidationInstruction(undefined, "main", true, undefined, "repair"),
    ).toBe("");
  });

  test("Multi Review's instruction lists pre-existing repairs separately in its summary", () => {
    const on = multiReviewAddressFindingsValidationInstruction(
      reviewPackage,
      "release",
      false,
      checks,
      "repair",
    );
    const rule = on.slice(on.indexOf("**Pre-existing failures**"));
    expect(rule).toContain("unrelated to this branch's changes");
    expect(rule).toContain(
      "In your final summary, list each pre-existing repair separately from this branch's own fixes",
    );
    expect(rule).not.toContain("ticket");
    // The summary reporting rule still closes the instruction.
    expect(on.endsWith(MULTI_REVIEW_ADDRESS_FINDINGS_VALIDATION_REPORTING)).toBe(true);
  });

  test("the rule reaches the full Address Findings prompt", () => {
    const prompt = addressFindingsReportPrompt(
      { issues: [], testCoverageGaps: [] } as unknown as StructuredReviewReport,
      multiReviewAddressFindingsValidationInstruction(
        reviewPackage,
        "release",
        false,
        undefined,
        "repair",
      ),
    );
    expect(prompt).toContain("**Pre-existing failures**");
  });

  test("Verify counts a repaired pre-existing failure as repaired and a left one as before", () => {
    const off = verificationFailureInstruction("main");
    const on = verificationFailureInstruction("main", "repair");
    expect(on).toBe(`${off}\n\n${VERIFICATION_PRE_EXISTING_REPAIR_RULE}`);
    expect(VERIFICATION_PRE_EXISTING_REPAIR_RULE).toContain(
      "Count a pre-existing failure as repaired when a commit after the recorded validation headRef plausibly repairs it",
    );
    expect(VERIFICATION_PRE_EXISTING_REPAIR_RULE).toContain(
      "A pre-existing failure it left follows the rule above for its verdict.",
    );

    const task = {
      title: "t",
      description: "d",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    };
    const verify = (addressFindingsPreExisting?: "excuse" | "repair") =>
      verificationTaskPrompt({
        task,
        reviewPackage,
        notes: "",
        targetBranch: "main",
        ...(addressFindingsPreExisting ? { addressFindingsPreExisting } : {}),
      });
    expect(verify("repair")).toContain(VERIFICATION_PRE_EXISTING_REPAIR_RULE);
    expect(verify("excuse")).toBe(verify());
    expect(verify()).not.toContain(VERIFICATION_PRE_EXISTING_REPAIR_RULE);
  });
});
