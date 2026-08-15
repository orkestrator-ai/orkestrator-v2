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
    expect(screen.queryByText("Current") === null).toBe(true);
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

  test("renders no badge for an idle session", async () => {
    renderDialog([{ id: "a", title: "Quiet", status: "idle" }]);

    await waitFor(() => expect(screen.getByText("Quiet")).toBeTruthy());
    expect(screen.queryByText("• Running") === null).toBe(true);
    expect(screen.queryByText("• Error") === null).toBe(true);
  });

  test("renders the trailing detail next to the timestamp", async () => {
    renderDialog([{ id: "a", title: "Chatty", detail: "12 messages" }]);

    await waitFor(() => expect(screen.getByText("12 messages")).toBeTruthy());
  });

  test("shows a spinner until the fetch settles", async () => {
    const pending = deferred<ResumableSession[]>();
    const { container } = render(
      <NativeResumeSessionDialog
        open
        onOpenChange={() => {}}
        agentLabel="Test"
        fetchSessions={() => pending.promise}
        onResume={() => {}}
        emptyMessage="Nothing here"
      />,
    );

    expect(container.ownerDocument.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.queryByText("Nothing here") === null).toBe(true);

    await act(async () => {
      pending.resolve([]);
      await pending.promise;
    });

    expect(container.ownerDocument.querySelector(".animate-spin") === null).toBe(true);
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });

  test("reports a dismissal through onOpenChange", async () => {
    const onOpenChange = mock(() => {});
    render(
      <NativeResumeSessionDialog
        open
        onOpenChange={onOpenChange}
        agentLabel="Test"
        fetchSessions={async () => []}
        onResume={() => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("No previous sessions found.")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
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

  test("fetches once per open cycle even with an unstable fetchSessions prop", async () => {
    /**
     * A chat tab re-renders on every streamed chunk, and the natural thing to
     * write is an inline lambda. Keying the fetch on the prop identity refetched
     * on each of those renders: a spinner flash and a list rebuilt under the
     * user's cursor for the whole turn.
     */
    let fetchCount = 0;
    const props = (open: boolean) => ({
      open,
      onOpenChange: () => {},
      agentLabel: "Test",
      // Deliberately NOT memoized: a new function identity on every render.
      fetchSessions: async () => {
        fetchCount += 1;
        return [{ id: "only", title: "Only session" }];
      },
      onResume: () => {},
    });

    const { rerender } = render(<NativeResumeSessionDialog {...props(true)} />);
    await waitFor(() => expect(screen.getByText("Only session")).toBeTruthy());

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        rerender(<NativeResumeSessionDialog {...props(true)} />);
      });
    }

    expect(fetchCount).toBe(1);
    expect(screen.getByText("Only session")).toBeTruthy();

    // Closing and reopening is still a new cycle, and does refetch.
    await act(async () => {
      rerender(<NativeResumeSessionDialog {...props(false)} />);
    });
    await act(async () => {
      rerender(<NativeResumeSessionDialog {...props(true)} />);
    });
    await waitFor(() => expect(fetchCount).toBe(2));
  });

  test("re-filters without refetching when the current session changes", async () => {
    // The exclusion is derived, not baked in at fetch time, so switching
    // sessions under an open picker cannot leave the current one listed.
    const fetchSessions = mock(async () => [
      { id: "a", title: "Session A" },
      { id: "b", title: "Session B" },
    ]);
    const props = (currentSessionId: string) => ({
      open: true,
      onOpenChange: () => {},
      agentLabel: "Test",
      fetchSessions,
      onResume: () => {},
      currentSessionId,
    });

    const { rerender } = render(<NativeResumeSessionDialog {...props("a")} />);
    await waitFor(() => expect(screen.getByText("Session B")).toBeTruthy());
    expect(screen.queryByText("Session A") === null).toBe(true);

    await act(async () => {
      rerender(<NativeResumeSessionDialog {...props("b")} />);
    });

    expect(screen.getByText("Session A")).toBeTruthy();
    expect(screen.queryByText("Session B") === null).toBe(true);
    expect(fetchSessions).toHaveBeenCalledTimes(1);
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
    expect(screen.queryByText("Closed result") === null).toBe(true);
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
