import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as realTmuxClient from "@/lib/claude-tmux-client";
import type { PreviousSession } from "@/lib/claude-tmux-client";

// Snapshot the real client module so any sibling tests that import it later
// see the original behavior (see CLAUDE.md "Bun mock.module() rules").
const realTmuxClientSnapshot = { ...realTmuxClient };

const listPreviousSessionsMock = mock(
  async (_envId: string): Promise<PreviousSession[]> => [],
);

mock.module("@/lib/claude-tmux-client", () => ({
  ...realTmuxClientSnapshot,
  listPreviousSessions: listPreviousSessionsMock,
}));

const { ResumeTmuxSessionDialog } = await import(
  "@/components/claude/ResumeTmuxSessionDialog"
);

function makeSession(overrides: Partial<PreviousSession>): PreviousSession {
  return {
    session_id: overrides.session_id ?? "sess-1",
    // Use `in` so a deliberate `title: null` is preserved instead of
    // collapsing to the default via `??`.
    title: "title" in overrides ? overrides.title ?? null : "Hello world",
    last_activity_unix:
      overrides.last_activity_unix ?? Math.floor(Date.now() / 1000) - 60,
    message_count: overrides.message_count ?? 3,
    transcript_path:
      overrides.transcript_path ?? "/tmp/sessions/sess-1.jsonl",
  };
}

describe("ResumeTmuxSessionDialog", () => {
  afterAll(() => {
    mock.module("@/lib/claude-tmux-client", () => realTmuxClientSnapshot);
  });

  beforeEach(() => {
    cleanup();
    listPreviousSessionsMock.mockClear();
    listPreviousSessionsMock.mockImplementation(async () => []);
  });

  test("renders nothing while closed", () => {
    render(
      <ResumeTmuxSessionDialog
        open={false}
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={() => {}}
      />,
    );
    expect(screen.queryByText("Resume Session")).toBeNull();
    expect(listPreviousSessionsMock).not.toHaveBeenCalled();
  });

  test("shows the empty state when there are no previous sessions", async () => {
    listPreviousSessionsMock.mockImplementation(async () => []);
    render(
      <ResumeTmuxSessionDialog
        open
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={() => {}}
      />,
    );
    expect(
      await screen.findByText(/No previous sessions recorded/i),
    ).toBeTruthy();
    expect(listPreviousSessionsMock).toHaveBeenCalledTimes(1);
    expect(listPreviousSessionsMock.mock.calls[0]).toEqual(["env-1"]);
  });

  test("shows a loading indicator until the session request settles", async () => {
    let resolveSessions!: (sessions: PreviousSession[]) => void;
    listPreviousSessionsMock.mockImplementation(
      () => new Promise<PreviousSession[]>((resolve) => {
        resolveSessions = resolve;
      }),
    );

    render(
      <ResumeTmuxSessionDialog
        open
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={() => {}}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector(".animate-spin")).toBeTruthy(),
    );
    expect(screen.queryByText(/No previous sessions recorded/i)).toBeNull();

    resolveSessions([]);
    expect(
      await screen.findByText(/No previous sessions recorded/i),
    ).toBeTruthy();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  test("renders an error message when listing fails", async () => {
    listPreviousSessionsMock.mockImplementation(async () => {
      throw new Error("backend unavailable");
    });
    render(
      <ResumeTmuxSessionDialog
        open
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={() => {}}
      />,
    );
    expect(await screen.findByText(/backend unavailable/i)).toBeTruthy();
  });

  test("lists sessions and calls onResume with the picked id", async () => {
    listPreviousSessionsMock.mockImplementation(async () => [
      makeSession({
        session_id: "sess-newer",
        title: "Newer session title",
        last_activity_unix: Math.floor(Date.now() / 1000) - 30,
        message_count: 4,
      }),
      makeSession({
        session_id: "sess-older",
        title: "Older session title",
        last_activity_unix: Math.floor(Date.now() / 1000) - 3600,
        message_count: 1,
      }),
    ]);

    const onResume = mock(() => {});

    render(
      <ResumeTmuxSessionDialog
        open
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={onResume}
      />,
    );

    const newer = await screen.findByText("Newer session title");
    expect(screen.getByText("Older session title")).toBeTruthy();

    // Counts pluralize correctly.
    expect(screen.getByText("4 messages")).toBeTruthy();
    expect(screen.getByText("1 message")).toBeTruthy();

    fireEvent.click(newer);
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(onResume.mock.calls[0]).toEqual(["sess-newer"]);
  });

  test("falls back to session id when title is null", async () => {
    listPreviousSessionsMock.mockImplementation(async () => [
      makeSession({
        session_id: "abcdef12-3456-7890-abcd-ef1234567890",
        title: null,
      }),
    ]);

    render(
      <ResumeTmuxSessionDialog
        open
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={() => {}}
      />,
    );

    // The dialog falls back to "Session <first 8 chars of id>" when title is null.
    expect(await screen.findByText(/Session abcdef12/)).toBeTruthy();
  });

  test("re-fetches when the dialog re-opens", async () => {
    let calls = 0;
    listPreviousSessionsMock.mockImplementation(async () => {
      calls += 1;
      return [];
    });

    const { rerender } = render(
      <ResumeTmuxSessionDialog
        open
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={() => {}}
      />,
    );

    await waitFor(() => expect(calls).toBe(1));

    // Close then re-open the dialog — list should refetch.
    rerender(
      <ResumeTmuxSessionDialog
        open={false}
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={() => {}}
      />,
    );
    rerender(
      <ResumeTmuxSessionDialog
        open
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={() => {}}
      />,
    );
    await waitFor(() => expect(calls).toBe(2));
  });
});
