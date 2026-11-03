import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PeerMailPresentation } from "@/lib/chat/native-message-types";
import { PullRequestOpenerProvider } from "@/lib/pull-request-opener";
import {
  PullRequestUpdateNotice,
  watchedPullRequestRef,
  watchedPullRequestSummary,
} from "./PullRequestUpdateNotice";

function mail(overrides: Partial<PeerMailPresentation> = {}): PeerMailPresentation {
  return {
    messageId: "mail-1",
    kind: "notice",
    sender: "Orkestrator workflow",
    subject: "PR #12 updated: Add the watch",
    warning: "Orkestrator status notice.",
    body: [
      'Pull request #12 "Add the watch" in acme/app: checks passing, approved.',
      "URL: https://github.com/acme/app/pull/12",
      "",
      "This is for awareness only.",
    ].join("\n"),
    notice: {
      resource: { kind: "watched-pull-request", id: "acme/app#12", label: "Add the watch" },
      state: "pr-updated",
      tone: "info",
    },
    ...overrides,
  };
}

describe("PullRequestUpdateNotice", () => {
  afterEach(() => cleanup());

  test("is one quiet line with the number, title and what changed", () => {
    const { container } = render(<PullRequestUpdateNotice mail={mail()} timestampLabel="10:04" />);
    const row = container.querySelector<HTMLElement>("[data-pr-update-notice]")!;
    expect(row.textContent).toBe("PR #12updated· Add the watch· checks passing, approved10:04");
    // Not a mail tile: no expandable body, no conversation button.
    expect(container.querySelector("[data-mail-tile]")).toBeNull();
    expect(container.querySelector("[data-mail-body]")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  test("the number opens the pull request in the app", () => {
    const open = mock(() => true);
    render(
      <PullRequestOpenerProvider open={open}>
        <PullRequestUpdateNotice mail={mail()} />
      </PullRequestOpenerProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "PR #12" }));
    expect(open).toHaveBeenCalledWith({ owner: "acme", repo: "app", number: 12 }, undefined);
  });

  test("falls back to the state when the body has no summary", () => {
    expect(
      watchedPullRequestSummary(
        mail({
          body: "Something else",
          notice: { ...mail().notice!, state: "pr-merged", tone: "success" },
        }),
      ),
    ).toBe("merged");
    expect(watchedPullRequestRef("acme/app#12")).toEqual({
      owner: "acme",
      repo: "app",
      number: 12,
    });
    expect(watchedPullRequestRef("acme/app#0")).toBeNull();
    expect(watchedPullRequestRef("../x#1")).toBeNull();
  });
});
