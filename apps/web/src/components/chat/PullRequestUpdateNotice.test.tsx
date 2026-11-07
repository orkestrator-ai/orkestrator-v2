import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { invoke } from "@/lib/native/backend";
import {
  CoordinatorPullRequestWatchProvider,
  resetCoordinatorPullRequestWatchReports,
} from "@/lib/coordinator-pull-request-watch";
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
  afterEach(() => {
    cleanup();
    resetCoordinatorPullRequestWatchReports();
  });

  test("is one quiet line with the number, title and what changed", () => {
    const { container } = renderInAppCommandScope(
      <PullRequestUpdateNotice mail={mail()} timestampLabel="10:04" />,
    );
    const row = container.querySelector<HTMLElement>("[data-pr-update-notice]")!;
    expect(row.textContent).toBe("PR #12updated· Add the watch· checks passing, approved10:04");
    // Not a mail tile: no expandable body, no conversation button.
    expect(container.querySelector("[data-mail-tile]") === null).toBe(true);
    expect(container.querySelector("[data-mail-body]") === null).toBe(true);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  test("the number opens the pull request in the app", () => {
    const open = mock(() => true);
    renderInAppCommandScope(
      <PullRequestOpenerProvider open={open}>
        <PullRequestUpdateNotice mail={mail()} />
      </PullRequestOpenerProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "PR #12" }));
    expect(open).toHaveBeenCalledWith({ owner: "acme", repo: "app", number: 12 }, undefined);
  });

  test.each([{}, { metaKey: true }, { ctrlKey: true }])(
    "notice opens register a watch, including modifiers %j",
    (modifiers) => {
      const nativeInvoke = invoke as ReturnType<typeof mock>;
      nativeInvoke.mockClear();
      const open = mock(() => true);
      renderInAppCommandScope(
        <CoordinatorPullRequestWatchProvider projectId="project-a">
          <PullRequestOpenerProvider open={open}>
            <PullRequestUpdateNotice
              mail={mail({ notice: { ...mail().notice!, state: "pr-closed" } })}
            />
          </PullRequestOpenerProvider>
        </CoordinatorPullRequestWatchProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "PR #12" }), modifiers);
      expect(
        nativeInvoke.mock.calls
          .filter((call) => call[0] === "watch_coordinator_pull_request")
          .map((call) => call[1]),
      ).toContainEqual({
        projectId: "project-a",
        owner: "acme",
        repo: "app",
        number: 12,
        source: "opened",
      });
      expect(open).toHaveBeenCalledTimes("metaKey" in modifiers || "ctrlKey" in modifiers ? 0 : 1);
    },
  );

  test("a deleted pull request reads as one quiet line too", () => {
    const deleted = mail({
      body: 'Pull request #12 "Add the watch" in acme/app: deleted from GitHub.\nURL: x',
      notice: { ...mail().notice!, state: "pr-gone", tone: "info" },
    });
    expect(watchedPullRequestSummary(deleted)).toBe("deleted from GitHub");
    expect(watchedPullRequestSummary({ ...deleted, body: "Something else" })).toBe(
      "no longer available",
    );
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
