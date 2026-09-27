/**
 * Shared fakes for BrowserPreviewManager capture tests: a web contents that
 * answers the capture, pins, settle, and responsive scripts from test state,
 * a fake native image with a readable bitmap, and a manager over a real spool.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, mock } from "bun:test";
import type { BrowserPreviewCaptureEvent } from "@orkestrator/protocol/browser-preview";
import { fixtureAnchor, fixtureTargets } from "@orkestrator/protocol/web-annotations-fixtures";
import {
  BrowserPreviewManager,
  type BrowserPreviewManagerOptions,
} from "../../../apps/desktop/electron/browser-preview-manager";
import {
  BrowserPreviewCaptureStore,
  type BrowserPreviewCaptureStoreOptions,
} from "../../../apps/desktop/electron/browser-preview-capture-store";
import type { CaptureStoreLike } from "../../../apps/desktop/electron/browser-preview-capture";
import { pngDataUrl } from "./png-fixture";

export type Json = Record<string, any>;
export type Config = { captureId: string; nonce: string; mode: string; initialTarget?: unknown };

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

export function fakeImage(width: number, height: number, bitmap?: Buffer): Json {
  return {
    width,
    height,
    bitmap,
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth, height: nextHeight }: { width: number; height: number }) =>
      fakeImage(nextWidth, nextHeight),
    toDataURL: () => pngDataUrl(width, height),
    toBitmap: () => bitmap ?? Buffer.alloc(width * height * 4, 0xff),
    crop: (rect: { x: number; y: number; width: number; height: number }) =>
      fakeImage(rect.width, rect.height),
  };
}

export const VIEWPORT = { width: 800, height: 500 };
export const elementSelection = () => ({
  target: fixtureTargets.element,
  evidence: {
    text: "Save",
    attributes: { type: "submit", "data-testid": "save-settings" },
    styles: { "font-size": "12px" },
    hierarchy: fixtureAnchor.ancestors,
    html: '<button type="submit" data-testid="save-settings">Save</button>',
  },
  redaction: { attributesRemoved: 2, valuesMasked: 1, urlParametersRemoved: 1 },
  title: "Title reported by the page",
  viewport: VIEWPORT,
  scroll: { x: 0, y: 120 },
  devicePixelRatio: 2,
});

export class CaptureContents extends EventEmitter {
  currentUrl = "";
  title = "Settings";
  zoom = 1.25;
  destroyed = false;
  config: Config | null = null;
  selection: Json | null = null;
  rawStatus: ((config: Config) => unknown) | null = null;
  probes: Array<Json | null> = [];
  probe: Json = {
    connected: true,
    rect: { x: 640, y: 480, width: 72, height: 28 },
    viewport: VIEWPORT,
    scroll: { x: 0, y: 120 },
    devicePixelRatio: 2,
    sensitive: [{ x: 10, y: 10, width: 100, height: 20 }],
  };
  image = { width: 1_600, height: 1_000 };
  /** Simulate a native image whose pixels cannot be read back for masking. */
  bitmapUnavailable = false;
  onCapture: () => void = () => undefined;
  pinsResponse: (queries: Json[]) => unknown = () => "[]";
  pinsConfig: Json | null = null;
  /** Answer to the pins snapshot script (live re-resolution). */
  pinsSnapshot: unknown = null;
  /** Answer to the result-capture settle script; null means "no runtime". */
  settle: { stable: boolean; fontsReady: boolean } | null = { stable: true, fontsReady: true };
  settleCalls = 0;
  /** Answer to the responsive probe script at the current emulated width. */
  responsiveProbe: (width: number | null) => Json | null = (width) => ({
    viewport: { width: width ?? VIEWPORT.width, height: VIEWPORT.height },
    scroll: { x: 0, y: 0 },
    devicePixelRatio: 2,
    sensitive: [],
    rect: null,
    state: "none",
    stable: true,
  });
  emulation: Json | null = null;
  readonly emulations: Json[] = [];
  readonly scripts: string[] = [];
  /** When set, `loadURL` never settles (a hung navigation). */
  hangLoads = false;
  /** Where a navigation actually lands (e.g. a login redirect); defaults to the URL. */
  redirect: ((url: string) => string) | null = null;
  readonly loadURL = mock(async (url: string) => {
    if (this.hangLoads) return new Promise<void>(() => undefined);
    this.currentUrl = this.redirect ? this.redirect(url) : url;
    this.emit("did-stop-loading");
  });
  readonly reload = mock(() => undefined);
  readonly focus = mock(() => undefined);
  readonly setWindowOpenHandler = mock(() => undefined);
  readonly close = mock(() => {
    this.destroyed = true;
  });
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
  };
  readonly enableDeviceEmulation = mock((parameters: Json) => {
    this.emulation = parameters;
    this.emulations.push(parameters);
  });
  readonly disableDeviceEmulation = mock(() => {
    this.emulation = null;
  });
  readonly executeJavaScript = mock(async (script: string) => this.run(script));
  readonly capturePage = mock(async () => {
    this.onCapture();
    const width = this.emulation ? Number(this.emulation.viewSize.width) * 2 : this.image.width;
    const image = fakeImage(width, this.image.height);
    if (this.bitmapUnavailable) delete image.toBitmap;
    return image;
  });

  private nextProbe(): string | null {
    const probe = this.probes.length > 0 ? this.probes.shift()! : this.probe;
    if (!probe || !this.config) return null;
    return JSON.stringify({ captureId: this.config.captureId, nonce: this.config.nonce, ...probe });
  }

  private selected(config: Config) {
    const { initialTarget: _initial, ...bound } = config;
    return JSON.stringify({ v: 1, ...bound, status: "selected", selection: this.selection });
  }

  private bound(config: Config) {
    const { initialTarget: _initial, ...bound } = config;
    return bound;
  }

  run(script: string): unknown {
    this.scripts.push(script.slice(0, 40));
    if (script.startsWith("/*orkestrator:capture-start*/")) {
      const payload = JSON.parse(
        /, (\{"key":"__orkestratorCaptureRuntime__".*\})\);$/s.exec(script)![1]!,
      );
      this.config = {
        captureId: payload.captureId,
        nonce: payload.nonce,
        mode: payload.mode,
        initialTarget: payload.initialTarget,
      };
      if (payload.mode === "page") {
        this.selection = {
          target: { kind: "page", label: "Whole page" },
          evidence: null,
          redaction: { attributesRemoved: 0, valuesMasked: 0, urlParametersRemoved: 0 },
          title: "Page",
          viewport: VIEWPORT,
          scroll: { x: 0, y: 0 },
          devicePixelRatio: 2,
        };
        return this.selected(this.config);
      }
      return JSON.stringify({ v: 1, ...this.bound(this.config), status: "selecting" });
    }
    if (script.startsWith("/*orkestrator:capture-status*/")) {
      if (!this.config) return JSON.stringify({ status: "inactive" });
      if (this.rawStatus) return this.rawStatus(this.config);
      if (this.selection) return this.selected(this.config);
      return JSON.stringify({ v: 1, ...this.bound(this.config), status: "selecting" });
    }
    if (script.startsWith("/*orkestrator:capture-settle*/")) {
      this.settleCalls += 1;
      if (!this.config || !this.settle) return null;
      return JSON.stringify({
        captureId: this.config.captureId,
        nonce: this.config.nonce,
        ...this.settle,
        waitedMs: 10,
      });
    }
    if (script.startsWith("/*orkestrator:capture-prepare*/")) return this.nextProbe();
    if (script.startsWith("/*orkestrator:capture-probe*/")) return this.nextProbe();
    if (script.startsWith("/*orkestrator:capture-cancel*/")) {
      this.config = null;
      return undefined;
    }
    if (script.startsWith("/*orkestrator:pins-show*/")) {
      this.pinsConfig = JSON.parse(
        /, (\{"key":"__orkestratorPreviewPins__".*\})\);$/s.exec(script)![1]!,
      );
      return this.pinsResponse(this.pinsConfig!.queries);
    }
    if (script.startsWith("/*orkestrator:pins-snapshot*/")) return this.pinsSnapshot;
    if (script.startsWith("/*orkestrator:responsive-probe*/")) {
      const probe = this.responsiveProbe(
        this.emulation ? Number(this.emulation.viewSize.width) : null,
      );
      return probe ? JSON.stringify(probe) : null;
    }
    return undefined;
  }

  getURL() {
    return this.currentUrl;
  }
  getTitle() {
    return this.title;
  }
  getZoomFactor() {
    return this.zoom;
  }
  isDestroyed() {
    return this.destroyed;
  }
  /** Simulate an in-page (route) navigation of the main frame. */
  navigateInPage(url: string) {
    this.currentUrl = url;
    this.emit("did-navigate-in-page", {}, url, true);
  }
  /** Simulate a same-URL reload: start navigation and loading, then finish. */
  reloadDocument() {
    this.emit("did-start-loading");
    this.emit("did-start-navigation", { isMainFrame: true });
    this.emit("did-navigate", {}, this.currentUrl);
  }
  finishLoading() {
    this.emit("did-stop-loading");
  }
}

export interface HarnessOptions {
  perPreview?: number;
  isolatedWorld?: boolean;
  /** Wrap the real spool (e.g. to inject write failures). */
  wrapStore?: (store: BrowserPreviewCaptureStore) => CaptureStoreLike;
  storeOptions?: Partial<BrowserPreviewCaptureStoreOptions>;
  manager?: Partial<BrowserPreviewManagerOptions>;
  /** Provide `createFromBuffer` for region crops. */
  cropping?: boolean;
}

export function createHarness(options: HarnessOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "orkestrator-capture-manager-"));
  directories.push(root);
  const views: FakeView[] = [];
  class FakeView {
    readonly webContents = new CaptureContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
    readonly setBackgroundColor = mock(() => undefined);
    readonly setBounds = mock((bounds: typeof this.bounds) => {
      this.bounds = bounds;
    });
    readonly getBounds = mock(() => this.bounds);
    readonly setVisible = mock((visible: boolean) => {
      this.visible = visible;
    });
    readonly getVisible = mock(() => this.visible);
    constructor() {
      if (options.isolatedWorld) {
        const contents = this.webContents as CaptureContents & Json;
        contents.executeJavaScriptInIsolatedWorld = mock(
          async (_world: number, scripts: Array<{ code: string }>) =>
            contents.run(scripts[0]!.code),
        );
      }
      views.push(this);
    }
  }
  const events: BrowserPreviewCaptureEvent[] = [];
  const bitmaps: Buffer[] = [];
  const realStore = new BrowserPreviewCaptureStore({
    directory: path.join(root, "spool"),
    limits: options.perPreview ? { perPreview: options.perPreview } : {},
    ...options.storeOptions,
  });
  const store = options.wrapStore ? options.wrapStore(realStore) : realStore;
  const hostFocus = mock(() => undefined);
  const window = {
    isDestroyed: () => false,
    contentView: { addChildView: mock(() => undefined), removeChildView: mock(() => undefined) },
    webContents: { getZoomFactor: () => 1, focus: hostFocus },
  };
  const manager = new BrowserPreviewManager({
    WebContentsViewCtor: FakeView as never,
    browserSession: { id: "preview-session" } as never,
    menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
    getWindow: () => window as never,
    emitState: () => undefined,
    emitOpenLink: () => undefined,
    openExternal: () => undefined,
    writeClipboardText: () => undefined,
    focusAddressBar: () => undefined,
    captureStore: store,
    emitCaptureEvent: (event) => events.push(event),
    nativeImage: {
      createFromBitmap: (buffer: Buffer, size: { width: number; height: number }) => {
        bitmaps.push(buffer);
        return fakeImage(size.width, size.height, buffer) as never;
      },
      ...(options.cropping ? { createFromBuffer: () => fakeImage(1_600, 1_000) as never } : {}),
    },
    capturePollIntervalMs: 0,
    pins: { livePollIntervalMs: 0, sleep: async () => undefined },
    stability: { deadlineMs: 10, quietMs: 1 },
    now: () => Date.parse("2026-09-24T10:00:00.000Z"),
    ...options.manager,
  });
  const attach = async (
    url = "http://localhost:5173/settings?tab=profile&token=synthetic-token-value",
  ) => {
    await manager.attach({
      tabId: "browser-1",
      url,
      bounds: { x: 0, y: 0, width: 800, height: 500 },
      visible: true,
    });
    return views.at(-1)!.webContents;
  };
  return { manager, store: realStore, events, bitmaps, views, attach, hostFocus, window };
}

export const start = (
  manager: BrowserPreviewManager,
  mode: "element" | "text" | "region" | "page" = "element",
  extra: Json = {},
) => manager.startCapture({ tabId: "browser-1", mode, environmentId: "env-fixture", ...extra });
