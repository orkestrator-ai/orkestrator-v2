import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import {
  RealmAgentInfoTrigger,
  RealmSystemUsageMeters,
  RealmTitleBarPanels,
  useRealmPanelDismiss,
} from "./RealmTitleBar";

const USAGE = {
  cpuPercent: 31,
  ramPercent: 73,
  gpuPercent: 0,
  diskPercent: 59,
  sampledAt: "2026-10-23T12:00:00.000Z",
};
const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();

afterEach(() => {
  cleanup();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  resetReadCoordinatorForTests();
});

describe("window: another node's title-bar controls", () => {
  function TitleBar({ nodeId, region }: { nodeId: string | null; region: HTMLElement }) {
    useRealmPanelDismiss(nodeId);
    return nodeId ? (
      <div>
        <RealmSystemUsageMeters nodeId={nodeId} region={region} />
        <RealmAgentInfoTrigger nodeId={nodeId} region={region} />
        <p>Elsewhere</p>
      </div>
    ) : null;
  }

  function region(): HTMLElement {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => ({ right: 1200 }) as DOMRect;
    return element;
  }

  beforeEach(() => {
    useRemoteWorkspaceStore.setState({
      realms: ["bk_a"],
      active: { nodeId: "bk_a", projectId: null, environmentId: null },
    });
  });

  test("shows what the realm reported and asks it for the popover under the trigger", () => {
    act(() =>
      useRemoteWorkspaceStore
        .getState()
        .noteRealmTitleBar("bk_a", { usage: USAGE, usageStale: false, panel: null }),
    );
    render(<TitleBar nodeId="bk_a" region={region()} />);
    expect(screen.getByRole("img", { name: /CPU\) usage: 31%/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Disk storage usage: 59%/ })).toBeTruthy();

    const meters = screen.getByRole("button", { name: "Open environment process usage" });
    meters.getBoundingClientRect = () => ({ right: 1100 }) as DOMRect;
    fireEvent.click(meters);
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a).toMatchObject({
      panel: "usage",
      open: true,
      inset: 100,
    });

    // The realm says it opened: the trigger shows it, and pressing it again closes.
    act(() =>
      useRemoteWorkspaceStore.getState().noteRealmTitleBar("bk_a", {
        usage: USAGE,
        usageStale: false,
        panel: "usage",
        requestSeq: useRemoteWorkspaceStore.getState().panelRequests.bk_a?.seq,
      }),
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Close environment process usage" }));
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a?.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close environment process usage" }));
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a).toMatchObject({
      panel: "usage",
      open: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open agent information" }));
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a).toMatchObject({
      panel: "agent",
      open: true,
    });
  });

  test("an open popover closes on Escape, a press elsewhere, or leaving the realm", () => {
    const anchor = region();
    act(() =>
      useRemoteWorkspaceStore
        .getState()
        .noteRealmTitleBar("bk_a", { usage: USAGE, usageStale: false, panel: "agent" }),
    );
    const { rerender } = render(<TitleBar nodeId="bk_a" region={anchor} />);
    expect(
      screen.getByRole("button", { name: "Close agent information" }).getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a).toMatchObject({
      panel: "agent",
      open: false,
    });

    act(() => useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "agent", true, 6));
    const seq = useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq;
    fireEvent.pointerDown(screen.getByText("Elsewhere"));
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq).toBeGreaterThan(seq);

    act(() => useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "agent", true, 6));
    const before = useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq;
    rerender(<TitleBar nodeId={null} region={anchor} />);
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq).toBeGreaterThan(before);
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a!.open).toBe(false);
  });

  test.each(["Escape", "outside", "switch"])("cancels an unacknowledged open on %s", (dismiss) => {
    const anchor = region();
    const { rerender } = render(<TitleBar nodeId="bk_a" region={anchor} />);
    const trigger = screen.getByRole("button", { name: "Open agent information" });
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Open environment process usage" })
        .hasAttribute("aria-controls"),
    ).toBe(false);
    fireEvent.click(trigger);
    const opening = useRemoteWorkspaceStore.getState().panelRequests.bk_a!;
    expect(
      screen.getByRole("button", { name: "Close agent information" }).getAttribute("aria-expanded"),
    ).toBe("true");
    if (dismiss === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (dismiss === "outside") fireEvent.pointerDown(screen.getByText("Elsewhere"));
    else rerender(<TitleBar nodeId={null} region={anchor} />);
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a).toMatchObject({
      panel: "agent",
      open: false,
    });
    act(() =>
      useRemoteWorkspaceStore.getState().noteRealmTitleBar("bk_a", {
        usage: USAGE,
        usageStale: false,
        panel: "agent",
        requestSeq: opening.seq,
      }),
    );
    // Even after the close is acknowledged, an older open report stays obsolete.
    const closing = useRemoteWorkspaceStore.getState().panelRequests.bk_a!;
    act(() => {
      useRemoteWorkspaceStore.getState().noteRealmTitleBar("bk_a", {
        usage: USAGE,
        usageStale: false,
        panel: null,
        requestSeq: closing.seq,
      });
      useRemoteWorkspaceStore.getState().noteRealmTitleBar("bk_a", {
        usage: USAGE,
        usageStale: false,
        panel: "agent",
        requestSeq: opening.seq,
      });
    });
    rerender(<TitleBar nodeId="bk_a" region={anchor} />);
    expect(
      screen.getByRole("button", { name: "Open agent information" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("a second press toggles a pending open closed", () => {
    render(<TitleBar nodeId="bk_a" region={region()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open environment process usage" }));
    fireEvent.click(screen.getByRole("button", { name: "Close environment process usage" }));
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a?.open).toBe(false);
  });

  test.each(["usage", "agent"] as const)(
    "returns focus to the %s trigger only on an explicit handoff",
    (panel) => {
      render(<TitleBar nodeId="bk_a" region={region()} />);
      const trigger = screen.getByRole("button", {
        name: panel === "agent" ? "Open agent information" : "Open environment process usage",
      });
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      outside.focus();
      act(() => useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", panel, false, 6));
      expect(document.activeElement).toBe(outside);
      act(() =>
        useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", panel, false, 6, true),
      );
      expect(document.activeElement).toBe(trigger);
      outside.remove();
    },
  );

  test("a realm that goes quiet shows its meters as unavailable", async () => {
    useRemoteWorkspaceStore.setState({
      titleBars: {
        bk_a: { usage: USAGE, usageStale: false, panel: null, receivedAt: Date.now() - 60_000 },
      },
    });
    render(<TitleBar nodeId="bk_a" region={region()} />);
    expect(await screen.findByRole("img", { name: /CPU\) usage: —/ })).toBeTruthy();
  });
});

describe("realm: the popovers of the window's title bar", () => {
  const originalOrkestrator = window.orkestrator;
  let posted: unknown[] = [];
  let deliver: (message: unknown) => void = () => undefined;

  beforeEach(() => {
    posted = [];
    installFakeReadCoordinator();
    (nativeInvoke as ReturnType<typeof mock>).mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return USAGE;
      if (command === "get_environment_process_usage")
        return { sampledAt: USAGE.sampledAt, environments: [], truncated: false };
      return undefined;
    });
    window.orkestrator = {
      ...originalOrkestrator,
      workspaceRealm: {
        post: (message: unknown) => posted.push(message),
        onMessage: (callback: (message: unknown) => void) => {
          deliver = callback;
          return () => {
            deliver = () => undefined;
          };
        },
      },
    } as typeof window.orkestrator;
  });

  afterEach(() => {
    window.orkestrator = originalOrkestrator;
  });

  test("real popovers apply requests, report state, focus controls and distinguish user dismissals", async () => {
    render(<RealmTitleBarPanels activeTab={null} />);
    await screen.findByTestId("realm-agent-info-panel");
    expect(screen.queryByRole("button", { name: "Open agent information" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Open environment process usage" }) === null).toBe(
      true,
    );
    for (const [panel, label] of [
      ["agent", "Agent information"],
      ["usage", "Environment process usage"],
    ] as const) {
      const seq = panel === "agent" ? 10 : 20;
      act(() => deliver({ type: "panel", panel, open: true, inset: 48, seq }));
      const dialog = screen.getByRole("dialog", { name: label });
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(posted).toContainEqual(
        expect.objectContaining({ type: "titleBar", panel, requestSeq: seq }),
      );
      expect(
        screen.getByTestId(
          panel === "agent" ? "realm-agent-info-panel" : "realm-system-usage-panel",
        ).parentElement?.style.right,
      ).toBe("48px");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: label }) === null).toBe(true);
      expect(posted).toContainEqual({ type: "panelDismissed", panel, seq });
      expect(posted).toContainEqual(
        expect.objectContaining({ type: "titleBar", panel: null, requestSeq: seq }),
      );
    }
    act(() => deliver({ type: "panel", panel: "agent", open: true, inset: 6, seq: 30 }));
    act(() => deliver({ type: "panel", panel: "usage", open: true, inset: 6, seq: 31 }));
    expect(screen.queryByRole("dialog", { name: "Agent information" }) === null).toBe(true);
    expect(
      screen
        .getByRole("dialog", { name: "Environment process usage" })
        .contains(document.activeElement),
    ).toBe(true);
    act(() => deliver({ type: "panel", panel: "usage", open: false, inset: 0, seq: 32 }));
    expect(
      posted.filter((message) => (message as { type: string }).type === "panelDismissed"),
    ).toHaveLength(2);
    expect(screen.getByTestId("realm-system-usage-panel").parentElement?.style.right).toBe("6px");
    act(() => deliver({ type: "panel", panel: "agent", open: true, inset: 6, seq: 40 }));
    // The usage open was superseded in the shell before it reached the realm.
    act(() => deliver({ type: "panel", panel: "usage", open: false, inset: 0, seq: 42 }));
    expect(screen.queryByRole("dialog") === null).toBe(true);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "titleBar", panel: null, requestSeq: 42 }),
    );
  });
});
