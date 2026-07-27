/**
 * The card is the only thing standing between "Codex asked" and "Codex ran it",
 * so these tests focus on the safety-relevant behaviour: which decision each
 * button actually sends, that a card which can no longer act disappears, and that
 * a transport failure keeps the card so the user can retry.
 */
import { createSessionKey } from "@/lib/utils";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {useCodexStore} from "@/stores/codexStore";
import type { CodexApproval, CodexApprovalResponseResult } from "@/lib/codex-client";

/**
 * Snapshot the real module first, then override a single export.
 *
 * `codex-client` is imported by the store and by most Codex suites, so replacing
 * the whole module would hand them a stub missing `CODEX_MODELS` and friends. The
 * spread keeps every other export real, and the `afterAll` restore puts the
 * genuine `respondToApproval` back for files that run after this one.
 */
import * as realCodexClient from "@/lib/codex-client";
const realCodexClientSnapshot = { ...realCodexClient };

const respondMock = mock(
  async (): Promise<CodexApprovalResponseResult> => "applied",
);

mock.module("@/lib/codex-client", () => ({
  ...realCodexClientSnapshot,
  respondToApproval: respondMock,
}));

afterAll(() => {
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
});

const { CodexApprovalCard } = await import("./CodexApprovalCard");

const SESSION_KEY = createSessionKey("env-1", "tab-1");
const CLIENT = { baseUrl: "http://127.0.0.1:4000" };

function makeApproval(overrides: Partial<CodexApproval> = {}): CodexApproval {
  return {
    approvalId: "apr-1-1",
    kind: "command",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: Date.now(),
    // Comfortably in the future so the countdown does not read as expired.
    expiresAt: Date.now() + 300_000,
    command: "rm -rf build",
    actionable: true,
    supportsApproveForSession: true,
    ...overrides,
  };
}

function renderCard(approval: CodexApproval) {
  return render(
    <CodexApprovalCard
      approval={approval}
      client={CLIENT}
      sessionId="session-1"
      sessionKey={SESSION_KEY}
    />,
  );
}

beforeEach(() => {
  respondMock.mockClear();
  respondMock.mockImplementation(async () => "applied");
  useCodexStore.setState({ pendingApprovals: new Map() });
  useCodexStore.getState().addPendingApproval(SESSION_KEY, makeApproval());
});

afterEach(cleanup);

describe("CodexApprovalCard", () => {
  test("shows the command and the working directory", () => {
    renderCard(makeApproval({ cwd: "/workspace/app" }));

    expect(screen.getByText("Codex wants to run a command")).toBeTruthy();
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.getByText("in /workspace/app")).toBeTruthy();
  });

  test("shows app-server's own reason when it gives one", () => {
    renderCard(makeApproval({ reason: "needs network access" }));
    expect(screen.getByText("needs network access")).toBeTruthy();
  });

  test("names the host for a network approval", () => {
    renderCard(makeApproval({ networkHost: "registry.npmjs.org" }));
    expect(screen.getByText("Codex wants to reach registry.npmjs.org")).toBeTruthy();
  });

  test("lists file changes with their kind", () => {
    renderCard(
      makeApproval({
        kind: "file-change",
        command: undefined,
        changes: [
          { path: "/workspace/a.ts", kind: "update" },
          { path: "/workspace/b.ts", kind: "add" },
        ],
      }),
    );

    expect(screen.getByText("Codex wants to change files")).toBeTruthy();
    expect(screen.getByText("/workspace/a.ts")).toBeTruthy();
    expect(screen.getByText("add")).toBeTruthy();
  });

  test("lists the permission classes being requested", () => {
    renderCard(
      makeApproval({
        kind: "permissions",
        command: undefined,
        permissions: { network: true, fileSystem: false },
      }),
    );

    expect(screen.getByText("Codex wants additional permissions")).toBeTruthy();
    expect(screen.getByText("Network access")).toBeTruthy();
    expect(screen.queryByText("Filesystem access beyond the workspace")).toBeNull();
  });

  test("shows a filesystem-only permission request", () => {
    renderCard(
      makeApproval({
        kind: "permissions",
        command: undefined,
        permissions: { network: false, fileSystem: true },
      }),
    );

    expect(screen.getByText("Filesystem access beyond the workspace")).toBeTruthy();
    expect(screen.queryByText("Network access")).toBeNull();
  });

  test("orders denial first and makes it the only primary action", () => {
    renderCard(makeApproval());

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Decline",
      "Cancel turn",
      "Approve for session",
      "Approve",
    ]);
    expect(screen.getByRole("button", { name: "Decline" }).dataset.variant).toBe("default");
    expect(screen.getByRole("button", { name: "Approve" }).dataset.variant).toBe("outline");
    // "Approve for session" is the far broader grant, so it must not look like an
    // equal-weight sibling of the one-off approval sitting next to it.
    expect(screen.getByRole("button", { name: "Approve for session" }).dataset.variant).toBe(
      "ghost",
    );
  });

  test.each([
    ["Approve", "approve"],
    ["Approve for session", "approve-for-session"],
    ["Decline", "deny"],
    ["Cancel turn", "cancel"],
  ])("%s sends the %s decision", async (label, expected) => {
    renderCard(makeApproval());
    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() => expect(respondMock).toHaveBeenCalledTimes(1));
    // `mock(async () => …)` infers a zero-arg signature, so widen before reading.
    expect(respondMock.mock.calls[0] as unknown as unknown[]).toEqual([
      CLIENT,
      "session-1",
      "apr-1-1",
      expected,
    ]);
  });

  test("hides approve-for-session when the method does not support it", () => {
    renderCard(makeApproval({ supportsApproveForSession: false }));
    expect(screen.queryByRole("button", { name: "Approve for session" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  test("fails closed when the bridge cannot resolve actionable details", () => {
    renderCard(makeApproval({ actionable: false }));

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve for session" })).toBeNull();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel turn" })).toBeTruthy();
    expect(screen.getByText(/does not include enough detail to approve safely/)).toBeTruthy();
  });

  test("permission cancellation aborts the turn through the cancel decision", async () => {
    renderCard(makeApproval({
      kind: "permissions",
      command: undefined,
      permissions: undefined,
      actionable: false,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel turn" }));
    await waitFor(() => expect(respondMock).toHaveBeenCalledTimes(1));
    expect((respondMock.mock.calls[0] as unknown as unknown[])[3]).toBe("cancel");
  });

  test("removes the approval from the store once applied", async () => {
    renderCard(makeApproval());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false),
    );
  });

  test("removes the card when the bridge says the request is stale", async () => {
    // The five-minute window closed, or the child restarted. Leaving the card up
    // would invite the user to click something that can never take effect.
    respondMock.mockImplementation(async () => "stale");
    renderCard(makeApproval());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false),
    );
  });

  test("removes the card when the bridge rejects the session", async () => {
    respondMock.mockImplementation(async () => "forbidden");
    renderCard(makeApproval());
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() =>
      expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false),
    );
  });

  test("keeps the card and offers a retry on a transport error", async () => {
    respondMock.mockImplementation(async () => "error");
    renderCard(makeApproval());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // Only a transport failure is retryable, so the approval must survive.
    expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(true);
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false);
  });

  test("a second click while in flight does not send twice", async () => {
    let release: ((value: CodexApprovalResponseResult) => void) | undefined;
    respondMock.mockImplementation(
      () => new Promise<CodexApprovalResponseResult>((resolve) => {
        release = resolve;
      }),
    );

    renderCard(makeApproval());
    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approving…" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approving…" }));

    expect(respondMock).toHaveBeenCalledTimes(1);
    release?.("applied");
  });

  test("an expired approval shows no buttons", () => {
    renderCard(makeApproval({ expiresAt: Date.now() - 1_000 }));

    // The bridge has already auto-denied by this point; offering buttons would be
    // a lie.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("This request expired and was declined.")).toBeTruthy();
  });

  test("removes the actions when a live countdown expires", async () => {
    renderCard(makeApproval({ expiresAt: Date.now() + 25 }));
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();

    await waitFor(
      () => {
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
        expect(screen.getByText("This request expired and was declined.")).toBeTruthy();
      },
      // The countdown ticks on a real one-second interval, so this needs room for
      // more than one tick: under a loaded parallel run a 1.5s budget can expire
      // between ticks and fail a card that does expire correctly.
      { timeout: 5_000 },
    );
  });

  test("mentions the requested grant root when there is one", () => {
    renderCard(makeApproval({ grantRoot: "/workspace" }));
    expect(screen.getByText(/write access under/)).toBeTruthy();
    expect(screen.getByText("/workspace")).toBeTruthy();
  });

  test("fails closed on an approval with no readable deadline", () => {
    // A descriptor the bridge could not fully describe used to render "NaN:NaN"
    // beside live Approve/Decline buttons. This card is what actually runs the
    // command, so an unreadable request must offer nothing to click.
    renderCard(makeApproval({ expiresAt: undefined as unknown as number }));

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.getByText("This request expired and was declined.")).toBeTruthy();
  });

  test("a different button cannot be used while a decision is in flight", async () => {
    // The safety-critical variant of double submission: declining and then
    // approving the same request would send two contradictory answers.
    let release: ((value: CodexApprovalResponseResult) => void) | undefined;
    respondMock.mockImplementation(
      () => new Promise<CodexApprovalResponseResult>((resolve) => {
        release = resolve;
      }),
    );

    renderCard(makeApproval());
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Declining…" })).toBeTruthy());

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve.hasAttribute("disabled")).toBe(true);
    fireEvent.click(approve);

    expect(respondMock).toHaveBeenCalledTimes(1);
    expect((respondMock.mock.calls[0] as unknown as unknown[])[3]).toBe("deny");
    release?.("applied");
  });

  test.each([
    ["Decline", "Declining…"],
    ["Cancel turn", "Cancelling…"],
    ["Approve for session", "Approving…"],
  ])("%s shows its own in-flight label", async (label, inFlightLabel) => {
    let release: ((value: CodexApprovalResponseResult) => void) | undefined;
    respondMock.mockImplementation(
      () => new Promise<CodexApprovalResponseResult>((resolve) => {
        release = resolve;
      }),
    );

    renderCard(makeApproval());
    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() => expect(screen.getByRole("button", { name: inFlightLabel })).toBeTruthy());
    release?.("applied");
  });

  test("a retry after a transport error sends the decision again and clears the card", async () => {
    respondMock
      .mockImplementationOnce(async () => "error")
      .mockImplementation(async () => "applied");

    renderCard(makeApproval());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    // The whole point of keeping the card is that the second attempt works.
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(respondMock).toHaveBeenCalledTimes(2);
      expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
    });
  });

  test("counts down in m:ss", () => {
    renderCard(makeApproval({ expiresAt: Date.now() + 65_000 }));
    expect(screen.getByText("1:05")).toBeTruthy();

    cleanup();
    renderCard(makeApproval({ expiresAt: Date.now() + 1_000 }));
    expect(screen.getByText("0:01")).toBeTruthy();
  });

  test("clears the countdown interval when the card unmounts", () => {
    const originalClearInterval = globalThis.clearInterval;
    let cleared = 0;
    globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
      cleared += 1;
      originalClearInterval(handle);
    }) as typeof clearInterval;

    try {
      // A card that outlives its interval keeps ticking for every approval the
      // user has ever seen.
      renderCard(makeApproval()).unmount();
      expect(cleared).toBeGreaterThan(0);
    } finally {
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test.each([
    [{ kind: "permissions" as const }, "shield-alert"],
    [{ kind: "file-change" as const }, "file-diff"],
    [{ networkHost: "registry.npmjs.org" }, "globe"],
    [{}, "terminal"],
  ])("picks the icon that matches the request", (overrides, expectedIcon) => {
    const { container } = renderCard(makeApproval(overrides));
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(expectedIcon);
  });
});
