import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { frameEnvelope } from "@/lib/federation/workspace-realm";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import { FederationProvider } from "./FederationProvider";
import { RemoteWorkspaceRegion } from "./RemoteWorkspaceRegion";

const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
const originalReload = window.location.reload;
let reload = mock(() => undefined);

function install(desktop: boolean) {
  const fake = installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("working") },
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
  sessionStorage.clear();
  reload = mock(() => undefined);
  window.location.reload = reload;
});

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
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

    // The realm's own selection is what the sidebar shows as selected.
    act(() =>
      fake.emitViewEvent({
        viewId: "view-1",
        type: "message",
        message: { type: "selection", projectId: "project-1", environmentId: "env-3" },
      }),
    );
    expect(useRemoteWorkspaceStore.getState().active?.environmentId).toBe("env-3");

    // Back to this window's own workspace: the realm stays open, hidden.
    act(() => useRemoteWorkspaceStore.getState().showLocal());
    await waitFor(() =>
      expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-1", false),
    );
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

  test("a realm that fails offers to try again; one closed by the window is dropped", async () => {
    const fake = install(true);
    renderRegion(anchorElement());
    act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
    await waitFor(() => expect(fake.workspaceViews.setVisible).toHaveBeenCalled());
    act(() => fake.emitViewEvent({ viewId: "view-1", type: "crashed" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fake.workspaceViews.open).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(fake.workspaceViews.setVisible).toHaveBeenLastCalledWith("view-2", true),
    );
    act(() => fake.emitViewEvent({ viewId: "view-2", type: "closed" }));
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
    expect(useRemoteWorkspaceStore.getState().realms).toEqual([]);
  });
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

  // A dialog over the region: a still first, then the live view steps aside.
  const dialog = overlay("dialog", { left: 500, top: 200, width: 400 });
  act(() => void document.body.appendChild(dialog));
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
  expect(screen.queryByTestId("workspace-realm-still")).toBeNull();
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
