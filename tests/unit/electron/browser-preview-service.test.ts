import { EventEmitter } from "node:events";
import { describe, expect, mock, test } from "bun:test";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

import type { BrowserPreviewServiceTarget } from "@orkestrator/protocol/browser-preview";

import {
  BrowserPreviewManager,
  type BrowserPreviewServiceTransport,
} from "../../../apps/desktop/electron/browser-preview-manager";

class FakeContents extends EventEmitter {
  url = "";
  destroyed = false;
  readonly loadURL = mock(async (url: string) => {
    this.url = url;
  });
  readonly reload = mock(() => undefined);
  readonly setWindowOpenHandler = mock(() => undefined);
  readonly close = mock(() => {
    this.destroyed = true;
  });
  readonly session = { addWordToSpellCheckerDictionary: () => true };
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    getActiveIndex: () => 0,
    getEntryAtIndex: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
  };
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return this.destroyed;
  }
}

function harness() {
  const views: Array<{
    options: { webPreferences: { session: unknown } };
    webContents: FakeContents;
  }> = [];
  class FakeView {
    readonly webContents = new FakeContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = false;
    setBackgroundColor() {}
    setBounds(bounds: typeof this.bounds) {
      this.bounds = bounds;
    }
    getBounds() {
      return this.bounds;
    }
    setVisible(visible: boolean) {
      this.visible = visible;
    }
    getVisible() {
      return this.visible;
    }
    constructor(readonly options: { webPreferences: { session: unknown } }) {
      views.push(this);
    }
  }
  const origins: Record<string, string> = {
    svc_aaaaaaaa: "http://127.0.0.1:41001",
    svc_bbbbbbbb: "http://127.0.0.1:41002",
  };
  const held = new Map<string, Set<string>>();
  // While `holdAcquires` is set, acquisitions wait until the test releases them.
  const gates: Array<{ serviceId: string; open: () => void }> = [];
  const control = { holdAcquires: false };
  const transport: BrowserPreviewServiceTransport = {
    acquire: mock(async (target: BrowserPreviewServiceTarget, holder: string) => {
      const key = `bk_backend_1:${target.serviceId}`;
      (held.get(key) ?? held.set(key, new Set()).get(key)!).add(holder);
      if (control.holdAcquires) {
        await new Promise<void>((open) => gates.push({ serviceId: target.serviceId, open }));
      }
      return {
        serviceKey: key,
        partition: `persist:svc-${target.serviceId}`,
        url: `${origins[target.serviceId]}${target.path}`,
      };
    }),
    release: mock((key: string, holder: string) => {
      held.get(key)?.delete(holder);
    }),
    scopeFor: (url) => {
      const entry = Object.entries(origins).find(
        ([, origin]) => url.startsWith(`${origin}/`) || url === origin,
      );
      return entry ? `service:bk_backend_1:${entry[0]}` : null;
    },
    describe: (url) => {
      const entry = Object.entries(origins).find(([, origin]) => url.startsWith(`${origin}/`));
      if (!entry) return null;
      const path = url.slice(entry[1].length);
      return {
        serviceKey: `bk_backend_1:${entry[0]}`,
        serviceId: entry[0],
        path,
        displayUrl: `http://localhost:3000${path}`,
      };
    },
    target: (key) => ({
      backendInstanceId: "bk_backend_1",
      environmentId: "env",
      serviceId: key.split(":")[1]!,
    }),
    transportState: () => ({ mode: "desktop-tunnel", state: "ready" }),
    sessionFor: (partition) => ({ partition }) as never,
    resetSiteData: mock(async () => undefined),
  };
  const emitState = mock(() => undefined);
  const emitOpenLink = mock(() => undefined);
  const openExternal = mock(() => undefined);
  const menuTemplates: MenuItemConstructorOptions[][] = [];
  const openServiceExternally = mock(async (_target: BrowserPreviewServiceTarget) => undefined);
  const manager = new BrowserPreviewManager({
    WebContentsViewCtor: FakeView as never,
    browserSession: { partition: "legacy" } as never,
    menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => (
        menuTemplates.push(template),
        { popup: () => undefined }
      ),
    } as never,
    getWindow: () =>
      ({
        isDestroyed: () => false,
        contentView: { addChildView: () => undefined, removeChildView: () => undefined },
        webContents: { getZoomFactor: () => 1 },
      }) as never,
    emitState,
    emitOpenLink,
    openExternal,
    writeClipboardText: () => undefined,
    focusAddressBar: () => undefined,
    transport,
    openServiceExternally,
  });
  return {
    manager,
    views,
    transport,
    held,
    gates,
    control,
    emitState,
    emitOpenLink,
    openExternal,
    openServiceExternally,
    menuTemplates,
  };
}

function linkParams(linkURL: string): ContextMenuParams {
  return {
    x: 1,
    y: 1,
    linkURL,
    selectionText: "",
    isEditable: false,
    misspelledWord: "",
    dictionarySuggestions: [],
    mediaType: "none",
    hasImageContents: false,
    srcURL: "",
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
  } as unknown as ContextMenuParams;
}

const bounds = { x: 0, y: 0, width: 100, height: 100 };
const service = (serviceId: string, path = "/"): BrowserPreviewServiceTarget => ({
  backendInstanceId: "bk_backend_1",
  environmentId: "env",
  serviceId,
  path,
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("service previews in BrowserPreviewManager", () => {
  test("uses the service partition and reports identity, not the transport URL", async () => {
    const { manager, views } = harness();
    const state = await manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa", "/app?x=1"),
      bounds,
      visible: true,
    });
    expect(views[0]!.options.webPreferences.session).toEqual({
      partition: "persist:svc-svc_aaaaaaaa",
    });
    expect(views[0]!.webContents.loadURL).toHaveBeenCalledWith("http://127.0.0.1:41001/app?x=1");
    expect(state.service).toEqual({
      serviceId: "svc_aaaaaaaa",
      path: "/app?x=1",
      displayUrl: "http://localhost:3000/app?x=1",
    });
    expect(state.transport).toEqual({ mode: "desktop-tunnel", state: "ready" });
  });

  test("re-attaching with the current path does not reload; a new path navigates", async () => {
    const { manager, views } = harness();
    await manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa", "/a"),
      bounds,
      visible: true,
    });
    await manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa", "/a"),
      bounds,
      visible: false,
    });
    expect(views[0]!.webContents.loadURL).toHaveBeenCalledTimes(1);
    await manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa", "/b"),
      bounds,
      visible: true,
    });
    expect(views[0]!.webContents.loadURL).toHaveBeenLastCalledWith("http://127.0.0.1:41001/b");
    expect(views).toHaveLength(1);
  });

  test("switching service replaces the view so partitions never mix", async () => {
    const { manager, views, held } = harness();
    await manager.attach({ tabId: "tab", service: service("svc_aaaaaaaa"), bounds, visible: true });
    await manager.attach({ tabId: "tab", service: service("svc_bbbbbbbb"), bounds, visible: true });
    expect(views).toHaveLength(2);
    expect(views[0]!.webContents.destroyed).toBe(true);
    expect(views[1]!.options.webPreferences.session).toEqual({
      partition: "persist:svc-svc_bbbbbbbb",
    });
    expect(held.get("bk_backend_1:svc_aaaaaaaa")?.size).toBe(0);
    expect(held.get("bk_backend_1:svc_bbbbbbbb")?.size).toBe(1);
  });

  test("navigation is confined to the service; hiding keeps the holder; destroy releases it", async () => {
    const { manager, views, held } = harness();
    await manager.attach({ tabId: "tab", service: service("svc_aaaaaaaa"), bounds, visible: true });
    const contents = views[0]!.webContents;
    const blocked = { url: "http://127.0.0.1:41002/", preventDefault: mock(() => undefined) };
    contents.emit("will-navigate", blocked);
    expect(blocked.preventDefault).toHaveBeenCalled();
    const allowed = { url: "http://127.0.0.1:41001/next", preventDefault: mock(() => undefined) };
    contents.emit("will-navigate", allowed);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    manager.setVisible("tab", false);
    expect(held.get("bk_backend_1:svc_aaaaaaaa")?.size).toBe(1);
    manager.destroy("tab");
    expect(held.get("bk_backend_1:svc_aaaaaaaa")?.size).toBe(0);
  });

  test("same-service links open as service tabs; other loopback links cannot", async () => {
    const { manager, views, emitOpenLink, menuTemplates } = harness();
    await manager.attach({ tabId: "tab", service: service("svc_aaaaaaaa"), bounds, visible: true });
    const contents = views[0]!.webContents;
    contents.emit("context-menu", {}, linkParams("http://127.0.0.1:41001/docs?page=2"));
    const same = menuTemplates.at(-1)!.find((item) => item.label === "Open Link in New Tab")!;
    expect(same.enabled).toBe(true);
    (same.click as () => void)();
    expect(emitOpenLink).toHaveBeenCalledWith({
      tabId: "tab",
      url: "http://localhost:3000/docs?page=2",
      service: {
        backendInstanceId: "bk_backend_1",
        environmentId: "env",
        serviceId: "svc_aaaaaaaa",
        path: "/docs?page=2",
      },
    });
    contents.emit("context-menu", {}, linkParams("http://localhost:3001/"));
    const other = menuTemplates.at(-1)!.find((item) => item.label === "Open Link in New Tab")!;
    expect(other.enabled).toBe(false);
  });

  test("legacy URL tabs still work and switching to a service rebuilds the view", async () => {
    const { manager, views } = harness();
    await manager.attach({ tabId: "tab", url: "http://localhost:5173/", bounds, visible: true });
    expect(views[0]!.options.webPreferences.session).toEqual({ partition: "legacy" });
    await manager.attach({ tabId: "tab", service: service("svc_aaaaaaaa"), bounds, visible: true });
    expect(views).toHaveLength(2);
    expect(views[1]!.options.webPreferences.session).toEqual({
      partition: "persist:svc-svc_aaaaaaaa",
    });
  });

  test("service previews refuse a transport URL navigation from the renderer", async () => {
    const { manager } = harness();
    await manager.attach({ tabId: "tab", service: service("svc_aaaaaaaa"), bounds, visible: true });
    await expect(manager.navigate("tab", "http://localhost:3000/")).rejects.toThrow(
      "Service previews navigate",
    );
  });

  test("reset clears the service and reloads its open views", async () => {
    const { manager, views, transport } = harness();
    await manager.attach({ tabId: "tab", service: service("svc_aaaaaaaa"), bounds, visible: true });
    await manager.resetServiceSiteData(service("svc_aaaaaaaa"));
    expect(transport.resetSiteData).toHaveBeenCalled();
    expect(views[0]!.webContents.reload).toHaveBeenCalled();
  });

  test("opening a service link externally goes through the preview origin, never the ingress URL", async () => {
    const { manager, views, openExternal, openServiceExternally, menuTemplates } = harness();
    await manager.attach({ tabId: "tab", service: service("svc_aaaaaaaa"), bounds, visible: true });
    views[0]!.webContents.emit("context-menu", {}, linkParams("http://127.0.0.1:41001/docs"));
    const item = menuTemplates.at(-1)!.find((entry) => entry.label === "Open in External Browser")!;
    expect(item.enabled).toBe(true);
    (item.click as () => void)();
    expect(openServiceExternally).toHaveBeenCalledWith({
      backendInstanceId: "bk_backend_1",
      environmentId: "env",
      serviceId: "svc_aaaaaaaa",
      path: "/docs",
    });
    expect(openExternal).not.toHaveBeenCalled();

    views[0]!.webContents.emit("context-menu", {}, linkParams("http://localhost:5173/"));
    const local = menuTemplates
      .at(-1)!
      .find((entry) => entry.label === "Open in External Browser")!;
    expect(local.enabled).toBe(false);
    views[0]!.webContents.emit("context-menu", {}, linkParams("https://docs.example.com/"));
    const external = menuTemplates
      .at(-1)!
      .find((entry) => entry.label === "Open in External Browser")!;
    expect(external.enabled).toBe(true);
  });

  test("destroying a tab while its service attach is in flight creates no view and releases the hold", async () => {
    const { manager, views, held, gates, control } = harness();
    control.holdAcquires = true;
    const attached = manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa"),
      bounds,
      visible: true,
    });
    manager.destroy("tab");
    gates.shift()!.open();
    await expect(attached).rejects.toThrow("backend-unavailable");
    expect(views).toHaveLength(0);
    expect(held.get("bk_backend_1:svc_aaaaaaaa")?.size).toBe(0);
  });

  test("destroyAll cancels in-flight attaches and refuses new ones", async () => {
    const { manager, views, held, gates, control } = harness();
    control.holdAcquires = true;
    const attached = manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa"),
      bounds,
      visible: true,
    });
    manager.destroyAll();
    gates.shift()!.open();
    await expect(attached).rejects.toThrow("backend-unavailable");
    await expect(
      manager.attach({ tabId: "tab", url: "http://localhost:5173/", bounds, visible: true }),
    ).rejects.toThrow("backend-unavailable");
    expect(views).toHaveLength(0);
    expect(held.get("bk_backend_1:svc_aaaaaaaa")?.size).toBe(0);
  });

  test("an older attach for another service resolving late never replaces the newer view", async () => {
    const { manager, views, held, gates, control } = harness();
    control.holdAcquires = true;
    const older = manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa"),
      bounds,
      visible: true,
    });
    const newer = manager.attach({
      tabId: "tab",
      service: service("svc_bbbbbbbb"),
      bounds,
      visible: true,
    });
    gates.find((gate) => gate.serviceId === "svc_bbbbbbbb")!.open();
    expect((await newer).service?.serviceId).toBe("svc_bbbbbbbb");
    gates.find((gate) => gate.serviceId === "svc_aaaaaaaa")!.open();
    expect((await older).service?.serviceId).toBe("svc_bbbbbbbb");
    expect(views).toHaveLength(1);
    expect(views[0]!.options.webPreferences.session).toEqual({
      partition: "persist:svc-svc_bbbbbbbb",
    });
    expect(views[0]!.webContents.destroyed).toBe(false);
    expect(held.get("bk_backend_1:svc_aaaaaaaa")?.size).toBe(0);
    expect(held.get("bk_backend_1:svc_bbbbbbbb")?.size).toBe(1);
  });

  test("overlapping attaches for the same service keep exactly one hold and one view", async () => {
    const { manager, views, held, gates, control } = harness();
    control.holdAcquires = true;
    const first = manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa"),
      bounds,
      visible: true,
    });
    const second = manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa"),
      bounds: { ...bounds, width: 200 },
      visible: true,
    });
    gates.shift()!.open();
    gates.shift()!.open();
    const [firstState, secondState] = await Promise.all([first, second]);
    expect(firstState).toEqual(secondState);
    expect(views).toHaveLength(1);
    expect((views[0] as unknown as { bounds: typeof bounds }).bounds.width).toBe(200);
    expect(held.get("bk_backend_1:svc_aaaaaaaa")?.size).toBe(1);
    manager.destroy("tab");
    expect(held.get("bk_backend_1:svc_aaaaaaaa")?.size).toBe(0);
  });

  test("a path change whose load outlives the tab never shows the view again", async () => {
    const { manager, views } = harness();
    await manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa", "/a"),
      bounds,
      visible: false,
    });
    const contents = views[0]!.webContents;
    let finishLoad!: () => void;
    contents.loadURL.mockImplementationOnce(
      (url: string) =>
        new Promise<void>((resolve) => {
          finishLoad = () => {
            contents.url = url;
            resolve();
          };
        }),
    );
    const attached = manager.attach({
      tabId: "tab",
      service: service("svc_aaaaaaaa", "/b"),
      bounds,
      visible: true,
    });
    await settle();
    manager.destroy("tab");
    finishLoad();
    await expect(attached).rejects.toThrow("backend-unavailable");
    expect((views[0] as unknown as { visible: boolean }).visible).toBe(false);
  });
});
