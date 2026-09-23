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
  const transport: BrowserPreviewServiceTransport = {
    acquire: mock(async (target: BrowserPreviewServiceTarget, holder: string) => {
      const key = `bk_backend_1:${target.serviceId}`;
      (held.get(key) ?? held.set(key, new Set()).get(key)!).add(holder);
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
  });
  return { manager, views, transport, held, emitState, emitOpenLink, openExternal, menuTemplates };
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
});
