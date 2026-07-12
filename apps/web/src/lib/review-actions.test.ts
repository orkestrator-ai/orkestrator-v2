import { describe, expect, test } from "bun:test";
import { ADDRESS_ALL_REVIEW_PROMPT } from "./review-actions";

describe("review actions", () => {
  test("keeps the Address all prompt stable", () => {
    expect(ADDRESS_ALL_REVIEW_PROMPT).toBe(
      "Please address all the issues and coverage gaps",
    );
  });
});
