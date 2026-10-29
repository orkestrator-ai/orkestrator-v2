import { describe, expect, test } from "bun:test";
import {
  CODEX_API_KEY_REFUSED_MESSAGE,
  CODEX_CHATGPT_LOGIN_REFUSED_MESSAGE,
  CODEX_LOGIN_RENEWAL_FAILED_SUFFIX,
  CODEX_LOGIN_REFUSED_MESSAGE,
  CODEX_LOGIN_RENEWING_MESSAGE,
  isRefusedLoginError,
  nextThreadAuthNotice,
  refusedLoginNotice,
  withRefusedLoginKind,
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

describe("Codex refused-login notice", () => {
  test("only `unauthorized` or a forwarded 401 is a refused login", () => {
    expect(isRefusedLoginError({ message: "m", code: "unauthorized" })).toBe(true);
    expect(
      isRefusedLoginError({ message: "m", code: "httpConnectionFailed", httpStatusCode: 401 }),
    ).toBe(true);
    expect(isRefusedLoginError({ message: "m", code: "httpConnectionFailed" })).toBe(false);
    expect(
      isRefusedLoginError({ message: "m", code: "httpConnectionFailed", httpStatusCode: 502 }),
    ).toBe(false);
    // Text alone never locks the composer.
    expect(isRefusedLoginError({ message: "unexpected status 401 Unauthorized" })).toBe(false);
    expect(isRefusedLoginError(undefined)).toBe(false);
  });

  test("raises a sign-in notice and keeps its occurrence for the same refusal", () => {
    const first = refusedLoginNotice(undefined, undefined, () => "refused-1");
    expect(first).toEqual({
      state: "needs-auth",
      message: CODEX_LOGIN_REFUSED_MESSAGE,
      occurrenceId: "refused-1",
    });
    expect(refusedLoginNotice(first, undefined, () => "refused-2")).toBe(first);
    // A renewal notice, or a failed renewal's, is replaced by a new occurrence.
    const renewing = nextThreadAuthNotice(undefined, { phase: "started" }, () => "renewing");
    expect(refusedLoginNotice(renewing, undefined, () => "refused-3")).toMatchObject({
      state: "needs-auth",
      occurrenceId: "refused-3",
    });
  });

  test("names the refused login once `account/read` has said which it is", () => {
    expect(refusedLoginNotice(undefined, "apiKey", () => "key")).toEqual({
      state: "needs-auth",
      message: CODEX_API_KEY_REFUSED_MESSAGE,
      occurrenceId: "key",
    });
    expect(refusedLoginNotice(undefined, "chatgpt", () => "chatgpt").message).toBe(
      CODEX_CHATGPT_LOGIN_REFUSED_MESSAGE,
    );
    // An API-key user is pointed at the key, and still offered the sign-in.
    expect(CODEX_API_KEY_REFUSED_MESSAGE).toContain("codex login --with-api-key");
    expect(CODEX_API_KEY_REFUSED_MESSAGE).toContain("sign in to Codex with ChatGPT");
  });

  test("a login kind learnt after the refusal rewords it in the same occurrence", () => {
    const generic = refusedLoginNotice(undefined, undefined, () => "refused-1");
    const named = withRefusedLoginKind(generic, "apiKey");
    expect(named).toEqual({
      state: "needs-auth",
      message: CODEX_API_KEY_REFUSED_MESSAGE,
      occurrenceId: "refused-1",
    });
    expect(withRefusedLoginKind(named, "apiKey")).toBe(named);
    // A later refusal before the kind is known again keeps the named wording.
    expect(refusedLoginNotice(named, undefined, () => "refused-2")).toBe(named);
    // Other notices are not the refusal's to reword.
    const renewing = nextThreadAuthNotice(undefined, { phase: "started" }, () => "renewing");
    expect(withRefusedLoginKind(renewing, "apiKey")).toBe(renewing);
    expect(withRefusedLoginKind(undefined, "chatgpt")).toBeUndefined();
  });
});
