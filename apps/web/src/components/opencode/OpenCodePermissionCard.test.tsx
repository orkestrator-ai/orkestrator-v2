import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import type {
  OpencodeClient,
  PermissionReply,
  PermissionRequest,
} from "@/lib/opencode-client";

import * as realOpenCodeClient from "@/lib/opencode-client";
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };

const replyMock = mock(
  async (
    _client: OpencodeClient,
    _requestId: string,
    _reply: PermissionReply,
  ) => true,
);

mock.module("@/lib/opencode-client", () => ({
  ...realOpenCodeClientSnapshot,
  replyToPermission: replyMock,
}));

afterAll(() => {
  mock.module("@/lib/opencode-client", () => realOpenCodeClientSnapshot);
});

const { OpenCodePermissionCard } = await import("./OpenCodePermissionCard");

const CLIENT = {
  baseUrl: "http://127.0.0.1:9999",
} as unknown as OpencodeClient;

function makePermission(
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    id: "permission-1",
    sessionId: "session-1",
    permission: "edit",
    patterns: ["/workspace/src/**", "/workspace/package.json"],
    metadata: { tool: "edit" },
    always: ["/workspace/src/**"],
    ...overrides,
  };
}

beforeEach(() => {
  replyMock.mockReset();
  replyMock.mockResolvedValue(true);
  mockToastError.mockClear();
  useOpenCodeStore.setState({
    pendingPermissions: new Map(),
  });
});

afterEach(cleanup);

describe("OpenCodePermissionCard", () => {
  test("renders the permission and requested paths, with persistent approval when supported", () => {
    render(
      <OpenCodePermissionCard
        permission={makePermission()}
        client={CLIENT}
      />,
    );

    expect(screen.getByText("edit")).toBeTruthy();
    expect(screen.getByText("/workspace/src/**")).toBeTruthy();
    expect(screen.getByText("/workspace/package.json")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always Allow" })).toBeTruthy();
  });

  test("hides persistent approval when the server provides no reusable patterns", () => {
    render(
      <OpenCodePermissionCard
        permission={makePermission({ always: [] })}
        client={CLIENT}
      />,
    );

    expect(screen.queryByRole("button", { name: "Always Allow" })).toBeNull();
  });

  test("omits the requested paths block when the server sends no patterns", () => {
    render(
      <OpenCodePermissionCard
        permission={makePermission({ patterns: [] })}
        client={CLIENT}
      />,
    );

    expect(screen.queryByText("Requested paths")).toBeNull();
    expect(screen.queryByText("/workspace/src/**")).toBeNull();
    // The permission itself still renders, and `always` is independent of
    // `patterns`, so persistent approval stays available.
    expect(screen.getByText("edit")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always Allow" })).toBeTruthy();
  });

  test.each([
    ["Reject", "reject"],
    ["Allow Once", "once"],
    ["Always Allow", "always"],
  ] as const)("%s maps to the %s protocol reply", async (label, reply) => {
    const permission = makePermission();
    useOpenCodeStore.getState().addPendingPermission(permission);
    render(
      <OpenCodePermissionCard permission={permission} client={CLIENT} />,
    );

    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() => {
      expect(replyMock).toHaveBeenCalledWith(CLIENT, permission.id, reply);
      expect(
        useOpenCodeStore.getState().getPendingPermission(permission.id),
      ).toBeUndefined();
    });
  });

  test("keeps the permission, unlocks all decisions, and toasts after a failed reply", async () => {
    const originalError = console.error;
    console.error = mock(() => {});
    try {
      replyMock.mockResolvedValue(false);
      const permission = makePermission();
      useOpenCodeStore.getState().addPendingPermission(permission);
      render(
        <OpenCodePermissionCard permission={permission} client={CLIENT} />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Allow Once" }));
      });

      expect(
        useOpenCodeStore.getState().getPendingPermission(permission.id),
      ).toBeTruthy();
      for (const label of ["Reject", "Allow Once", "Always Allow"]) {
        expect(
          screen.getByRole("button", { name: label }).hasAttribute("disabled"),
        ).toBe(false);
      }
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to send permission decision",
        { description: "OpenCode is still waiting for a decision. Please try again." },
      );
    } finally {
      console.error = originalError;
    }
  });

  test("locks every decision and ignores a second click while submitting", async () => {
    let resolveReply!: (value: boolean) => void;
    replyMock.mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveReply = resolve;
      }),
    );
    render(
      <OpenCodePermissionCard
        permission={makePermission()}
        client={CLIENT}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("button", { name: "Always Allow" }).hasAttribute("disabled")).toBe(
        true,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Always Allow" }));
    expect(replyMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReply(true);
    });
  });

  test("blocks retry after an unreconciled thrown reply error", async () => {
    const originalError = console.error;
    console.error = mock(() => {});
    try {
      replyMock.mockRejectedValue(new Error("transport exploded"));
      const permission = makePermission();
      useOpenCodeStore.getState().addPendingPermission(permission);
      render(
        <OpenCodePermissionCard permission={permission} client={CLIENT} />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Reject" }));
      });

      expect(
        useOpenCodeStore.getState().getPendingPermission(permission.id),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Reject" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to send permission decision",
        { description: "transport exploded" },
      );
    } finally {
      console.error = originalError;
    }
  });

  test("does not toast when a reply succeeds", async () => {
    const permission = makePermission();
    useOpenCodeStore.getState().addPendingPermission(permission);
    render(
      <OpenCodePermissionCard permission={permission} client={CLIENT} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Allow Once" }));
    });

    expect(mockToastError).not.toHaveBeenCalled();
  });
});
