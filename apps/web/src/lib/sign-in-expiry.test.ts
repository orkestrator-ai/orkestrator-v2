import { describe, expect, test } from "bun:test";
import {
  SIGN_IN_EXPIRY_ESTIMATE_NOTE,
  describeSignInExpiry,
  formatSignInExpiryDate,
} from "./sign-in-expiry";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();

describe("describeSignInExpiry", () => {
  test.each([undefined, {}, { expiresAt: "" }, { expiresAt: "never" }])(
    "has no line for %p",
    (account) => {
      expect(describeSignInExpiry(account, NOW, "en-GB")).toBeUndefined();
    },
  );

  test("a far end is a plain date", () => {
    expect(describeSignInExpiry({ expiresAt: "2026-12-03T10:00:00.000Z" }, NOW, "en-GB")).toEqual({
      tone: "upcoming",
      text: "Sign-in ends 3 Dec 2026",
      lead: "Sign-in ends ",
      date: "3 Dec 2026",
      trail: "",
      dateTime: "2026-12-03T10:00:00.000Z",
    });
  });

  test("an estimate says about, and why", () => {
    const line = describeSignInExpiry(
      { expiresAt: "2026-12-03T10:00:00.000Z", expiresAtEstimated: true },
      NOW,
      "en-GB",
    );
    expect(line?.text).toBe("Sign-in ends about 3 Dec 2026");
    expect(line?.note).toBe(SIGN_IN_EXPIRY_ESTIMATE_NOTE);
  });

  test.each([
    [2.5 * DAY, "soon", "(in 2 days)"],
    [1.2 * DAY, "soon", "(in 1 day)"],
    [5 * 60 * 60 * 1000, "soon", "(within a day)"],
    [3 * DAY + 1, "upcoming", ""],
  ] as const)("%d ms before the end reads %s", (left, tone, trail) => {
    const line = describeSignInExpiry({ expiresAt: at(NOW + left) }, NOW, "en-GB");
    expect(line?.tone).toBe(tone);
    expect(line?.trail.trim()).toBe(trail);
  });

  test("an estimate asks for attention three days sooner", () => {
    const expiresAt = at(NOW + 5 * DAY);
    expect(describeSignInExpiry({ expiresAt }, NOW)?.tone).toBe("upcoming");
    expect(describeSignInExpiry({ expiresAt, expiresAtEstimated: true }, NOW)?.tone).toBe("soon");
    expect(
      describeSignInExpiry({ expiresAt: at(NOW + 6 * DAY + 1), expiresAtEstimated: true }, NOW)
        ?.tone,
    ).toBe("upcoming");
  });

  test("a past or present end may have ended", () => {
    expect(describeSignInExpiry({ expiresAt: at(NOW) }, NOW, "en-GB")?.text).toBe(
      "Sign-in may have ended on 6 Nov 2026",
    );
    const estimated = describeSignInExpiry(
      { expiresAt: "2026-11-01T00:00:00.000Z", expiresAtEstimated: true },
      NOW,
      "en-GB",
    );
    expect(estimated?.tone).toBe("ended");
    expect(estimated?.text).toBe("Sign-in may have ended around 1 Nov 2026");
  });

  test("the date follows the locale", () => {
    const ms = Date.parse("2026-12-03T10:00:00.000Z");
    expect(formatSignInExpiryDate(ms, "en-GB")).toBe("3 Dec 2026");
    expect(formatSignInExpiryDate(ms, "en-US")).toBe("Dec 3, 2026");
  });
});
