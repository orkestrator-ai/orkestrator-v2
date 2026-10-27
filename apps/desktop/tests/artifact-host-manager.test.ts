import { EventEmitter } from "node:events";
import { describe, expect, mock, test } from "bun:test";
import type {
  ArtifactHostEvent,
  ArtifactHostOpenInput,
} from "@orkestrator/protocol/artifact-host-ipc";
import type { ArtifactThemeMessage } from "@orkestrator/protocol/artifact-frame-channel";
import { ArtifactHostManager } from "../electron/artifact-host-manager";
import {
  ARTIFACT_SHELL_DRAIN_EXPRESSION,
  ARTIFACT_SHELL_SCHEME,
  ARTIFACT_SHELL_URL,
} from "../electron/artifact-host-shell";
import type { ArtifactHostDiagnostics } from "../electron/artifact-host-session";

const CONTENT_URL = "http://127.0.0.1:47123/artifact-content/cap_abcdefghijklmnop/document";
const IDENTITY = { artifactId: "art_1", revision: 3, generation: "gen_0001" } as const;
const NONCE = "nonce_12345678";

type RequestDetails = {
  url: string;
  method: string;
  resourceType: string;
  webContentsId?: number;
  frame?: FakeFrame | null;
};
type RequestListener = (
  details: RequestDetails,
  callback: (response: { cancel?: boolean }) => void,
) => void;

class FakeFrame {
  url = "";
  frames: FakeFrame[] = [];
  hung = false;
  readonly executeJavaScript = mock((code: string, _userGesture?: boolean): Promise<unknown> => {
    if (code === "0" && this.hung) return new Promise(() => undefined);
    if (code === ARTIFACT_SHELL_DRAIN_EXPRESSION) {
      return new Promise((resolve, reject) => this.drains.push({ resolve, reject }));
    }
    this.scripts.push(code);
    return Promise.resolve(true);
  });
  readonly drains: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> =
    [];
  readonly scripts: string[] = [];
  constructor(
    readonly frameTreeNodeId: number,
    readonly parent: FakeFrame | null = null,
  ) {}
}

class FakeWebContents extends EventEmitter {
  static nextId = 100;
  readonly id = FakeWebContents.nextId++;
  readonly mainFrame = new FakeFrame(1);
  readonly focus = mock(() => undefined);
  destroyed = false;
  zoomFactor = 1;
  windowOpenHandler: (() => unknown) | null = null;
  readonly loadURL = mock(async (url: string) => {
    this.mainFrame.url = url;
  });
  readonly close = mock((_options?: unknown) => {
    this.destroyed = true;
  });
  readonly forcefullyCrashRenderer = mock(() => undefined);
  readonly setZoomFactor = mock((factor: number) => {
    this.zoomFactor = factor;
  });
  readonly getZoomFactor = mock(() => this.zoomFactor);
  readonly setWindowOpenHandler = mock((handler: () => unknown) => {
    this.windowOpenHandler = handler;
  });
  readonly setWebRTCIPHandlingPolicy = mock((_policy: string) => undefined);
  isDestroyed() {
    return this.destroyed;
  }
}

class FakeSession extends EventEmitter {
  beforeRequest: RequestListener | null = null;
  beforeRedirect: ((details: RequestDetails) => void) | null = null;
  protocolHandler: ((request: Request) => Response | Promise<Response>) | null = null;
  permissionRequest: ((...args: unknown[]) => void) | null = null;
  permissionCheck: ((...args: unknown[]) => boolean) | null = null;
  devicePermission: ((...args: unknown[]) => boolean) | null = null;
  readonly webRequest = {
    onBeforeRequest: mock((listener: RequestListener | null) => {
      this.beforeRequest = listener;
    }),
    onBeforeRedirect: mock((listener: ((details: RequestDetails) => void) | null) => {
      this.beforeRedirect = listener;
    }),
  };
  readonly protocol = {
    handle: mock((scheme: string, handler: (request: Request) => Response) => {
      expect(scheme).toBe(ARTIFACT_SHELL_SCHEME);
      this.protocolHandler = handler;
    }),
    unhandle: mock((_scheme: string) => {
      this.protocolHandler = null;
    }),
  };
  readonly setPermissionRequestHandler = mock((handler: (...args: unknown[]) => void) => {
    this.permissionRequest = handler;
  });
  readonly setPermissionCheckHandler = mock((handler: (...args: unknown[]) => boolean) => {
    this.permissionCheck = handler;
  });
  readonly setDevicePermissionHandler = mock((handler: (...args: unknown[]) => boolean) => {
    this.devicePermission = handler;
  });
  readonly setSpellCheckerEnabled = mock((_enabled: boolean) => undefined);
  proxyResult: Promise<void> = Promise.resolve();
  readonly setProxy = mock((_config: unknown) => this.proxyResult);
  readonly clearStorageData = mock(async () => undefined);
  readonly clearCache = mock(async () => undefined);
  readonly clearAuthCache = mock(async () => undefined);

  /** Run the installed request policy; true when the request was admitted. */
  request(details: RequestDetails): boolean {
    let cancelled: boolean | undefined;
    this.beforeRequest?.(details, (response) => {
      cancelled = response.cancel === true;
    });
    if (cancelled === undefined) throw new Error("request listener did not answer");
    return !cancelled;
  }
}

function createHarness(
  options: { zoom?: number; legacySession?: boolean; proxyFails?: boolean } = {},
) {
  const views: FakeView[] = [];
  const sessions: Array<{ partition: string; session: FakeSession }> = [];
  class FakeView {
    readonly webContents = new FakeWebContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
    readonly setBackgroundColor = mock(() => undefined);
    readonly setBounds = mock((bounds: typeof this.bounds) => {
      this.bounds = bounds;
    });
    readonly getVisible = mock(() => this.visible);
    readonly setVisible = mock((visible: boolean) => {
      this.visible = visible;
    });
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      views.push(this);
    }
  }
  let windowDestroyed = false;
  let hostZoom = options.zoom ?? 1;
  const contentView = {
    addChildView: mock((_view: unknown) => undefined),
    removeChildView: mock((_view: unknown) => undefined),
  };
  const window = {
    isDestroyed: () => windowDestroyed,
    contentView,
    webContents: { getZoomFactor: () => hostZoom },
  };
  const events: ArtifactHostEvent[] = [];
  const diagnostics: ArtifactHostDiagnostics[] = [];
  let clock = 0;
  let ids = 0;
  const manager = new ArtifactHostManager({
    getWindow: () => window as never,
    WebContentsViewCtor: FakeView as never,
    fromPartition: (partition) => {
      const session = new FakeSession();
      if (options.legacySession) {
        (session as unknown as { protocol: unknown }).protocol = {};
      }
      if (options.proxyFails) session.proxyResult = Promise.reject(new Error("proxy"));
      sessions.push({ partition, session });
      return session as never;
    },
    emit: (event) => events.push(event),
    reportDiagnostics: (value) => diagnostics.push(value),
    now: () => clock,
    randomId: () => `id${++ids}`,
    readyTimeoutMs: 1000,
    heartbeatIntervalMs: 5,
    heartbeatTimeoutMs: 20,
  });
  return {
    manager,
    views,
    sessions,
    contentView,
    events,
    diagnostics,
    advance(ms: number) {
      clock += ms;
    },
    setWindowDestroyed(value: boolean) {
      windowDestroyed = value;
    },
    setHostZoom(value: number) {
      hostZoom = value;
    },
  };
}

function openInput(overrides: Partial<ArtifactHostOpenInput> = {}): ArtifactHostOpenInput {
  return {
    hostId: "host-1",
    contentUrl: CONTENT_URL,
    ...IDENTITY,
    readinessNonce: NONCE,
    bounds: { x: 10, y: 20, width: 600, height: 300 },
    visible: true,
    ...overrides,
  };
}

/** Open a host and drive Electron through the shell + content loads. */
async function openLive(
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<ArtifactHostOpenInput> = {},
) {
  await expect(harness.manager.open(openInput(overrides))).resolves.toEqual({ ok: true });
  // The shell loads once the session's network policy is in place.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const view = harness.views.at(-1)!;
  const { session } = harness.sessions.at(-1)!;
  const contents = view.webContents;
  return { view, session, contents };
}

function loadDocuments(session: FakeSession, contents: FakeWebContents) {
  expect(
    session.request({
      url: ARTIFACT_SHELL_URL,
      method: "GET",
      resourceType: "mainFrame",
      webContentsId: contents.id,
    }),
  ).toBe(true);
  const child = new FakeFrame(2, contents.mainFrame);
  expect(
    session.request({
      url: CONTENT_URL,
      method: "GET",
      resourceType: "subFrame",
      webContentsId: contents.id,
      frame: child,
    }),
  ).toBe(true);
  return child;
}

const frameMessage = (fields: Record<string, unknown>) => ({
  channel: "orkestrator-artifact",
  v: 1,
  ...fields,
});
const readyMessage = (nonce = NONCE) => frameMessage({ type: "ready", protocolVersion: 1, nonce });

function theme(overrides: Partial<ArtifactThemeMessage> = {}): ArtifactThemeMessage {
  return {
    channel: "orkestrator-artifact",
    v: 1,
    type: "theme",
    ...IDENTITY,
    appearance: "dark",
    reducedMotion: false,
    viewport: { width: 600, height: 300 },
    tokens: { "--ork-fg": "#fff" },
    ...overrides,
  };
}

function expectTornDown(
  harness: ReturnType<typeof createHarness>,
  view: { webContents: FakeWebContents },
  session: FakeSession,
) {
  expect(harness.contentView.removeChildView).toHaveBeenCalledWith(view);
  expect(view.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  expect(session.protocol.unhandle).toHaveBeenCalledWith(ARTIFACT_SHELL_SCHEME);
  // The private session stays fail-closed after disposal.
  expect(session.request({ url: CONTENT_URL, method: "GET", resourceType: "subFrame" })).toBe(
    false,
  );
}

describe("artifact host view and session", () => {
  test("creates a sandboxed view with exact preferences on a fresh nonpersistent session", async () => {
    const harness = createHarness();
    const { view, session } = await openLive(harness);
    expect(harness.sessions).toHaveLength(1);
    expect(harness.sessions[0]!.partition).toBe("artifact-host-id1");
    expect(harness.sessions[0]!.partition.startsWith("persist:")).toBe(false);
    expect(view.options.webPreferences).toEqual({
      session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      safeDialogs: true,
      disableDialogs: true,
      navigateOnDragDrop: false,
      spellcheck: false,
      webviewTag: false,
      plugins: false,
      enableWebSQL: false,
      experimentalFeatures: false,
      autoplayPolicy: "document-user-activation-required",
      zoomFactor: 1,
    });
    expect("preload" in view.options.webPreferences).toBe(false);
    expect(view.webContents.loadURL).toHaveBeenCalledWith(ARTIFACT_SHELL_URL);
    expect(harness.contentView.addChildView).toHaveBeenCalledWith(view);
  });

  test("installs request interception and shell protocol before any navigation", async () => {
    const harness = createHarness();
    const { session, contents } = await openLive(harness);
    expect(session.beforeRequest).not.toBeNull();
    expect(session.beforeRedirect).not.toBeNull();
    expect(contents.loadURL).toHaveBeenCalledTimes(1);
    const loadOrder = contents.loadURL.mock.invocationCallOrder[0]!;
    expect(session.webRequest.onBeforeRequest.mock.invocationCallOrder[0]!).toBeLessThan(loadOrder);
    expect(session.webRequest.onBeforeRedirect.mock.invocationCallOrder[0]!).toBeLessThan(
      loadOrder,
    );
    expect(session.protocol.handle.mock.invocationCallOrder[0]!).toBeLessThan(loadOrder);
    expect(session.setPermissionRequestHandler.mock.invocationCallOrder[0]!).toBeLessThan(
      loadOrder,
    );
    expect(session.setProxy.mock.invocationCallOrder[0]!).toBeLessThan(loadOrder);
  });

  test("contains WebRTC: no non-proxied UDP and a black-hole proxy except for the content host", async () => {
    const harness = createHarness();
    const { session, contents } = await openLive(harness);
    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith("disable_non_proxied_udp");
    expect(session.setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyRules: "http://127.0.0.1:9",
      proxyBypassRules: "<-loopback>;127.0.0.1:47123",
    });
  });

  test("a failed network policy never loads the shell", async () => {
    const harness = createHarness({ proxyFails: true });
    await harness.manager.open(openInput());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.views[0]!.webContents.loadURL).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      { hostId: "host-1", type: "navigation-blocked", reason: "network-policy-failed" },
    ]);
  });

  test("clears the private session's storage when the host closes", async () => {
    const harness = createHarness();
    const { session } = await openLive(harness);
    harness.manager.close("host-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.clearStorageData).toHaveBeenCalled();
    expect(session.clearCache).toHaveBeenCalled();
    expect(session.clearAuthCache).toHaveBeenCalled();
  });

  test("denies permissions, devices, downloads, popups and device choosers", async () => {
    const harness = createHarness();
    const { session, contents } = await openLive(harness);
    const granted = mock((_value: boolean) => undefined);
    session.permissionRequest?.(contents, "media", granted, {});
    session.permissionRequest?.(contents, "clipboard-sanitized-write", granted, {});
    expect(granted.mock.calls).toEqual([[false], [false]]);
    expect(session.permissionCheck?.(contents, "geolocation", "null", {})).toBe(false);
    expect(session.devicePermission?.({})).toBe(false);
    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(false);

    const download = { preventDefault: mock(() => undefined) };
    const item = { cancel: mock(() => undefined) };
    session.emit("will-download", download, item, contents);
    expect(download.preventDefault).toHaveBeenCalled();
    expect(item.cancel).toHaveBeenCalled();

    const hid = { preventDefault: mock(() => undefined) };
    const hidCallback = mock((_id?: string | null) => undefined);
    session.emit("select-hid-device", hid, {}, hidCallback);
    expect(hid.preventDefault).toHaveBeenCalled();
    expect(hidCallback).toHaveBeenCalledWith(null);

    expect(contents.windowOpenHandler?.()).toEqual({ action: "deny" });
  });

  test("serves the fixed shell once with a policy restricting frames to the content origin", async () => {
    const harness = createHarness();
    const { session } = await openLive(harness);
    const response = await session.protocolHandler!(new Request(ARTIFACT_SHELL_URL));
    expect(response.status).toBe(200);
    const policy = response.headers.get("content-security-policy")!;
    expect(policy).toContain("frame-src http://127.0.0.1:47123;");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-eval");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("allow-popups");

    const again = await session.protocolHandler!(new Request(ARTIFACT_SHELL_URL));
    expect(again.status).toBe(404);
  });
});

describe("artifact host request policy", () => {
  test("admits only the shell and the exact content document, once each", async () => {
    const harness = createHarness();
    const { session, contents } = await openLive(harness);
    loadDocuments(session, contents);
    expect(harness.manager.activeHostId).toBe("host-1");
    // A self-reload of the artifact asks for the same capability URL again.
    expect(
      session.request({
        url: CONTENT_URL,
        method: "GET",
        resourceType: "subFrame",
        webContentsId: contents.id,
      }),
    ).toBe(false);
    expect(harness.events.at(-1)).toEqual({
      hostId: "host-1",
      type: "navigation-blocked",
      reason: "content-reload",
    });
    expect(harness.manager.activeHostId).toBeNull();
  });

  for (const [name, details, reason] of [
    [
      "a WebSocket",
      { url: "ws://127.0.0.1:47123/socket", method: "GET", resourceType: "webSocket" },
      "websocket",
    ],
    [
      "another origin's image",
      { url: "https://metadata.example/latest", method: "GET", resourceType: "image" },
      "subresource",
    ],
    [
      "an application endpoint",
      { url: "http://127.0.0.1:1420/api/projects", method: "GET", resourceType: "xhr" },
      "subresource",
    ],
    [
      "a custom scheme",
      { url: "orkestrator://settings", method: "GET", resourceType: "subFrame" },
      "navigation",
    ],
    [
      "a POST to the content URL",
      { url: CONTENT_URL, method: "POST", resourceType: "subFrame" },
      "content-wrong-request",
    ],
    [
      "the content URL as a script",
      { url: CONTENT_URL, method: "GET", resourceType: "script" },
      "content-wrong-request",
    ],
    [
      "a different capability on the content origin",
      {
        url: "http://127.0.0.1:47123/artifact-content/cap_other/document",
        method: "GET",
        resourceType: "subFrame",
      },
      "navigation",
    ],
    [
      "a shell reload",
      { url: ARTIFACT_SHELL_URL, method: "GET", resourceType: "mainFrame" },
      "shell-reload",
    ],
  ] as const) {
    test(`cancels ${name} and closes the host`, async () => {
      const harness = createHarness();
      const { view, session, contents } = await openLive(harness);
      loadDocuments(session, contents);
      expect(session.request({ ...details, webContentsId: contents.id })).toBe(false);
      expect(harness.events.at(-1)).toEqual({
        hostId: "host-1",
        type: "navigation-blocked",
        reason,
      });
      expectTornDown(harness, view, session);
      expect(harness.diagnostics.at(-1)?.blocked[reason]).toBe(1);
    });
  }

  test("refuses the content document before the shell and from a nested frame", async () => {
    const harness = createHarness();
    const { session, contents } = await openLive(harness);
    expect(
      session.request({
        url: CONTENT_URL,
        method: "GET",
        resourceType: "subFrame",
        webContentsId: contents.id,
      }),
    ).toBe(false);
    expect(harness.events.at(-1)).toMatchObject({
      type: "navigation-blocked",
      reason: "content-wrong-request",
    });

    const second = createHarness();
    const live = await openLive(second);
    live.session.request({
      url: ARTIFACT_SHELL_URL,
      method: "GET",
      resourceType: "mainFrame",
      webContentsId: live.contents.id,
    });
    const child = new FakeFrame(2, live.contents.mainFrame);
    const grandchild = new FakeFrame(3, child);
    expect(
      live.session.request({
        url: CONTENT_URL,
        method: "GET",
        resourceType: "subFrame",
        webContentsId: live.contents.id,
        frame: grandchild,
      }),
    ).toBe(false);
  });

  test("redirects are fatal whether observed by the network or the navigation", async () => {
    const harness = createHarness();
    const { session, contents } = await openLive(harness);
    session.beforeRedirect?.({
      url: CONTENT_URL,
      method: "GET",
      resourceType: "subFrame",
      webContentsId: contents.id,
    });
    expect(harness.events.at(-1)).toMatchObject({ type: "navigation-blocked", reason: "redirect" });

    const second = createHarness();
    const live = await openLive(second);
    const event = {
      url: "https://elsewhere.example/",
      isMainFrame: false,
      preventDefault: mock(() => undefined),
    };
    live.contents.emit("will-redirect", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(second.events.at(-1)).toMatchObject({ type: "navigation-blocked", reason: "redirect" });
  });

  test("a request from an unknown web contents is cancelled without closing the host", async () => {
    const harness = createHarness();
    const { session, contents } = await openLive(harness);
    loadDocuments(session, contents);
    expect(
      session.request({
        url: "https://example.com/",
        method: "GET",
        resourceType: "image",
        webContentsId: 9999,
      }),
    ).toBe(false);
    expect(harness.manager.activeHostId).toBe("host-1");
  });
});

describe("artifact host navigation guards", () => {
  for (const url of [
    "data:text/html,<script>parent.postMessage(1,'*')</script>",
    "blob:http://127.0.0.1:47123/5d2c6b1e-1111-2222-3333-444455556666",
    "about:blank",
    "https://elsewhere.example/landing",
  ]) {
    test(`prevents frame navigation to ${url.slice(0, 24)}…`, async () => {
      const harness = createHarness();
      const { view, session, contents } = await openLive(harness);
      const child = loadDocuments(session, contents);
      contents.emit("will-frame-navigate", {
        url: CONTENT_URL,
        isMainFrame: false,
        frame: child,
        preventDefault: mock(() => undefined),
      });
      expect(harness.manager.activeHostId).toBe("host-1");
      const event = {
        url,
        isMainFrame: false,
        frame: child,
        preventDefault: mock(() => undefined),
      };
      contents.emit("will-frame-navigate", event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(harness.events.at(-1)).toMatchObject({
        type: "navigation-blocked",
        reason: "frame-navigation",
      });
      expectTornDown(harness, view, session);
    });
  }

  test("blocks main-frame navigation, meta refresh and nested frame loads", async () => {
    const harness = createHarness();
    const { contents } = await openLive(harness);
    const event = { url: "https://elsewhere.example/", preventDefault: mock(() => undefined) };
    contents.emit("will-navigate", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(harness.events.at(-1)).toMatchObject({ reason: "main-frame-navigation" });

    // A meta refresh in the artifact is a second navigation of the content frame.
    const refresh = createHarness();
    const live = await openLive(refresh);
    const child = new FakeFrame(2, live.contents.mainFrame);
    live.contents.emit("did-start-navigation", {
      url: ARTIFACT_SHELL_URL,
      isMainFrame: true,
      isSameDocument: false,
      frame: live.contents.mainFrame,
    });
    live.contents.emit("did-start-navigation", {
      url: CONTENT_URL,
      isMainFrame: false,
      isSameDocument: false,
      frame: child,
    });
    expect(refresh.manager.activeHostId).toBe("host-1");
    live.contents.emit("did-start-navigation", {
      url: CONTENT_URL,
      isMainFrame: false,
      isSameDocument: false,
      frame: child,
    });
    expect(refresh.events.at(-1)).toMatchObject({ reason: "frame-navigation" });

    const nested = createHarness();
    const third = await openLive(nested);
    const outer = new FakeFrame(2, third.contents.mainFrame);
    third.contents.emit("did-start-navigation", {
      url: "about:srcdoc",
      isMainFrame: false,
      isSameDocument: false,
      frame: new FakeFrame(3, outer),
    });
    expect(nested.events.at(-1)).toMatchObject({ reason: "nested-frame-navigation" });
  });

  test("a non-200 content response closes the host so the saved preview shows", async () => {
    const harness = createHarness();
    const { contents } = await openLive(harness);
    contents.emit("did-frame-navigate", {}, CONTENT_URL, 403, "Forbidden", false, 1, 2);
    expect(harness.events.at(-1)).toEqual({
      hostId: "host-1",
      type: "navigation-blocked",
      reason: "content-unavailable",
    });
  });

  test("never presents a client certificate", async () => {
    const harness = createHarness();
    const { contents } = await openLive(harness);
    const event = { preventDefault: mock(() => undefined) };
    contents.emit("select-client-certificate", event, CONTENT_URL, [], () => undefined);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(harness.manager.activeHostId).toBeNull();
  });
});

describe("artifact presentation channel", () => {
  async function liveWithPump(harness = createHarness()) {
    const live = await openLive(harness);
    loadDocuments(live.session, live.contents);
    live.contents.emit("dom-ready");
    await Promise.resolve();
    expect(live.contents.mainFrame.drains).toHaveLength(1);
    const host = harness.manager.activeHost()!;
    return { ...live, host, harness };
  }

  async function deliver(contents: FakeWebContents, messages: unknown[], dropped = 0) {
    const drain = contents.mainFrame.drains.shift();
    if (!drain) throw new Error("no pending drain");
    drain.resolve({ messages, dropped });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("completes the readiness handshake, then delivers the queued theme", async () => {
    const { contents, harness } = await liveWithPump();
    harness.manager.postTheme("host-1", theme());
    expect(contents.mainFrame.scripts).toHaveLength(0);
    await deliver(contents, [readyMessage()]);
    expect(harness.events.at(-1)).toEqual({ hostId: "host-1", type: "ready" });
    expect(contents.mainFrame.scripts).toHaveLength(1);
    expect(contents.mainFrame.scripts[0]).toContain('"type":"theme"');
    // The pump keeps polling.
    expect(contents.mainFrame.drains).toHaveLength(1);
  });

  test("rejects a wrong readiness nonce, pre-ready identity messages and theme for another identity", async () => {
    const { contents, harness, host } = await liveWithPump();
    await deliver(contents, [
      readyMessage("nonce_wrong_000"),
      frameMessage({ type: "size", height: 400, ...IDENTITY }),
    ]);
    expect(
      harness.events.filter((event) => event.type === "ready" || event.type === "size"),
    ).toEqual([]);
    expect(host.snapshotDiagnostics().rejected).toMatchObject({
      "nonce-mismatch": 1,
      "identity-mismatch": 1,
    });
    harness.manager.postTheme("host-1", theme({ generation: "gen_other" }));
    await deliver(contents, [readyMessage()]);
    expect(contents.mainFrame.scripts).toHaveLength(0);
    expect(host.snapshotDiagnostics().rejected["theme-identity-mismatch"]).toBe(1);
  });

  test("forwards bounded size and link requests with exact identity only", async () => {
    const { contents, harness, host } = await liveWithPump();
    await deliver(contents, [readyMessage()]);
    harness.advance(1_000);
    await deliver(contents, [
      frameMessage({ type: "size", height: 480, width: 600, ...IDENTITY }),
      frameMessage({ type: "size", height: 480, ...IDENTITY, generation: "gen_stale" }),
      frameMessage({ type: "size", height: Number.POSITIVE_INFINITY, ...IDENTITY }),
      frameMessage({ type: "size", height: 10, ...IDENTITY, extra: true }),
      frameMessage({ type: "invoke-tool", name: "bash", ...IDENTITY }),
      frameMessage({ type: "theme", ...IDENTITY }),
      "not an object",
      null,
      frameMessage({
        type: "link-request",
        url: "https://docs.example.com/a?b=1",
        label: `Docs${String.fromCharCode(0x202e)} evil`,
        ...IDENTITY,
      }),
      frameMessage({ type: "link-request", url: "javascript:alert(1)", label: "x", ...IDENTITY }),
      frameMessage({
        type: "link-request",
        url: "https://user:pw@example.com/",
        label: "x",
        ...IDENTITY,
      }),
      frameMessage({ type: "link-request", url: "file:///etc/passwd", label: "x", ...IDENTITY }),
    ]);
    const forwarded = harness.events.filter(
      (event) => event.type === "size" || event.type === "link-request",
    );
    expect(forwarded).toEqual([
      { hostId: "host-1", type: "size", height: 480, width: 600 },
      {
        hostId: "host-1",
        type: "link-request",
        href: "https://docs.example.com/a?b=1",
        hostname: "docs.example.com",
        label: "Docs evil",
      },
    ]);
    expect(host.snapshotDiagnostics().rejected).toMatchObject({
      "identity-mismatch": 1,
      "bad-shape": 5,
      "unknown-type": 2,
      "not-object": 2,
    });
  });

  test("rejects oversized and cyclic payloads and rate-limits floods", async () => {
    const { contents, harness, host } = await liveWithPump();
    await deliver(contents, [readyMessage()]);
    const cyclic: Record<string, unknown> = frameMessage({ type: "size", height: 1, ...IDENTITY });
    cyclic.self = cyclic;
    await deliver(contents, [
      frameMessage({
        type: "link-request",
        url: "https://a.example/",
        label: "x".repeat(9_000),
        ...IDENTITY,
      }),
      cyclic,
    ]);
    expect(host.snapshotDiagnostics().rejected["too-large"]).toBe(2);

    harness.advance(10_000);
    const flood = Array.from({ length: 64 }, (_, index) =>
      frameMessage({
        type: "link-request",
        url: `https://a.example/${index}`,
        label: "x",
        ...IDENTITY,
      }),
    );
    await deliver(contents, flood, 500);
    const links = harness.events.filter((event) => event.type === "link-request");
    expect(links.length).toBeLessThanOrEqual(40);
    expect(host.snapshotDiagnostics().rejected["rate-limited"]).toBeGreaterThanOrEqual(24);
    expect(host.snapshotDiagnostics().rejected["shell-dropped"]).toBe(500);
  });

  test("link requests never open anything: the host only reports them", async () => {
    const { contents, harness } = await liveWithPump();
    await deliver(contents, [readyMessage()]);
    await deliver(contents, [
      frameMessage({
        type: "link-request",
        url: "https://example.com/",
        label: "Example",
        ...IDENTITY,
      }),
    ]);
    // The manager has no shell/openExternal dependency at all; the event is the only effect.
    expect(harness.events.at(-1)).toMatchObject({
      type: "link-request",
      href: "https://example.com/",
    });
    expect(harness.manager.activeHostId).toBe("host-1");
  });

  test("an unreachable shell closes the host", async () => {
    const { contents, harness } = await liveWithPump();
    contents.mainFrame.drains.shift()!.reject(new Error("Render frame was disposed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.events.at(-1)).toMatchObject({
      type: "navigation-blocked",
      reason: "shell-unreachable",
    });
  });
});

describe("artifact host lifecycle", () => {
  test("positions the view in DIPs, hides it at zero size, and never reloads on reposition", async () => {
    const harness = createHarness({ zoom: 2 });
    const { view, contents } = await openLive(harness);
    expect(view.bounds).toEqual({ x: 20, y: 40, width: 1200, height: 600 });
    expect(view.visible).toBe(true);
    harness.manager.setBounds("host-1", { x: 0, y: 0, width: 0, height: 120 });
    expect(view.visible).toBe(false);
    harness.manager.setBounds("host-1", { x: 5, y: 5, width: 100, height: 120 });
    expect(view.visible).toBe(true);
    harness.manager.setVisible("host-1", false);
    expect(view.visible).toBe(false);
    harness.manager.setVisible("host-1", true);
    harness.setHostZoom(1.5);
    harness.manager.setBounds("host-1", { x: 10, y: 10, width: 100, height: 100 });
    expect(view.bounds).toEqual({ x: 15, y: 15, width: 150, height: 150 });
    expect(contents.setZoomFactor).toHaveBeenLastCalledWith(1.5);
    // Calls for another host id are ignored.
    harness.manager.setBounds("host-2", { x: 0, y: 0, width: 1, height: 1 });
    expect(view.bounds).toEqual({ x: 15, y: 15, width: 150, height: 150 });
    expect(contents.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.views).toHaveLength(1);
  });

  test("reopening the same live document repositions it without a new view", async () => {
    const harness = createHarness();
    await openLive(harness);
    await expect(
      harness.manager.open(openInput({ bounds: { x: 1, y: 2, width: 3, height: 4 } })),
    ).resolves.toEqual({ ok: true });
    expect(harness.views).toHaveLength(1);
    expect(harness.views[0]!.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(harness.events).toEqual([]);
  });

  test("opening another artifact replaces the live host and reports closed: replaced", async () => {
    const harness = createHarness();
    const first = await openLive(harness);
    const second = await openLive(harness, { hostId: "host-2", generation: "gen_0002" });
    expect(harness.events).toEqual([{ hostId: "host-1", type: "closed", reason: "replaced" }]);
    expectTornDown(harness, first.view, first.session);
    expect(harness.manager.activeHostId).toBe("host-2");
    expect(second.view).not.toBe(first.view);
    expect(harness.sessions[1]!.partition).not.toBe(harness.sessions[0]!.partition);
    // Commands for the replaced id are ignored.
    harness.manager.close("host-1");
    expect(harness.manager.activeHostId).toBe("host-2");
  });

  test("a new document under the same host id replaces it silently", async () => {
    const harness = createHarness();
    await openLive(harness);
    await openLive(harness, { generation: "gen_0002" });
    expect(harness.views).toHaveLength(2);
    expect(harness.events).toEqual([]);
    expect(harness.manager.activeHostId).toBe("host-1");
  });

  test("close destroys the view and reports closed: requested", async () => {
    const harness = createHarness();
    const { view, session } = await openLive(harness);
    harness.manager.close("host-1");
    expect(harness.events).toEqual([{ hostId: "host-1", type: "closed", reason: "requested" }]);
    expectTornDown(harness, view, session);
    expect(view.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled();
  });

  test("a crashed renderer reports crashed and closed: crashed", async () => {
    const harness = createHarness();
    const { view, session, contents } = await openLive(harness);
    contents.emit("render-process-gone", {}, { reason: "oom", exitCode: 1 });
    expect(harness.events).toEqual([
      { hostId: "host-1", type: "crashed", reason: "oom" },
      { hostId: "host-1", type: "closed", reason: "crashed" },
    ]);
    expectTornDown(harness, view, session);
  });

  test("an unresponsive host is reported, and closing it terminates its renderer", async () => {
    const harness = createHarness();
    const { contents } = await openLive(harness);
    contents.emit("unresponsive");
    expect(harness.events).toEqual([{ hostId: "host-1", type: "unresponsive" }]);
    harness.manager.close("host-1");
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalled();
    expect(contents.close).toHaveBeenCalled();
    expect(contents.forcefullyCrashRenderer.mock.invocationCallOrder[0]!).toBeLessThan(
      contents.close.mock.invocationCallOrder[0]!,
    );
  });

  test("a hung artifact frame after readiness is reported unresponsive and closing terminates it", async () => {
    const harness = createHarness();
    const { session, contents } = await openLive(harness);
    const child = loadDocuments(session, contents);
    child.url = CONTENT_URL;
    contents.mainFrame.frames = [child];
    contents.emit("dom-ready");
    await Promise.resolve();
    contents.mainFrame.drains.shift()!.resolve({ messages: [readyMessage()], dropped: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.events.filter((event) => event.type === "unresponsive")).toEqual([]);
    child.hung = true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(harness.events.filter((event) => event.type === "unresponsive")).toEqual([
      { hostId: "host-1", type: "unresponsive" },
    ]);
    harness.manager.close("host-1");
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalled();
    expect(contents.close).toHaveBeenCalled();
  });

  test("window close destroys the host and refuses further opens", async () => {
    const harness = createHarness();
    const { view, session } = await openLive(harness);
    harness.manager.dispose();
    expect(harness.events).toEqual([{ hostId: "host-1", type: "closed", reason: "window-closed" }]);
    expectTornDown(harness, view, session);
    const result = await harness.manager.open(openInput({ hostId: "host-2" }));
    expect(result.ok).toBe(false);
    expect(harness.views).toHaveLength(1);
  });

  test("a destroyed window does not break teardown", async () => {
    const harness = createHarness();
    const { view } = await openLive(harness);
    harness.setWindowDestroyed(true);
    harness.manager.dispose();
    expect(harness.contentView.removeChildView).not.toHaveBeenCalled();
    expect(view.webContents.close).toHaveBeenCalled();
  });

  test("an Electron without the required session APIs reports unavailable", async () => {
    const harness = createHarness({ legacySession: true });
    const result = await harness.manager.open(openInput());
    expect(result).toEqual({
      ok: false,
      error: "This desktop build cannot host interactive artifacts",
    });
    expect(harness.views).toHaveLength(0);
    expect(harness.manager.activeHostId).toBeNull();
  });

  test("errors never echo the capability URL", async () => {
    const harness = createHarness();
    const result = await harness.manager.open(openInput({ contentUrl: "not a url cap_secret" }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("cap_secret");
  });
});

test("a content frame that never sends ready is terminated by the readiness deadline", async () => {
  const harness = createHarness();
  const { view, session, contents } = await openLive(harness);
  loadDocuments(session, contents);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(harness.events.some((event) => event.type === "unresponsive")).toBe(true);
  expect(contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
  expectTornDown(harness, view, session);
});

test("native focus restoration requires a live, visible artifact host", async () => {
  const harness = createHarness();
  const { contents } = await openLive(harness);
  const host = harness.manager.activeHost()!;
  expect(host.focusIfVisible()).toBe(true);
  expect(contents.focus).toHaveBeenCalledTimes(1);
  host.setVisible(false);
  expect(host.focusIfVisible()).toBe(false);
  host.setVisible(true);
  expect(host.focusIfVisible()).toBe(true);
  harness.manager.close(host.hostId);
  expect(host.focusIfVisible()).toBe(false);
});
