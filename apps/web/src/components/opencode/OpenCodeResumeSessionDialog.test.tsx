import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { OpencodeClient, OpenCodeSession } from "@/lib/opencode-client";
import type { ResumableSession } from "@/components/chat/NativeResumeSessionDialog";

import * as realOpenCodeClient from "@/lib/opencode-client";
import * as realNativeResumeSessionDialog from "@/components/chat/NativeResumeSessionDialog";
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };
const realNativeResumeSessionDialogSnapshot = {
  ...realNativeResumeSessionDialog,
};

const listSessionsMock = mock(
  async (_client: OpencodeClient): Promise<OpenCodeSession[]> => [],
);
let capturedProps:
  | {
      open: boolean;
      agentLabel: string;
      currentSessionId?: string;
      fetchSessions: () => Promise<ResumableSession[]>;
      onResume: (sessionId: string) => void;
      onOpenChange: (open: boolean) => void;
    }
  | undefined;

mock.module("@/lib/opencode-client", () => ({
  ...realOpenCodeClientSnapshot,
  listSessions: listSessionsMock,
}));

mock.module("@/components/chat/NativeResumeSessionDialog", () => ({
  ...realNativeResumeSessionDialogSnapshot,
  NativeResumeSessionDialog: (props: NonNullable<typeof capturedProps>) => {
    capturedProps = props;
    return <div data-testid="resume-adapter">{props.agentLabel}</div>;
  },
}));

afterAll(() => {
  mock.module("@/lib/opencode-client", () => realOpenCodeClientSnapshot);
  mock.module(
    "@/components/chat/NativeResumeSessionDialog",
    () => realNativeResumeSessionDialogSnapshot,
  );
});

const { OpenCodeResumeSessionDialog } = await import(
  "./OpenCodeResumeSessionDialog"
);

const CLIENT = {
  baseUrl: "http://127.0.0.1:9999",
} as unknown as OpencodeClient;

beforeEach(() => {
  capturedProps = undefined;
  listSessionsMock.mockReset();
  listSessionsMock.mockResolvedValue([]);
});

afterEach(cleanup);

describe("OpenCodeResumeSessionDialog", () => {
  test("maps updatedAt to activityAt and forwards the dialog contract", async () => {
    listSessionsMock.mockResolvedValue([
      {
        id: "session-1",
        title: "Recent work",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-07-27T10:11:12.000Z",
      },
    ]);
    const onResume = mock(() => {});
    const onOpenChange = mock(() => {});

    render(
      <OpenCodeResumeSessionDialog
        open
        onOpenChange={onOpenChange}
        client={CLIENT}
        onResume={onResume}
        currentSessionId="current-session"
      />,
    );

    expect(screen.getByTestId("resume-adapter").textContent).toBe("OpenCode");
    expect(capturedProps).toMatchObject({
      open: true,
      agentLabel: "OpenCode",
      currentSessionId: "current-session",
      onResume,
      onOpenChange,
    });
    await expect(capturedProps?.fetchSessions()).resolves.toEqual([
      {
        id: "session-1",
        title: "Recent work",
        activityAt: "2026-07-27T10:11:12.000Z",
      },
    ]);
    expect(listSessionsMock).toHaveBeenCalledWith(CLIENT);
  });

  test("propagates list failures so the shared dialog can show its error state", async () => {
    listSessionsMock.mockRejectedValue(new Error("OpenCode unavailable"));
    render(
      <OpenCodeResumeSessionDialog
        open
        onOpenChange={() => {}}
        client={CLIENT}
        onResume={() => {}}
      />,
    );

    await expect(capturedProps?.fetchSessions()).rejects.toThrow(
      "OpenCode unavailable",
    );
  });
});
