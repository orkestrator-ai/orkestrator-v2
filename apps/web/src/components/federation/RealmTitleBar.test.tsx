import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as realAgentInfoButton from "@/components/layout/AgentInfoButton";
import * as realSystemUsageIndicator from "@/components/layout/SystemUsageIndicator";
import * as realUseSystemUsage from "@/hooks/useSystemUsage";
import type { RealmPanelControl } from "@/lib/federation/workspace-realm";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

const realAgentInfoButtonSnapshot = { ...realAgentInfoButton };
const realSystemUsageIndicatorSnapshot = { ...realSystemUsageIndicator };
const realUseSystemUsageSnapshot = { ...realUseSystemUsage };

const USAGE = {
  cpuPercent: 31,
  ramPercent: 73,
  gpuPercent: 0,
  diskPercent: 59,
  sampledAt: "2026-10-23T12:00:00.000Z",
};
let usageView = {
  sample: USAGE as typeof USAGE | null,
  sampledAt: USAGE.sampledAt as string | null,
  observedAt: 0 as number | null,
  stale: false,
};

// The popovers' own behaviour has its own suites; here they only show what
// the title bar asked of them and report back.
function PanelStub({ name, remote }: { name: string; remote?: RealmPanelControl }) {
  return (
    <div
      data-testid={`${name}-panel`}
      data-request={remote?.request ? JSON.stringify(remote.request) : "none"}
    >
      <button type="button" onClick={() => remote?.onOpenChange(true)}>
        {`${name} opened`}
      </button>
      <button type="button" onClick={() => remote?.onOpenChange(false)}>
        {`${name} closed`}
      </button>
    </div>
  );
}

mock.module("@/components/layout/AgentInfoButton", () => ({
  ...realAgentInfoButtonSnapshot,
  AgentInfoButton: ({ remote }: { remote?: RealmPanelControl }) => (
    <PanelStub name="agent" remote={remote} />
  ),
}));
mock.module("@/components/layout/SystemUsageIndicator", () => ({
  ...realSystemUsageIndicatorSnapshot,
  SystemUsageIndicator: ({ remote }: { remote?: RealmPanelControl }) => (
    <PanelStub name="usage" remote={remote} />
  ),
}));
mock.module("@/hooks/useSystemUsage", () => ({
  ...realUseSystemUsageSnapshot,
  useSystemUsage: () => usageView,
}));

const { RealmAgentInfoTrigger, RealmSystemUsageMeters, RealmTitleBarPanels, useRealmPanelDismiss } =
  await import("./RealmTitleBar");

afterAll(() => {
  mock.module("@/components/layout/AgentInfoButton", () => realAgentInfoButtonSnapshot);
  mock.module("@/components/layout/SystemUsageIndicator", () => realSystemUsageIndicatorSnapshot);
  mock.module("@/hooks/useSystemUsage", () => realUseSystemUsageSnapshot);
});

const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();

afterEach(() => {
  cleanup();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
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
    useRemoteWorkspaceStore.setState({ realms: ["bk_a"] });
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
      useRemoteWorkspaceStore
        .getState()
        .noteRealmTitleBar("bk_a", { usage: USAGE, usageStale: false, panel: "usage" }),
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

    const seq = useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq;
    fireEvent.pointerDown(screen.getByText("Elsewhere"));
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq).toBeGreaterThan(seq);

    const before = useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq;
    rerender(<TitleBar nodeId={null} region={anchor} />);
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq).toBeGreaterThan(before);
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a!.open).toBe(false);
  });

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
    usageView = { sample: USAGE, sampledAt: USAGE.sampledAt, observedAt: 0, stale: false };
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

  test("reports the meters and open popover, and opens what the title bar asks for", () => {
    render(<RealmTitleBarPanels activeTab={null} />);
    expect(posted.at(-1)).toEqual({
      type: "titleBar",
      usage: USAGE,
      usageStale: false,
      panel: null,
    });

    act(() => deliver({ type: "panel", panel: "agent", open: true, inset: 6 }));
    const agentRequest = JSON.parse(
      screen.getByTestId("agent-panel").getAttribute("data-request")!,
    );
    expect(agentRequest).toMatchObject({ open: true, inset: 6 });
    expect(screen.getByTestId("agent-panel").parentElement?.style.right).toBe("6px");
    // One popover at a time.
    expect(
      JSON.parse(screen.getByTestId("usage-panel").getAttribute("data-request")!),
    ).toMatchObject({ open: false });

    fireEvent.click(screen.getByRole("button", { name: "agent opened" }));
    expect(posted.at(-1)).toMatchObject({ type: "titleBar", panel: "agent" });

    // Closed from the title bar: it stays where it opened while it fades.
    act(() => deliver({ type: "panel", panel: "agent", open: false, inset: 0 }));
    expect(
      JSON.parse(screen.getByTestId("agent-panel").getAttribute("data-request")!),
    ).toMatchObject({ open: false, inset: 6 });
    fireEvent.click(screen.getByRole("button", { name: "agent closed" }));
    expect(posted.at(-1)).toMatchObject({ type: "titleBar", panel: null });
  });
});
