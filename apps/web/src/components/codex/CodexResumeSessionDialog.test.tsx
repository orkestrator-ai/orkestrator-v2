import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CodexClient, CodexSessionStatusLookupResult } from "@/lib/codex-client";
import * as realCodexClient from "@/lib/codex-client";

const realCodexClientSnapshot = { ...realCodexClient };
const listSessionsMock = mock(async () => [] as Awaited<ReturnType<typeof realCodexClient.listSessions>>);
const lookupSessionStatusMock = mock(
  async (): Promise<CodexSessionStatusLookupResult> => ({ kind: "missing" }),
);

mock.module("@/lib/codex-client", () => ({
  ...realCodexClientSnapshot,
  listSessions: listSessionsMock,
  lookupSessionStatus: lookupSessionStatusMock,
}));

const { CodexResumeSessionDialog } = await import("./CodexResumeSessionDialog");

const client = { baseUrl: "http://127.0.0.1:9999" } as CodexClient;
const sessions = [
  {
    id: "thread-current",
    title: "Current thread",
    updatedAt: "2026-07-20T10:00:00.000Z",
  },
  {
    id: "thread-other",
    title: "Other thread",
    updatedAt: "2026-07-21T10:00:00.000Z",
  },
];

afterAll(() => {
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
});

beforeEach(() => {
  listSessionsMock.mockClear();
  lookupSessionStatusMock.mockClear();
  listSessionsMock.mockImplementation(async () => sessions);
  lookupSessionStatusMock.mockImplementation(async () => ({ kind: "missing" }));
});

afterEach(cleanup);

describe("CodexResumeSessionDialog", () => {
  test("filters the current thread derived from the bridge session status", async () => {
    lookupSessionStatusMock.mockImplementation(async () => ({
      kind: "found",
      session: { status: "idle", threadId: "thread-current" },
    }));

    const onResume = mock(() => {});
    render(
      <CodexResumeSessionDialog
        open
        onOpenChange={() => {}}
        client={client}
        onResume={onResume}
        currentSessionId="bridge-session"
      />,
    );

    expect(await screen.findByText("Other thread")).toBeTruthy();
    expect(screen.queryByText("Current thread")).toBeNull();
    expect(lookupSessionStatusMock).toHaveBeenCalledWith(client, "bridge-session");
    fireEvent.click(screen.getByText("Other thread"));
    expect(onResume).toHaveBeenCalledWith("thread-other");
  });

  test.each([
    ["missing", { kind: "missing" } as CodexSessionStatusLookupResult],
    [
      "unavailable",
      { kind: "unavailable", error: new Error("bridge unavailable") } as CodexSessionStatusLookupResult,
    ],
  ])("still lists resumable threads when current status is %s", async (_label, status) => {
    lookupSessionStatusMock.mockImplementation(async () => status);

    render(
      <CodexResumeSessionDialog
        open
        onOpenChange={() => {}}
        client={client}
        onResume={() => {}}
        currentSessionId="bridge-session"
      />,
    );

    expect(await screen.findByText("Current thread")).toBeTruthy();
    expect(screen.getByText("Other thread")).toBeTruthy();
  });

  test("does not perform a status lookup when no current bridge session exists", async () => {
    render(
      <CodexResumeSessionDialog
        open
        onOpenChange={() => {}}
        client={client}
        onResume={() => {}}
      />,
    );

    await waitFor(() => expect(listSessionsMock).toHaveBeenCalledWith(client));
    expect(lookupSessionStatusMock).not.toHaveBeenCalled();
  });

  test("propagates a rejected session list to the shared error state", async () => {
    listSessionsMock.mockImplementation(async () => {
      throw new Error("Codex list unavailable");
    });
    render(
      <CodexResumeSessionDialog
        open
        onOpenChange={() => {}}
        client={client}
        onResume={() => {}}
        currentSessionId="bridge-session"
      />,
    );

    expect(await screen.findByText("Failed to load sessions")).toBeTruthy();
    expect(screen.queryByText("No previous sessions found.")).toBeNull();
  });

  test("still lists threads when the current-status lookup unexpectedly rejects", async () => {
    lookupSessionStatusMock.mockImplementation(async () => {
      throw new Error("status lookup crashed");
    });
    render(
      <CodexResumeSessionDialog
        open
        onOpenChange={() => {}}
        client={client}
        onResume={() => {}}
        currentSessionId="bridge-session"
      />,
    );

    expect(await screen.findByText("Current thread")).toBeTruthy();
    expect(screen.getByText("Other thread")).toBeTruthy();
  });
});
