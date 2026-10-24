import { describe, expect, test } from "bun:test";
import {
  CODEX_LOGIN_RENEWAL_FAILED_SUFFIX,
  CODEX_LOGIN_RENEWING_MESSAGE,
  nextThreadAuthNotice,
} from "./auth-recovery-notice.js";

let counter = 0;
const nextId = () => `occurrence-${(counter += 1)}`;

describe("Codex auth recovery notice", () => {
  test("a started renewal raises an expired notice in Codex's words, or a default", () => {
    expect(nextThreadAuthNotice(undefined, { phase: "started" }, () => "a")).toEqual({
      state: "expired",
      message: CODEX_LOGIN_RENEWING_MESSAGE,
      occurrenceId: "a",
    });
    expect(
      nextThreadAuthNotice(undefined, { phase: "started", message: "Refreshing" }, () => "b"),
    ).toMatchObject({ message: "Refreshing", occurrenceId: "b" });
  });

  test("a repeated start keeps the occurrence the user may have dismissed", () => {
    const first = nextThreadAuthNotice(undefined, { phase: "started" }, nextId);
    expect(nextThreadAuthNotice(first, { phase: "started" }, nextId)).toBe(first);
  });

  test.each([undefined, "Authentication recovered", "Recovery succeeded"])(
    "a completion reading %p clears the notice",
    (message) => {
      const current = nextThreadAuthNotice(undefined, { phase: "started" }, nextId);
      expect(
        nextThreadAuthNotice(current, { phase: "completed", message }, nextId),
      ).toBeUndefined();
    },
  );

  test.each([
    "provider authentication recovery failed",
    "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    "Unable to renew the login",
  ])("a completion reading %p asks for a sign-in", (message) => {
    const current = nextThreadAuthNotice(undefined, { phase: "started" }, () => "start");
    const failed = nextThreadAuthNotice(current, { phase: "completed", message }, () => "failed");
    expect(failed).toMatchObject({ state: "needs-auth", occurrenceId: "failed" });
    expect(failed?.message.endsWith(CODEX_LOGIN_RENEWAL_FAILED_SUFFIX)).toBe(true);
    expect(failed?.message).not.toContain("..");
  });
});
