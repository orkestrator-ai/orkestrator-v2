import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { frameEnvelope } from "@/lib/federation/workspace-realm";
import { portalStore } from "@/lib/portal/portal-store";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import { FederationProvider } from "./FederationProvider";
import { RemoteWorkspaceRegion } from "./RemoteWorkspaceRegion";

const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
const INITIAL_UI = useUIStore.getState();
const INITIAL_MACHINE = useMachineViewStore.getState();
const originalReload = window.location.reload;
let reload = mock(() => undefined);

function install(
  desktop: boolean,
  respondPortal?: (command: string, args: Record<string, unknown>) => unknown,
) {
  const fake = installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("working") },
    respondPortal,
  });
  if (desktop) {
    window.orkestrator = { ...window.orkestrator!, isolatedViewState: true };
  } else {
    // A browser or iOS client: no desktop realms.
    delete (window.orkestrator as { workspaceViews?: unknown }).workspaceViews;
  }
  return fake;
}

function anchorElement(): HTMLDivElement {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ left: 300, top: 40, width: 900, height: 700, right: 1200, bottom: 740 }) as DOMRect;
  document.body.appendChild(anchor);
  return anchor;
}

function renderRegion(anchor: HTMLElement) {
  return render(
    <FederationProvider>
      <RemoteWorkspaceRegion anchor={anchor} />
    </FederationProvider>,
  );
}

beforeEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useUIStore.setState({ environmentSortMode: "project" });
  useMachineViewStore.setState({ grouping: "machine" });
  sessionStorage.clear();
  reload = mock(() => undefined);
  window.location.reload = reload;
});

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useUIStore.setState(INITIAL_UI, true);
  useMachineViewStore.setState(INITIAL_MACHINE, true);
  window.location.reload = originalReload;
  document.body.innerHTML = "";
});

describe("desktop: another machine's workspace in the central region", () => {
  test("opens a realm on what was clicked, places it over the region and never reloads", async () => {
    const fake = install(true);
    const anchor = anchorElement();
    renderRegion(anchor);
    act(() =>
      useRemoteWorkspaceStore
        .getState()
        .open("bk_a", { projectId: "project-1", environmentId: "env-1" }),
    );
    await waitFor(() => expect(fake.workspaceViews.open).toHaveBeenCalledTimes(1));
    expect(fake.workspaceViews.open).toHaveBeenCalledWith({
      nodeId: "bk_a",
      request: { projectId: "project-1", environmentId: "env-1" },
    });
    await waitFor(() =>
      expect(fake.workspaceViews.setBounds).toHaveBeenCalledWith("view-1", {
        x: 300,
        y: 40,
        width: 900,
        height: 700,
      }),
    );
    expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-1", true);

    // Another environment of the same machine: no new realm, a message once it listens.
    act(() =>
      useRemoteWorkspaceStore
        .getState()
        .open("bk_a", { projectId: "project-1", environmentId: "env-2" }),
    );
    expect(fake.workspaceViews.send).not.toHaveBeenCalled();
    act(() =>
      fake.emitViewEvent({ viewId: "view-1", type: "message", message: { type: "ready" } }),
    );
    await waitFor(() =>
      expect(fake.workspaceViews.send).toHaveBeenCalledWith("view-1", {
        type: "select",
        projectId: "project-1",
        environmentId: "env-2",
      }),
    );
    expect(fake.workspaceViews.open).toHaveBeenCalledTimes(1);

    // The realm's own selection updates the shell's recency and ends a search reveal.
    act(() =>
      useMachineViewStore
        .getState()
        .revealProject(projectKey(projectRef("bk_a" as BackendId, "project-1"))),
    );
    const localSelection = useUIStore.getState();
    act(() =>
      fake.emitViewEvent({
        viewId: "view-1",
        type: "message",
        message: { type: "selection", projectId: "project-1", environmentId: "env-3" },
      }),
    );
    expect(useRemoteWorkspaceStore.getState().active?.environmentId).toBe("env-3");
    expect(useMachineViewStore.getState().recentKeys.slice(0, 2)).toEqual([
      environmentKey(environmentRef("bk_a" as BackendId, "env-3")),
      projectKey(projectRef("bk_a" as BackendId, "project-1")),
    ]);
    expect(useMachineViewStore.getState().revealedProject).toBeNull();
    expect(useUIStore.getState()).toBe(localSelection);

    // Back to this window's own workspace: the realm stays open, hidden.
    act(() => useRemoteWorkspaceStore.getState().showLocal());
    await waitFor(() =>
      expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-1", false),
    );
    const recents = useMachineViewStore.getState().recentKeys;
    act(() =>
      fake.emitViewEvent({
        viewId: "view-1",
        type: "message",
        message: { type: "selection", projectId: "project-1", environmentId: "hidden" },
      }),
    );
    expect(useMachineViewStore.getState().recentKeys).toBe(recents);
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
    expect(fake.workspaceViews.close).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("the realm's toolbar toggles the window's sidebar, and settings open in the window", async () => {
    const fake = install(true);
    renderRegion(anchorElement());
    act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
    await waitFor(() => expect(fake.workspaceViews.open).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fake.workspaceViews.setVisible).toHaveBeenCalled());
    act(() =>
      fake.emitViewEvent({ viewId: "view-1", type: "message", message: { type: "ready" } }),
    );
    const open = useUIStore.getState().sidebarOpen;
    expect(fake.workspaceViews.send).toHaveBeenCalledWith("view-1", { type: "sidebar", open });
    const grouping = useMachineViewStore.getState().grouping;
    expect(fake.workspaceViews.send).toHaveBeenCalledWith("view-1", { type: "grouping", grouping });
    // A grouping change reaches the open realm.
    const next = grouping === "repository" ? "machine" : "repository";
    act(() => useMachineViewStore.getState().setGrouping(next));
    expect(fake.workspaceViews.send).toHaveBeenLastCalledWith("view-1", {
      type: "grouping",
      grouping: next,
    });
    act(() => useMachineViewStore.getState().setGrouping(grouping));
    act(() =>
      fake.emitViewEvent({
        viewId: "view-1",
        type: "message",
        message: { type: "sidebar", open: !open },
      }),
    );
    expect(useUIStore.getState().sidebarOpen).toBe(!open);
    act(() => useUIStore.setState({ sidebarOpen: open }));
  });

  test("the realm reports the title bar's meters, and the title bar opens its popovers", async () => {
    const fake = install(true);
    renderRegion(anchorElement());
    act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
    await waitFor(() => expect(fake.workspaceViews.setVisible).toHaveBeenCalled());

    // Asked before the realm listens: the latest request is replayed on ready.
    act(() => useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "agent", true, 6));
    act(() =>
      fake.emitViewEvent({ viewId: "view-1", type: "message", message: { type: "ready" } }),
    );
    expect(fake.workspaceViews.send).toHaveBeenCalledWith(
      "view-1",
      expect.objectContaining({ type: "panel", panel: "agent", open: true }),
    );

    const usage = {
      cpuPercent: 31,
      ramPercent: 73,
      gpuPercent: 0,
      diskPercent: 59,
      sampledAt: "2026-10-23T12:00:00.000Z",
    };
    act(() =>
      fake.emitViewEvent({
        viewId: "view-1",
        type: "message",
        message: { type: "titleBar", usage, usageStale: false, panel: null },
      }),
    );
    expect(useRemoteWorkspaceStore.getState().titleBars.bk_a).toMatchObject({
      usage,
      usageStale: false,
      panel: null,
    });

    act(() => useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "usage", true, 48));
    await waitFor(() =>
      expect(fake.workspaceViews.send).toHaveBeenCalledWith("view-1", {
        type: "panel",
        seq: useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq,
        panel: "usage",
        open: true,
        inset: 48,
      }),
    );

    // A closed realm takes what it reported with it.
    act(() => useRemoteWorkspaceStore.getState().closeRealm("bk_a"));
    expect(useRemoteWorkspaceStore.getState().titleBars.bk_a).toBeUndefined();
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a).toBeUndefined();
  });

  test.each([false, true])(
    "restart cancels panels (acknowledged: %s) and delivers requests made before replacement readiness",
    async (acknowledged) => {
      const fake = install(true);
      renderRegion(anchorElement());
      act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
      await waitFor(() => expect(fake.workspaceViews.setVisible).toHaveBeenCalled());
      act(() => {
        fake.emitViewEvent({ viewId: "view-1", type: "message", message: { type: "ready" } });
        fake.emitViewEvent({
          viewId: "view-1",
          type: "message",
          message: { type: "titleBar", panel: null },
        });
        useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "agent", true, 6);
      });
      const seq = useRemoteWorkspaceStore.getState().panelRequests.bk_a!.seq;
      if (acknowledged)
        act(() =>
          fake.emitViewEvent({
            viewId: "view-1",
            type: "message",
            message: {
              type: "titleBar",
              usage: null,
              usageStale: false,
              panel: "agent",
              requestSeq: seq,
            },
          }),
        );
      act(() => fake.emitViewEvent({ viewId: "view-1", type: "crashed" }));
      expect(useRemoteWorkspaceStore.getState().titleBars.bk_a?.panel).toBeNull();
      expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a?.open).toBe(false);
      // A new click on the failure screen belongs to the replacement document.
      act(() => useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "usage", true, 44));
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() =>
        expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-2", true),
      );
      expect(
        fake.workspaceViews.send.mock.calls.some(
          ([id, message]) => id === "view-2" && (message as { type: string }).type === "panel",
        ),
      ).toBe(false);
      act(() =>
        fake.emitViewEvent({ viewId: "view-2", type: "message", message: { type: "ready" } }),
      );
      expect(fake.workspaceViews.send).toHaveBeenCalledWith(
        "view-2",
        expect.objectContaining({ type: "panel", panel: "usage", open: true, inset: 44 }),
      );
    },
  );

  test("only a current visible panel's user dismissal requests return focus", async () => {
    const fake = install(true);
    renderRegion(anchorElement());
    act(() => useRemoteWorkspaceStore.getState().open("bk_a", {}));
    await waitFor(() => expect(fake.workspaceViews.setVisible).toHaveBeenCalled());
    const dismiss = (panel: "usage" | "agent", seq: number) =>
      fake.emitViewEvent({
        viewId: "view-1",
        type: "message",
        message: { type: "panelDismissed", panel, seq },
      });
    act(() => {
      fake.emitViewEvent({ viewId: "view-1", type: "message", message: { type: "ready" } });
      useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "agent", true, 6);
    });
    const old = useRemoteWorkspaceStore.getState().panelRequests.bk_a!;
    act(() => useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "usage", true, 6));
    const current = useRemoteWorkspaceStore.getState().panelRequests.bk_a!;
    act(() => dismiss("agent", old.seq));
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a).toBe(current);
    act(() => dismiss("usage", current.seq));
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a).toMatchObject({
      panel: "usage",
      open: false,
      restoreFocus: true,
    });
    act(() => useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "agent", true, 6));
    const hidden = useRemoteWorkspaceStore.getState().panelRequests.bk_a!;
    act(() => {
      useRemoteWorkspaceStore.getState().showLocal();
      dismiss("agent", hidden.seq);
    });
    expect(useRemoteWorkspaceStore.getState().panelRequests.bk_a).toBe(hidden);
  });

  test.each(["crashed", "load-failed"] as const)(
    "a %s realm closes before retry; one closed by the window is dropped",
    async (type) => {
      const fake = install(true);
      renderRegion(anchorElement());
      act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
      await waitFor(() => expect(fake.workspaceViews.setVisible).toHaveBeenCalled());
      act(() => fake.emitViewEvent({ viewId: "view-1", type }));
      expect(fake.workspaceViews.close).toHaveBeenCalledWith("view-1");
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => expect(fake.workspaceViews.open).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-2", true),
      );
      act(() => fake.emitViewEvent({ viewId: "view-2", type: "closed" }));
      expect(useRemoteWorkspaceStore.getState().active).toBeNull();
      expect(useRemoteWorkspaceStore.getState().realms).toEqual([]);
    },
  );
});

test("only this window's overlays that reach the region cover it, and they leave a still behind", async () => {
  const fake = install(true);
  renderRegion(anchorElement());
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
  await waitFor(() =>
    expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-1", true),
  );
  const overlay = (role: string, box: { left: number; top: number; width: number }) => {
    const element = document.createElement("div");
    element.setAttribute("role", role);
    element.setAttribute("data-state", "open");
    element.getBoundingClientRect = () =>
      ({ ...box, height: 200, right: box.left + box.width, bottom: box.top + 200 }) as DOMRect;
    return element;
  };

  // A sidebar menu that stays clear of the region (which starts at x=300).
  const menu = overlay("menu", { left: 20, top: 60, width: 200 });
  act(() => void document.body.appendChild(menu));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(fake.workspaceViews.capture).not.toHaveBeenCalled();
  expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-1", true);
  act(() => menu.remove());

  const captureTimeout = installControlledTimeout(250, { label: "realm still capture" });
  try {
    // A dialog must receive input even while its backdrop capture is pending.
    let resolveCapture!: (url: string | null) => void;
    fake.workspaceViews.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const dialog = overlay("dialog", { left: 500, top: 200, width: 400 });
    act(() => void document.body.appendChild(dialog));
    await waitFor(() =>
      expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-1", false),
    );
    expect(captureTimeout.pendingCount()).toBe(1);
    expect(screen.queryAllByTestId("workspace-realm-still")).toHaveLength(0);
    const clicked = mock(() => undefined);
    const control = document.createElement("button");
    control.onclick = clicked;
    dialog.appendChild(control);
    fireEvent.click(control);
    expect(clicked).toHaveBeenCalledTimes(1);
    await act(async () => resolveCapture("data:image/jpeg;base64,c3RpbGw="));
    const still = await screen.findByTestId("workspace-realm-still");
    expect(still.getAttribute("src")).toBe("data:image/jpeg;base64,c3RpbGw=");
    expect(fake.workspaceViews.capture).toHaveBeenCalledWith("view-1");
    await waitFor(() =>
      expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-1", false),
    );

    act(() => dialog.remove());
    await waitFor(() =>
      expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-1", true),
    );
    expect(screen.queryAllByTestId("workspace-realm-still")).toHaveLength(0);
    captureTimeout.assertDrained();
  } finally {
    captureTimeout.restore();
  }
});

test("a machine removed from the command node takes its realm with it", async () => {
  const fake = install(true);
  renderRegion(anchorElement());
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
  await waitFor(() => expect(fake.workspaceViews.open).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
  act(() => portalStore.store.setState({ nodes: [] }));
  await waitFor(() => expect(useRemoteWorkspaceStore.getState().realms).toEqual([]));
  expect(useRemoteWorkspaceStore.getState().active).toBeNull();
  await waitFor(() => expect(fake.workspaceViews.close).toHaveBeenCalledWith("view-1"));
});

describe("browser and iOS: a frame on a grant the window keeps", () => {
  test("the grant stays in the tab, never in the frame's URL, and is revoked with the frame", async () => {
    const fake = install(false);
    renderRegion(anchorElement());
    act(() =>
      useRemoteWorkspaceStore
        .getState()
        .open("bk_a", { projectId: "project-1", environmentId: "env-1" }),
    );
    const frame = (await screen.findByTitle(/^Workspace on /)) as HTMLIFrameElement;
    const src = new URL(frame.src);
    expect(src.searchParams.get("realm")).toBe("workspace");
    expect(src.searchParams.get("workspace")).toBe("workspace-1");
    expect(src.searchParams.get("environment")).toBe("env-1");
    expect(frame.src).not.toContain("okg_");
    const stored = JSON.parse(sessionStorage.getItem("orkestrator.workspace-realm:workspace-1")!);
    // No direct origin answered in this fixture: relayed through the command node.
    expect(stored.path).toBe("relay");
    expect(stored.baseUrl).toBe(`${window.location.origin}/__orkestrator/nodes/bk_a`);
    expect(stored.token).toBeUndefined();
    expect(sessionStorage.getItem("orkestrator.workspace-target")).toBeNull();

    // A message from the frame is accepted only from that frame, for its workspace.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: window,
          data: frameEnvelope("workspace-1", {
            type: "selection",
            projectId: "project-1",
            environmentId: "forged",
          }),
        }),
      );
    });
    expect(useRemoteWorkspaceStore.getState().active?.environmentId).toBe("env-1");

    act(() => useRemoteWorkspaceStore.getState().closeRealm("bk_a"));
    await waitFor(() =>
      expect(fake.invoke.mock.calls.some(([command]) => command === "close_node_workspace")).toBe(
        true,
      ),
    );
    expect(sessionStorage.getItem("orkestrator.workspace-realm:workspace-1")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(fake.calls.filter((call) => /^(stop|delete)_/.test(call.command))).toEqual([]);
  });
});

test("frame title-bar reports and sequenced panel requests use the current document envelope", async () => {
  install(false);
  renderRegion(anchorElement());
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", {}));
  const frame = (await screen.findByTitle(/^Workspace on /)) as HTMLIFrameElement;
  const post = mock(() => undefined);
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: { postMessage: post },
  });
  act(() => useRemoteWorkspaceStore.getState().requestRealmPanel("bk_a", "agent", true, 24));
  const request = useRemoteWorkspaceStore.getState().panelRequests.bk_a!;
  expect(post).not.toHaveBeenCalled();
  act(() => frameMessage(frame, "workspace-1", { type: "ready" }));
  expect(post).toHaveBeenCalledWith(
    frameEnvelope("workspace-1", { type: "panel", ...request }),
    window.location.origin,
  );
  act(() =>
    frameMessage(frame, "workspace-1", {
      type: "titleBar",
      usage: null,
      usageStale: true,
      panel: "agent",
      requestSeq: request.seq,
    }),
  );
  expect(useRemoteWorkspaceStore.getState().titleBars.bk_a).toMatchObject({
    panel: "agent",
    requestSeq: request.seq,
    usageStale: true,
  });
  act(() =>
    frameMessage(frame, "workspace-1", {
      type: "panelDismissed",
      panel: "agent",
      seq: request.seq,
    }),
  );
  expect(post).toHaveBeenLastCalledWith(
    frameEnvelope("workspace-1", {
      type: "panel",
      ...useRemoteWorkspaceStore.getState().panelRequests.bk_a,
    }),
    window.location.origin,
  );
});

function workspaceReply(id: string) {
  return {
    workspaceId: id,
    nodeId: "bk_a",
    nodeName: "Machine A",
    grant: { token: "fixture", expiresAt: Date.now() + 60_000 },
    directOrigins: [],
    relayBase: "/__orkestrator/nodes/bk_a",
  };
}

function frameMessage(frame: HTMLIFrameElement, workspaceId: string, message: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: frameEnvelope(workspaceId, message as never),
    }),
  );
}

function closedWorkspaces(fake: ReturnType<typeof install>) {
  return fake.invoke.mock.calls
    .filter(([command]) => command === "close_node_workspace")
    .map(([, args]) => (args as { workspaceId: string }).workspaceId);
}

for (const dialog of [{ addProject: true as const }, { createEnvironmentProjectId: "project-1" }]) {
  test(`grant recovery resumes current selection without replaying ${Object.keys(dialog)[0]}`, async () => {
    const fake = install(false, (command) => {
      if (command === "renew_node_workspace") return Promise.reject(new Error("expired"));
    });
    renderRegion(anchorElement());
    act(() =>
      useRemoteWorkspaceStore.getState().open("bk_a", {
        projectId: "project-1",
        environmentId: "env-1",
        ...dialog,
      }),
    );
    const frame = (await screen.findByTitle(/^Workspace on /)) as HTMLIFrameElement;
    expect(
      new URL(frame.src).searchParams.has(
        Object.keys(dialog)[0] === "addProject" ? "addProject" : "createEnvironment",
      ),
    ).toBe(true);
    act(() => {
      frameMessage(frame, "workspace-1", { type: "ready" });
      // The dialog was consumed by the old document; its selection later changed.
      frameMessage(frame, "workspace-1", {
        type: "selection",
        projectId: "project-1",
        environmentId: "env-3",
      });
      // Even a hidden realm must resume its own selection.
      useRemoteWorkspaceStore.getState().showLocal();
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() =>
      expect(new URL(frame.src).searchParams.get("workspace")).toBe("workspace-2"),
    );
    const params = new URL(frame.src).searchParams;
    expect(params.get("environment")).toBe("env-3");
    expect(params.has("addProject")).toBe(false);
    expect(params.has("createEnvironment")).toBe(false);
    expect(closedWorkspaces(fake)).toEqual(["workspace-1"]);
    expect(sessionStorage.getItem("orkestrator.workspace-realm:workspace-1")).toBeNull();
    expect(sessionStorage.getItem("orkestrator.workspace-realm:workspace-2") !== null).toBe(true);
  });
}

test("failed recovery keeps the previous frame and retries on reconnect without double opening", async () => {
  let recover = false;
  let resolveOpen!: (value: ReturnType<typeof workspaceReply>) => void;
  let failOpen = true;
  const fake = install(false, (command) => {
    if (command === "renew_node_workspace") return Promise.reject(new Error("expired"));
    if (command === "open_node_workspace" && recover) {
      if (failOpen) return Promise.reject(new Error("offline"));
      return new Promise((resolve) => {
        resolveOpen = resolve;
      });
    }
  });
  renderRegion(anchorElement());
  act(() =>
    useRemoteWorkspaceStore
      .getState()
      .open("bk_a", { projectId: "project-1", environmentId: "env-1" }),
  );
  const frame = (await screen.findByTitle(/^Workspace on /)) as HTMLIFrameElement;
  recover = true;
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() =>
    expect(fake.invoke.mock.calls.filter(([c]) => c === "open_node_workspace")).toHaveLength(2),
  );
  expect(new URL(frame.src).searchParams.get("workspace")).toBe("workspace-1");
  expect(closedWorkspaces(fake)).toHaveLength(0);
  failOpen = false;
  // Let the failed tick finish before the next connectivity event.
  await act(async () => {
    await Promise.resolve();
  });
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(typeof resolveOpen).toBe("function"));
  act(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    // A shell request arriving during replacement must be used by the new document.
    useRemoteWorkspaceStore
      .getState()
      .open("bk_a", { projectId: "project-1", environmentId: "env-2" });
  });
  await act(async () => resolveOpen(workspaceReply("replacement")));
  await waitFor(() => expect(new URL(frame.src).searchParams.get("workspace")).toBe("replacement"));
  expect(new URL(frame.src).searchParams.get("environment")).toBe("env-2");
  expect(fake.invoke.mock.calls.filter(([c]) => c === "open_node_workspace")).toHaveLength(3);
  expect(closedWorkspaces(fake)).toEqual(["workspace-1"]);
});

for (const recovery of [false, true]) {
  test(`a storage write failure revokes the new grant during ${recovery ? "recovery" : "initial open"}`, async () => {
    const fake = install(false, (command) => {
      if (command === "renew_node_workspace") return Promise.reject(new Error("expired"));
    });
    renderRegion(anchorElement());
    const originalSetItem = sessionStorage.setItem;
    const failStorage = () =>
      Object.defineProperty(sessionStorage, "setItem", {
        configurable: true,
        writable: true,
        value: mock(() => {
          throw new Error("storage full");
        }),
      });
    try {
      if (!recovery) failStorage();
      act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
      if (recovery) {
        const frame = (await screen.findByTitle(/^Workspace on /)) as HTMLIFrameElement;
        failStorage();
        act(() => window.dispatchEvent(new Event("online")));
        await waitFor(() => expect(closedWorkspaces(fake)).toEqual(["workspace-2"]));
        expect(new URL(frame.src).searchParams.get("workspace")).toBe("workspace-1");
        expect(sessionStorage.getItem("orkestrator.workspace-realm:workspace-1") !== null).toBe(
          true,
        );
      } else {
        await screen.findByText("Could not keep the workspace connection in this tab");
        expect(closedWorkspaces(fake)).toEqual(["workspace-1"]);
      }
    } finally {
      Object.defineProperty(sessionStorage, "setItem", {
        configurable: true,
        writable: true,
        value: originalSetItem,
      });
    }
  });
}

for (const recovery of [false, true]) {
  test(`a late ${recovery ? "replacement" : "initial"} open is revoked after the realm closes`, async () => {
    let defer = !recovery;
    let resolveOpen!: (value: ReturnType<typeof workspaceReply>) => void;
    const fake = install(false, (command) => {
      if (command === "renew_node_workspace") return Promise.reject(new Error("expired"));
      if (command === "open_node_workspace" && defer)
        return new Promise((resolve) => {
          resolveOpen = resolve;
        });
    });
    renderRegion(anchorElement());
    act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
    if (recovery) {
      await screen.findByTitle(/^Workspace on /);
      defer = true;
      act(() => window.dispatchEvent(new Event("online")));
    }
    await waitFor(() => expect(typeof resolveOpen).toBe("function"));
    act(() => useRemoteWorkspaceStore.getState().closeRealm("bk_a"));
    await act(async () => resolveOpen(workspaceReply("late")));
    await waitFor(() => expect(closedWorkspaces(fake)).toContain("late"));
    expect(sessionStorage.getItem("orkestrator.workspace-realm:late")).toBeNull();
    expect(screen.queryAllByTitle(/^Workspace on /)).toHaveLength(0);
    expect(closedWorkspaces(fake)).toHaveLength(recovery ? 2 : 1);
  });
}

test("successful renewal keeps the current frame and its grant", async () => {
  const fake = install(false);
  renderRegion(anchorElement());
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
  const frame = (await screen.findByTitle(/^Workspace on /)) as HTMLIFrameElement;
  const src = frame.src;
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() =>
    expect(fake.invoke.mock.calls.filter(([c]) => c === "renew_node_workspace")).toHaveLength(1),
  );
  expect(frame.src).toBe(src);
  expect(fake.invoke.mock.calls.filter(([c]) => c === "open_node_workspace")).toHaveLength(1);
  expect(closedWorkspaces(fake)).toHaveLength(0);
});

test("realms receive the latest effective grouping before readiness and after a document restart", async () => {
  const fake = install(true);
  renderRegion(anchorElement());
  act(() => {
    useMachineViewStore.getState().setGrouping("repository");
    useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" });
  });
  await waitFor(() => expect(fake.workspaceViews.setVisible).toHaveBeenCalled());
  act(() => useMachineViewStore.getState().setGrouping("project"));
  expect(fake.workspaceViews.send).not.toHaveBeenCalled();
  act(() => fake.emitViewEvent({ viewId: "view-1", type: "message", message: { type: "ready" } }));
  expect(fake.workspaceViews.send).toHaveBeenCalledWith("view-1", {
    type: "grouping",
    grouping: "project",
  });
  fake.workspaceViews.send.mockClear();
  act(() => fake.emitViewEvent({ viewId: "view-1", type: "crashed" }));
  act(() => {
    useMachineViewStore.getState().setGrouping("repository");
    useUIStore.setState({ environmentSortMode: "activity" });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-2", true),
  );
  expect(fake.workspaceViews.send).not.toHaveBeenCalled();
  act(() => fake.emitViewEvent({ viewId: "view-2", type: "message", message: { type: "ready" } }));
  expect(fake.workspaceViews.send).toHaveBeenCalledWith("view-2", {
    type: "grouping",
    grouping: "activity",
  });
  // Project sorting restores the saved grouping and activity sorting overrides it again.
  act(() => useUIStore.setState({ environmentSortMode: "project" }));
  expect(fake.workspaceViews.send).toHaveBeenLastCalledWith("view-2", {
    type: "grouping",
    grouping: "repository",
  });
  act(() => useUIStore.setState({ environmentSortMode: "activity" }));
  expect(fake.workspaceViews.send).toHaveBeenLastCalledWith("view-2", {
    type: "grouping",
    grouping: "activity",
  });
});

test("ready before the sender commits still delivers the current grouping", async () => {
  const fake = install(true);
  let resolveOpen!: (result: { viewId: string }) => void;
  fake.workspaceViews.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
  );
  renderRegion(anchorElement());
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", {}));
  await waitFor(() => expect(fake.workspaceViews.open).toHaveBeenCalled());
  await act(async () => {
    resolveOpen({ viewId: "view-early" });
    await Promise.resolve();
    fake.emitViewEvent({ viewId: "view-early", type: "message", message: { type: "ready" } });
    expect(fake.workspaceViews.send).not.toHaveBeenCalled();
  });
  expect(fake.workspaceViews.send).toHaveBeenCalledWith("view-early", {
    type: "grouping",
    grouping: "machine",
  });
});

test("browser grouping delivery uses the current workspace envelope and survives grant replacement", async () => {
  install(false, (command) => {
    if (command === "renew_node_workspace") throw new Error("workspace grant expired");
  });
  renderRegion(anchorElement());
  act(() => {
    useMachineViewStore.getState().setGrouping("repository");
    useRemoteWorkspaceStore.getState().open("bk_a", {});
  });
  const frame = (await screen.findByTitle(/^Workspace on /)) as HTMLIFrameElement;
  const post = mock(() => undefined);
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: { postMessage: post },
  });
  act(() => useUIStore.setState({ environmentSortMode: "activity" }));
  expect(post).not.toHaveBeenCalled();
  act(() => frameMessage(frame, "workspace-1", { type: "ready" }));
  expect(post).toHaveBeenCalledWith(
    frameEnvelope("workspace-1", { type: "grouping", grouping: "activity" }),
    window.location.origin,
  );
  act(() => useUIStore.setState({ environmentSortMode: "project" }));
  expect(post).toHaveBeenLastCalledWith(
    frameEnvelope("workspace-1", { type: "grouping", grouping: "repository" }),
    window.location.origin,
  );
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(new URL(frame.src).searchParams.get("workspace")).toBe("workspace-2"));
  post.mockClear();
  act(() => {
    useMachineViewStore.getState().setGrouping("project");
    frameMessage(frame, "workspace-1", { type: "ready" });
  });
  expect(post).not.toHaveBeenCalled();
  act(() => frameMessage(frame, "workspace-2", { type: "ready" }));
  expect(post).toHaveBeenCalledWith(
    frameEnvelope("workspace-2", { type: "grouping", grouping: "project" }),
    window.location.origin,
  );
});

test("a realm's command coordinator link selects that project and Coordinator in the window", async () => {
  install(false);
  renderRegion(anchorElement());
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "leaf-project" }));
  const frame = (await screen.findByTitle(/^Workspace on /)) as HTMLIFrameElement;
  const commandId = portalStore.getState().selfId!;
  act(() => {
    useUIStore.setState({ projectBoardTab: "kanban" });
    frameMessage(frame, "workspace-1", {
      type: "open",
      nodeId: commandId,
      projectId: "command-project",
      boardTab: "coordinator",
      title: "app",
    });
  });
  expect(useRemoteWorkspaceStore.getState().active).toBeNull();
  expect(useUIStore.getState().selectedProjectId).toBe("command-project");
  expect(useUIStore.getState().projectBoardTab).toBe("coordinator");
});
