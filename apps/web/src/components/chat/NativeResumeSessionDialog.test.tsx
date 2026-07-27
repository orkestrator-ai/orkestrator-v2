import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  NativeResumeSessionDialog,
  type ResumableSession,
} from "./NativeResumeSessionDialog";

/**
 * The three per-agent wrappers stub this dialog out in their tab suites, so
 * without this file the picker every native tab depends on — including the
 * activity ordering that replaced OpenCode's creation-time sort — has no
 * coverage at all.
 */
function renderDialog(
  sessions: ResumableSession[] | Promise<ResumableSession[]>,
  props: Partial<React.ComponentProps<typeof NativeResumeSessionDialog>> = {},
) {
  const onResume = mock(() => {});
  const fetchSessions = mock(() =>
    sessions instanceof Promise ? sessions : Promise.resolve(sessions),
  );
  render(
    <NativeResumeSessionDialog
      open
      onOpenChange={() => {}}
      agentLabel="Test"
      fetchSessions={fetchSessions}
      onResume={onResume}
      {...props}
    />,
  );
  return { onResume, fetchSessions };
}

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("NativeResumeSessionDialog", () => {
  test("orders most-recently-active first, not by creation", async () => {
    renderDialog([
      { id: "older", title: "Older", activityAt: "2026-07-20T10:00:00.000Z" },
      { id: "newest", title: "Newest", activityAt: "2026-07-26T10:00:00.000Z" },
      { id: "middle", title: "Middle", activityAt: "2026-07-24T10:00:00.000Z" },
    ]);

    await waitFor(() => expect(screen.getByText("Newest")).toBeTruthy());
    const titles = screen
      .getAllByRole("button")
      .map((button) => button.querySelector("p")?.textContent);
    expect(titles).toEqual(["Newest", "Middle", "Older"]);
  });

  test("sinks sessions with an unusable timestamp to the bottom", async () => {
    // Treating an unparseable value as 0 would otherwise date it to 1970 and
    // bury a genuinely recent session below it — the same class of bug as the
    // creation-time sort.
    renderDialog([
      { id: "unknown", title: "Unknown", activityAt: "not a date" },
      { id: "known", title: "Known", activityAt: "2026-07-20T10:00:00.000Z" },
      { id: "missing", title: "Missing" },
    ]);

    await waitFor(() => expect(screen.getByText("Known")).toBeTruthy());
    const titles = screen
      .getAllByRole("button")
      .map((button) => button.querySelector("p")?.textContent);
    expect(titles[0]).toBe("Known");
  });

  test("excludes the session the user is already in", async () => {
    renderDialog(
      [
        { id: "current", title: "Current" },
        { id: "other", title: "Other" },
      ],
      { currentSessionId: "current" },
    );

    await waitFor(() => expect(screen.getByText("Other")).toBeTruthy());
    expect(screen.queryByText("Current")).toBeNull();
  });

  test("resumes the clicked session by id", async () => {
    const { onResume } = renderDialog([{ id: "session-abc", title: "Pick me" }]);

    await waitFor(() => expect(screen.getByText("Pick me")).toBeTruthy());
    fireEvent.click(screen.getByText("Pick me"));
    expect(onResume).toHaveBeenCalledWith("session-abc");
  });

  test("falls back to a truncated id when a session has no title", async () => {
    renderDialog([{ id: "0123456789abcdef" }]);

    await waitFor(() => expect(screen.getByText("Session 01234567")).toBeTruthy());
  });

  test("shows the empty state when nothing is resumable", async () => {
    renderDialog([], { emptyMessage: "Nothing here" });
    await waitFor(() => expect(screen.getByText("Nothing here")).toBeTruthy());
  });

  test("surfaces a fetch failure instead of an empty list", async () => {
    // An empty list and a failed fetch mean very different things to the user;
    // reporting the failure as "no sessions" would hide a broken bridge.
    render(
      <NativeResumeSessionDialog
        open
        onOpenChange={() => {}}
        agentLabel="Test"
        fetchSessions={() => Promise.reject(new Error("bridge down"))}
        onResume={() => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Failed to load sessions")).toBeTruthy(),
    );
  });

  test("renders running and error status badges", async () => {
    renderDialog([
      { id: "a", title: "Busy", status: "running" },
      { id: "b", title: "Broken", status: "error" },
    ]);

    await waitFor(() => expect(screen.getByText("• Running")).toBeTruthy());
    expect(screen.getByText("• Error")).toBeTruthy();
  });

  test("does not fetch while closed, and fetches when opened", async () => {
    const fetchSessions = mock(() => Promise.resolve([] as ResumableSession[]));
    const { rerender } = render(
      <NativeResumeSessionDialog
        open={false}
        onOpenChange={() => {}}
        agentLabel="Test"
        fetchSessions={fetchSessions}
        onResume={() => {}}
      />,
    );

    expect(fetchSessions).not.toHaveBeenCalled();

    rerender(
      <NativeResumeSessionDialog
        open
        onOpenChange={() => {}}
        agentLabel="Test"
        fetchSessions={fetchSessions}
        onResume={() => {}}
      />,
    );

    await waitFor(() => expect(fetchSessions).toHaveBeenCalledTimes(1));
  });

  test("ignores an older request when fetch dependencies change", async () => {
    const first = deferred<ResumableSession[]>();
    const second = deferred<ResumableSession[]>();
    const onOpenChange = () => {};
    const onResume = () => {};
    const { rerender } = render(
      <NativeResumeSessionDialog
        open
        onOpenChange={onOpenChange}
        agentLabel="Test"
        fetchSessions={() => first.promise}
        onResume={onResume}
      />,
    );

    rerender(
      <NativeResumeSessionDialog
        open
        onOpenChange={onOpenChange}
        agentLabel="Test"
        fetchSessions={() => second.promise}
        onResume={onResume}
      />,
    );

    await act(async () => {
      second.resolve([{ id: "new", title: "New result" }]);
      await second.promise;
    });
    expect(await screen.findByText("New result")).toBeTruthy();

    await act(async () => {
      first.resolve([{ id: "old", title: "Stale result" }]);
      await first.promise;
    });
    expect(screen.getByText("New result")).toBeTruthy();
    expect(screen.queryByText("Stale result")).toBeNull();
  });

  test("ignores a request from a previous open cycle", async () => {
    const first = deferred<ResumableSession[]>();
    const second = deferred<ResumableSession[]>();
    const fetchSessions = mock()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onOpenChange = () => {};
    const onResume = () => {};
    const { rerender } = render(
      <NativeResumeSessionDialog
        open
        onOpenChange={onOpenChange}
        agentLabel="Test"
        fetchSessions={fetchSessions}
        onResume={onResume}
      />,
    );

    rerender(
      <NativeResumeSessionDialog
        open={false}
        onOpenChange={onOpenChange}
        agentLabel="Test"
        fetchSessions={fetchSessions}
        onResume={onResume}
      />,
    );
    rerender(
      <NativeResumeSessionDialog
        open
        onOpenChange={onOpenChange}
        agentLabel="Test"
        fetchSessions={fetchSessions}
        onResume={onResume}
      />,
    );

    await waitFor(() => expect(fetchSessions).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve([{ id: "new", title: "Reopened result" }]);
      await second.promise;
    });
    expect(await screen.findByText("Reopened result")).toBeTruthy();

    await act(async () => {
      first.resolve([{ id: "old", title: "Closed result" }]);
      await first.promise;
    });
    expect(screen.getByText("Reopened result")).toBeTruthy();
    expect(screen.queryByText("Closed result")).toBeNull();
  });

  test("does not report a request failure after unmount", async () => {
    const pending = deferred<ResumableSession[]>();
    const consoleError = console.error;
    const errorSpy = mock(() => {});
    console.error = errorSpy;

    try {
      const { unmount } = render(
        <NativeResumeSessionDialog
          open
          onOpenChange={() => {}}
          agentLabel="Test"
          fetchSessions={() => pending.promise}
          onResume={() => {}}
        />,
      );
      unmount();

      await act(async () => {
        pending.reject(new Error("late failure"));
        try {
          await pending.promise;
        } catch {
          // The dialog owns the rejection; this await only flushes its handler.
        }
      });

      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      console.error = consoleError;
    }
  });
});
