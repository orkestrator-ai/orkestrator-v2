import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SIGN_IN_EXPIRY_ESTIMATE_NOTE } from "@/lib/sign-in-expiry";
import { SignInExpiry } from "./SignInExpiry";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");

afterEach(() => {
  cleanup();
});

describe("SignInExpiry", () => {
  test("renders nothing without a reported end", () => {
    const { container } = render(<SignInExpiry account={{}} now={NOW} />);
    expect(container.innerHTML).toBe("");
  });

  test("shows the date as a machine-readable time", () => {
    const { container } = render(
      <SignInExpiry account={{ expiresAt: "2026-12-03T10:00:00.000Z" }} now={NOW} locale="en-GB" />,
    );
    const line = container.querySelector("[data-sign-in-expiry]");
    expect(line?.getAttribute("data-sign-in-expiry")).toBe("upcoming");
    expect(line?.textContent).toBe("Sign-in ends 3 Dec 2026");
    expect(line?.getAttribute("title")).toBeNull();
    expect(screen.getByText("3 Dec 2026").getAttribute("dateTime")).toBe(
      "2026-12-03T10:00:00.000Z",
    );
  });

  test("an estimate explains itself to pointer and screen-reader users", () => {
    const { container } = render(
      <SignInExpiry
        account={{ expiresAt: "2026-11-08T12:00:00.000Z", expiresAtEstimated: true }}
        now={NOW}
        locale="en-GB"
      />,
    );
    const line = container.querySelector("[data-sign-in-expiry]");
    expect(line?.getAttribute("data-sign-in-expiry")).toBe("soon");
    expect(line?.getAttribute("title")).toBe(SIGN_IN_EXPIRY_ESTIMATE_NOTE);
    expect(line?.textContent).toBe(
      `Sign-in ends about 8 Nov 2026 (in 2 days). ${SIGN_IN_EXPIRY_ESTIMATE_NOTE}`,
    );
    expect(line?.className).toContain("text-amber-500");
  });

  test("a past end is emphasised", () => {
    const { container } = render(
      <SignInExpiry account={{ expiresAt: "2026-11-01T00:00:00.000Z" }} now={NOW} locale="en-GB" />,
    );
    const line = container.querySelector("[data-sign-in-expiry]");
    expect(line?.getAttribute("data-sign-in-expiry")).toBe("ended");
    expect(line?.textContent).toBe("Sign-in may have ended on 1 Nov 2026");
    expect(line?.className).toContain("text-destructive");
  });
});
