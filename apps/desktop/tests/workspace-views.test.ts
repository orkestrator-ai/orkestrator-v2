import { describe, expect, mock, test } from "bun:test";
import {
  RealmLayout,
  realmChildViewClass,
  WORKSPACE_REALM_MESSAGE_CHANNEL,
  WORKSPACE_VIEWS_EVENT_CHANNEL,
  WorkspaceViews,
  type WorkspaceViewBounds,
  type WorkspaceViewsOptions,
} from "../electron/workspace-views";

import { RealmContexts } from "../electron/realm-contexts";

type Listener = (...args: unknown[]) => void;

let nextContentsId = 100;

function fakeContents() {
  const listeners = new Map<string, Listener[]>();
  const contents = {
    id: nextContentsId++,
    destroyed: false,
    url: "",
    zoom: 1,
    sent: [] as unknown[][],
    isDestroyed: () => contents.destroyed,
    close: mock(() => {
      contents.destroyed = true;
      for (const listener of listeners.get("destroyed") ?? []) listener();
    }),
    loadURL: mock(async (url: string) => {
      contents.url = url;
    }),
    focus: mock(() => undefined),
    send: (...args: unknown[]) => void contents.sent.push(args),
    setZoomFactor: (factor: number) => {
      contents.zoom = factor;
    },
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    setWindowOpenHandler: () => undefined,
  };
  return contents;
}

class FakeView {
  webContents = fakeContents();
  bounds: WorkspaceViewBounds = { x: 0, y: 0, width: 0, height: 0 };
  visible = true;
  constructor(readonly options: { webPreferences: Record<string, unknown> }) {}
  setBounds(bounds: WorkspaceViewBounds) {
    this.bounds = bounds;
  }
  setVisible(visible: boolean) {
    this.visible = visible;
  }
  setBackgroundColor() {}
}

function fakeParent(zoom = 1) {
  const children: unknown[] = [];
  const contents = { ...fakeContents(), getZoomFactor: () => zoom };
  return {
    id: 1,
    isDestroyed: () => false,
    children,
    contentView: {
      addChildView: (view: never) => void children.push(view),
      removeChildView: (view: never) => void children.splice(children.indexOf(view), 1),
    },
    webContents: contents,
  };
}

function harness(overrides: Partial<WorkspaceViewsOptions> = {}) {
  const bound: string[] = [];
  const released: string[] = [];
  const registered: number[] = [];
  const unregistered: number[] = [];
  const views = new WorkspaceViews({
    WebContentsViewCtor: FakeView as never,
    preloadPath: "/app/preload.js",
    rendererUrl: "file:///app/web/index.html",
    partitionFor: (nodeId, parentId) => `persist:realm-${parentId}-${nodeId}`,
    bindScope: async (scope) => void bound.push(scope),
    releaseScope: (scope) => void released.push(scope),
    installRequestAuth: () => undefined,
    installNavigationGuards: () => undefined,
    register: (record) => void registered.push(record.webContents.id),
    unregister: (record) => void unregistered.push(record.webContents.id),
    ...overrides,
  });
  return { views, bound, released, registered, unregistered };
}

describe("workspace realms in a desktop window", () => {
  test("a realm is bound before its document loads, on IDs only, with its own storage", async () => {
    const { views, bound, registered } = harness();
    const parent = fakeParent();
    const { viewId } = await views.open(parent as never, {
      nodeId: "bk_leaf",
      search: { project: "p", environment: "e" },
    });
    const view = parent.children[0] as FakeView;
    expect(bound).toEqual([`realm:${viewId}`]);
    expect(registered).toEqual([view.webContents.id]);
    expect(view.options.webPreferences.partition).toBe(
      "persist:realm-" + parent.webContents.id + "-bk_leaf",
    );
    const url = new URL(view.webContents.url);
    expect(view.webContents.url.split("?")[0]).toBe("file:///app/web/index.html");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      realm: "workspace",
      project: "p",
      environment: "e",
    });
    // Hidden until the window places it.
    expect(view.visible).toBe(false);
  });

  test("the window places a realm in CSS pixels at its zoom; the realm follows that zoom", async () => {
    const { views } = harness();
    const parent = fakeParent(1.25);
    const { viewId } = await views.open(parent as never, { nodeId: "bk_leaf", search: {} });
    const view = parent.children[0] as FakeView;
    views.setBounds(parent.webContents.id, viewId, { x: 100, y: 40, width: 800, height: 600 });
    views.setVisible(parent.webContents.id, viewId, true);
    expect(view.bounds).toEqual({ x: 125, y: 50, width: 1000, height: 750 });
    expect(view.visible).toBe(true);
    expect(view.webContents.zoom).toBe(1.25);
  });

  test("only the owning window places or messages a realm, and only a realm posts to it", async () => {
    const { views } = harness();
    const parent = fakeParent();
    const { viewId } = await views.open(parent as never, { nodeId: "bk_leaf", search: {} });
    const view = parent.children[0] as FakeView;
    expect(() => views.setVisible(999, viewId, true)).toThrow("no longer open");
    views.send(parent.webContents.id, viewId, { type: "select", projectId: "p" });
    expect(view.webContents.sent).toEqual([
      [WORKSPACE_REALM_MESSAGE_CHANNEL, { type: "select", projectId: "p" }],
    ]);
    views.post(view.webContents.id, { type: "ready" });
    expect(parent.webContents.sent).toEqual([
      [WORKSPACE_VIEWS_EVENT_CHANNEL, { viewId, type: "message", message: { type: "ready" } }],
    ]);
    expect(() => views.post(parent.webContents.id, { type: "ready" })).toThrow("workspace realm");
  });

  test("panel focus crosses native contents only for visible user handoffs", async () => {
    const { views } = harness();
    const parent = fakeParent();
    const { viewId } = await views.open(parent as never, { nodeId: "bk_leaf", search: {} });
    const child = (parent.children[0] as FakeView).webContents;
    const send = (open: boolean, restoreFocus = false) =>
      views.send(parent.webContents.id, viewId, {
        type: "panel",
        panel: "agent",
        open,
        restoreFocus,
      });
    send(true);
    expect(child.focus).not.toHaveBeenCalled();
    views.setVisible(parent.webContents.id, viewId, true);
    send(true);
    expect(child.focus).toHaveBeenCalledTimes(1);
    send(false);
    expect(parent.webContents.focus).not.toHaveBeenCalled();
    send(false, true);
    expect(parent.webContents.focus).toHaveBeenCalledTimes(1);
    views.setVisible(parent.webContents.id, viewId, false);
    send(false, true);
    send(true);
    expect(child.focus).toHaveBeenCalledTimes(1);
    expect(parent.webContents.focus).toHaveBeenCalledTimes(1);
  });

  test("a still of a realm is a JPEG data URL for its own window only", async () => {
    const { views } = harness();
    const parent = fakeParent();
    const { viewId } = await views.open(parent as never, { nodeId: "bk_leaf", search: {} });
    const view = parent.children[0] as FakeView;
    expect(await views.capture(parent.webContents.id, viewId)).toBeNull();
    (view.webContents as unknown as { capturePage: () => Promise<unknown> }).capturePage =
      async () => ({ isEmpty: () => false, toJPEG: () => new Uint8Array([1, 2, 3]) });
    expect(await views.capture(parent.webContents.id, viewId)).toBe("data:image/jpeg;base64,AQID");
    await expect(views.capture(999, viewId)).rejects.toThrow("no longer open");
  });

  test("closing a window's realms releases their scopes and tells nobody", async () => {
    const { views, released } = harness();
    const parent = fakeParent();
    const first = await views.open(parent as never, { nodeId: "bk_a", search: {} });
    const second = await views.open(parent as never, { nodeId: "bk_b", search: {} });
    views.closeAllFor(parent.webContents.id);
    expect(released).toEqual([`realm:${first.viewId}`, `realm:${second.viewId}`]);
    expect(parent.children).toEqual([]);
    expect(parent.webContents.sent).toEqual([]);
  });
  for (const failure of ["crashed", "load-failed", "closed"] as const) {
    test(`${failure} disposes the realm before notification and frees capacity`, async () => {
      let rejectLoad!: (error: Error) => void;
      class FailingView extends FakeView {
        constructor(options: { webPreferences: Record<string, unknown> }) {
          super(options);
          if (failure === "load-failed") {
            this.webContents.loadURL.mockImplementation(
              () =>
                new Promise<void>((_, reject) => {
                  rejectLoad = reject;
                }),
            );
          }
        }
      }
      const { views, released, unregistered } = harness({
        maxViewsPerWindow: 1,
        WebContentsViewCtor: FailingView as never,
      });
      const parent = fakeParent();
      const { viewId } = await views.open(parent as never, { nodeId: "bk_a", search: {} });
      const view = parent.children[0] as FakeView;
      await expect(views.open(parent as never, { nodeId: "bk_b", search: {} })).rejects.toThrow(
        "Too many",
      );
      views.setBounds(parent.webContents.id, viewId, { x: 1, y: 1, width: 100, height: 100 });
      views.setVisible(parent.webContents.id, viewId, true);
      const record = views.viewForWebContents(view.webContents.id)!;
      const order: string[] = [];
      record.layout.subscribe(() => order.push("hidden"));
      parent.webContents.send = (...args: unknown[]) => {
        expect(parent.children).toHaveLength(0);
        expect(released).toEqual([record.scope]);
        expect(unregistered).toEqual([view.webContents.id]);
        order.push("notified");
        parent.webContents.sent.push(args);
      };
      if (failure === "load-failed") {
        rejectLoad(new Error("load failed"));
        await Promise.resolve();
      } else if (failure === "crashed") view.webContents.emit("render-process-gone");
      else view.webContents.close();
      expect(order).toEqual(["hidden", "notified"]);
      expect(parent.webContents.sent).toEqual([
        [WORKSPACE_VIEWS_EVENT_CHANNEL, { viewId, type: failure }],
      ]);
      expect(view.webContents.destroyed).toBe(true);
      expect(views.viewForWebContents(view.webContents.id)).toBeNull();
      // Late failure callbacks cannot release or notify a second time.
      view.webContents.emit("render-process-gone");
      expect(released).toHaveLength(1);
      expect(parent.webContents.sent).toHaveLength(1);
      await views.open(parent as never, { nodeId: "bk_b", search: {} });
      expect(parent.children).toHaveLength(1);
      parent.webContents.send = () => undefined;
      views.closeAllFor(parent.webContents.id);
    });
  }

  test("terminal disposal unregisters the main-process context and its hosts before scope release", async () => {
    const events: string[] = [];
    const contexts = new RealmContexts(
      () => events.push("prompts"),
      () => {
        throw new Error("unexpected disposal rejection");
      },
    );
    const { views } = harness({
      register: (record) =>
        contexts.register({
          contents: { id: record.webContents.id, isDestroyed: () => false, isFocused: () => true },
          realm: { parentWebContentsId: record.parentWebContentsId, viewId: record.viewId },
          browserPreviewManager: { destroyAll: () => void events.push("previews") },
          artifactHosts: { dispose: () => void events.push("artifacts") },
          previewTransport: {
            disposeAll: async () => {
              events.push("transports");
            },
          },
        }),
      unregister: (record) => contexts.unregister(record.webContents.id),
      releaseScope: () => {
        expect(Array.from(contexts.values())).toHaveLength(0);
        events.push("scope");
      },
    });
    const parent = fakeParent();
    await views.open(parent as never, { nodeId: "bk_a", search: {} });
    const view = parent.children[0] as FakeView;
    expect(contexts.get(view.webContents.id)?.realm?.parentWebContentsId).toBe(
      parent.webContents.id,
    );
    view.webContents.emit("render-process-gone");
    expect(events).toEqual(["previews", "artifacts", "transports", "prompts", "scope"]);
    expect(parent.children).toHaveLength(0);
  });

  test("navigation invalidates a pending binding while new document opens remain possible", async () => {
    let resolveBind!: () => void;
    const { views, released, registered } = harness({
      maxViewsPerWindow: 1,
      bindScope: () =>
        new Promise<void>((resolve) => {
          resolveBind = resolve;
        }),
    });
    const parent = fakeParent();
    const stale = views.open(parent as never, { nodeId: "bk_a", search: {} });
    const rejected = stale.catch((error: unknown) => error);
    await expect(views.open(parent as never, { nodeId: "bk_b", search: {} })).rejects.toThrow(
      "Too many",
    );
    const resolveStale = resolveBind;
    views.closeAllFor(parent.webContents.id);
    const fresh = views.open(parent as never, { nodeId: "bk_b", search: {} });
    resolveStale();
    expect(await rejected).toBeInstanceOf(Error);
    expect(parent.children).toHaveLength(0);
    expect(registered).toHaveLength(0);
    expect(released).toHaveLength(1);
    resolveBind();
    const opened = await fresh;
    expect(parent.children).toHaveLength(1);
    expect(released).not.toContain(`realm:${opened.viewId}`);
    views.closeAllFor(parent.webContents.id);
  });

  test("a destroyed parent releases a deferred binding without creating a view", async () => {
    let resolveBind!: () => void;
    const { views, released, registered } = harness({
      bindScope: () =>
        new Promise<void>((resolve) => {
          resolveBind = resolve;
        }),
    });
    const parent = fakeParent();
    const pending = views.open(parent as never, { nodeId: "bk_a", search: {} });
    const rejected = pending.catch((error: unknown) => error);
    parent.isDestroyed = () => true;
    resolveBind();
    expect(await rejected).toBeInstanceOf(Error);
    expect(released).toHaveLength(1);
    expect(registered).toHaveLength(0);
    expect(parent.children).toHaveLength(0);
  });

  for (const stage of ["binding", "construction", "auth", "registration", "attachment"] as const) {
    test(`failure during ${stage} releases all allocated resources`, async () => {
      const parent = fakeParent();
      const fail = () => {
        throw new Error("fixture failure");
      };
      const { views, released, unregistered } = harness({
        ...(stage === "binding" ? { bindScope: async () => fail() } : {}),
        ...(stage === "construction"
          ? {
              WebContentsViewCtor: class {
                constructor() {
                  fail();
                }
              } as never,
            }
          : {}),
        ...(stage === "auth" ? { installRequestAuth: fail } : {}),
        ...(stage === "registration" ? { register: fail } : {}),
      });
      if (stage === "attachment") parent.contentView.addChildView = fail;
      await expect(views.open(parent as never, { nodeId: "bk_a", search: {} })).rejects.toThrow(
        "fixture failure",
      );
      expect(parent.children).toHaveLength(0);
      expect(released).toHaveLength(1);
      expect(unregistered).toHaveLength(stage === "binding" || stage === "construction" ? 0 : 1);
      expect(parent.webContents.sent).toHaveLength(0);
    });
  }
});

describe("native views a realm opens", () => {
  test("take the realm's coordinates and show only while the realm does", () => {
    const layout = new RealmLayout();
    const ChildView = realmChildViewClass(FakeView as never, layout) as unknown as typeof FakeView;
    const child = new ChildView({ webPreferences: {} });
    child.setBounds({ x: 10, y: 20, width: 300, height: 200 });
    child.setVisible(true);
    // The realm is not placed yet.
    expect(child.visible).toBe(false);
    layout.update({ x: 125, y: 50 }, true);
    expect(child.bounds).toEqual({ x: 135, y: 70, width: 300, height: 200 });
    expect(child.visible).toBe(true);
    expect((child as unknown as { getBounds(): WorkspaceViewBounds }).getBounds()).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    layout.update({ x: 125, y: 50 }, false);
    expect(child.visible).toBe(false);
  });
});
