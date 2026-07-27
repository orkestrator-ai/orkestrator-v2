import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ClaudeClient } from "@/lib/claude-client";
import * as realClaudeClient from "@/lib/claude-client";

const realClaudeClientSnapshot = { ...realClaudeClient };
const listSessionsMock = mock(async () => [] as Awaited<ReturnType<typeof realClaudeClient.listSessions>>);

mock.module("@/lib/claude-client", () => ({
  ...realClaudeClientSnapshot,
  listSessions: listSessionsMock,
}));

const { ResumeSessionDialog } = await import("./ResumeSessionDialog");

const client = { baseUrl: "http://127.0.0.1:9999" } as ClaudeClient;

afterAll(() => {
  mock.module("@/lib/claude-client", () => realClaudeClientSnapshot);
});

beforeEach(() => {
  listSessionsMock.mockClear();
  listSessionsMock.mockImplementation(async () => []);
});

afterEach(cleanup);

describe("ResumeSessionDialog", () => {
  test("maps Claude activity and status fields and filters the current session", async () => {
    listSessionsMock.mockImplementation(async () => [
      {
        id: "current",
        title: "Current",
        status: "idle",
        createdAt: "2026-07-20T09:00:00.000Z",
        lastActivity: "2026-07-20T10:00:00.000Z",
      },
      {
        id: "other",
        title: "Other",
        status: "running",
        createdAt: "2026-07-19T09:00:00.000Z",
        lastActivity: "2026-07-21T10:00:00.000Z",
      },
    ]);

    const onResume = mock(() => {});
    render(
      <ResumeSessionDialog
        open
        onOpenChange={() => {}}
        client={client}
        onResume={onResume}
        currentSessionId="current"
      />,
    );

    expect(await screen.findByText("Other")).toBeTruthy();
    expect(screen.queryByText("Current")).toBeNull();
    expect(screen.getByText("• Running")).toBeTruthy();
    fireEvent.click(screen.getByText("Other"));
    expect(onResume).toHaveBeenCalledWith("other");
  });

  test("passes the client to the Claude session list adapter", async () => {
    render(
      <ResumeSessionDialog
        open
        onOpenChange={() => {}}
        client={client}
        onResume={() => {}}
      />,
    );

    await waitFor(() => expect(listSessionsMock).toHaveBeenCalledTimes(1));
    expect(listSessionsMock).toHaveBeenCalledWith(client);
  });

  test("propagates a rejected session list to the shared error state", async () => {
    listSessionsMock.mockImplementation(async () => {
      throw new Error("Claude list unavailable");
    });
    render(
      <ResumeSessionDialog
        open
        onOpenChange={() => {}}
        client={client}
        onResume={() => {}}
      />,
    );

    expect(await screen.findByText("Failed to load sessions")).toBeTruthy();
    expect(screen.queryByText("No previous sessions found.")).toBeNull();
  });
});
