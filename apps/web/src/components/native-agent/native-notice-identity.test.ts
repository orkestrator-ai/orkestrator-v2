import { describe, expect, test } from "bun:test";
import { NOTICE_DISMISSAL_LIMITS } from "@orkestrator/protocol/notice-dismissals";
import { nativeNoticeDismissalId } from "./native-notice-identity";

describe("nativeNoticeDismissalId", () => {
  test("keeps an occurrence or a short message as the identity", () => {
    expect(
      nativeNoticeDismissalId({ kind: "warning", message: "text", occurrenceId: "occurrence" }),
    ).toBe("warning\u0000warning\u0000occurrence");
    expect(nativeNoticeDismissalId({ kind: "error", message: "short" })).toBe(
      "error\u0000error\u0000short",
    );
  });

  test("a long message stays within the stored bound and distinct from its neighbours", () => {
    const first = nativeNoticeDismissalId({ kind: "error", message: `${"x".repeat(9_000)}a` });
    const second = nativeNoticeDismissalId({ kind: "error", message: `${"x".repeat(9_000)}b` });
    expect(first.length).toBeLessThanOrEqual(NOTICE_DISMISSAL_LIMITS.occurrenceChars);
    expect(first).not.toBe(second);
    expect(nativeNoticeDismissalId({ kind: "error", message: `${"x".repeat(9_000)}a` })).toBe(
      first,
    );
  });
});
