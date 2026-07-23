/// <reference types="vite/client" />

interface Window {
  orkestratorGateway?: {
    enabled: boolean;
    /** True when gateway metadata was supplied by the Electron preload. */
    desktop?: boolean;
    /** Backend origin used when the renderer was loaded from a separate host. */
    baseUrl?: string;
  };
  orkestrator?: {
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen<T = unknown>(event: string, callback: (payload: T) => void): () => void;
    clipboard: {
      readText(): Promise<string>;
      writeText(text: string): Promise<void>;
      readImage(): Promise<{ width: number; height: number; dataUrl: string } | null>;
      writeImage(dataUrl: string): Promise<void>;
    };
    dialog: {
      open(options?: {
        directory?: boolean;
        multiple?: boolean;
        title?: string;
        defaultPath?: string;
      }): Promise<string | string[] | null>;
    };
    webClient?: {
      getStatus(): Promise<import("./types/webClient").WebClientStatus>;
      setEnabled(enabled: boolean): Promise<import("./types/webClient").WebClientStatus>;
      resetServe(): Promise<import("./types/webClient").WebClientStatus>;
      getTokenSettings(): Promise<import("./types/webClient").GatewayTokenSettings>;
      setToken(token: string): Promise<import("./types/webClient").GatewayTokenSettings>;
    };
    connections?: {
      list(): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      connect(input: import("@orkestrator/protocol/connections").ConnectToRemoteInput): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      use(connectionId: string): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      forget(connectionId: string): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
    };
    process: {
      exit(code?: number): Promise<void>;
    };
    window: {
      startDragging(): Promise<void>;
    };
    browserPreview?: {
      attach(input: import("@orkestrator/protocol/browser-preview").BrowserPreviewAttachInput): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      setBounds(tabId: string, bounds: import("@orkestrator/protocol/browser-preview").BrowserPreviewBounds): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      setVisible(tabId: string, visible: boolean): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState | null>;
      navigate(tabId: string, url: string): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      goBack(tabId: string): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      goForward(tabId: string): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      reload(tabId: string): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      openDevTools(tabId: string): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      destroy(tabId: string): Promise<void>;
    };
  };
}
