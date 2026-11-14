import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { PeerMailPresentation } from "@/lib/chat/native-message-types";
import { AccountSwitchNotice } from "./AccountSwitchNotice";

function mail(overrides: Partial<PeerMailPresentation> = {}): PeerMailPresentation {
  return {
    messageId: "mail-1",
    kind: "notice",
    sender: "Orkestrator workflow",
    subject: "Claude Code moved to b@example.com on mini",
    warning: "Orkestrator status notice.",
    body: "Automatic account switching moved Claude Code on mini from a@example.com to b@example.com, because its general weekly limit reached 98%. Nothing needs doing.",
    notice: {
      resource: { kind: "account-switch", id: "claude", label: "mini" },
      accountSwitch: { provider: "Claude Code", from: "a@example.com", to: "b@example.com" },
      state: "account-switched",
      tone: "info",
    },
    ...overrides,
  };
}

describe("AccountSwitchNotice", () => {
  afterEach(cleanup);

  test("is one quiet line from the old account to the new one", () => {
    const { container } = render(<AccountSwitchNotice mail={mail()} timestampLabel="10:04" />);
    const row = container.querySelector<HTMLElement>("[data-account-switch-notice]")!;
    expect(row.textContent).toBe("Claude Code· minia@example.comb@example.com10:04");
    // Not a mail tile: no body, no buttons, none of the notice's prose.
    expect(container.querySelector("[data-mail-tile]") === null).toBe(true);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(row.textContent).not.toContain("Nothing needs doing");
  });

  test("keeps working when the accounts did not survive, falling back to the subject", () => {
    const { container } = render(
      <AccountSwitchNotice
        mail={mail({
          notice: {
            resource: { kind: "account-switch", id: "claude" },
            state: "account-switched",
            tone: "info",
          },
        })}
      />,
    );
    expect(container.textContent).toBe("Claude Code moved to b@example.com on mini");
  });
});
