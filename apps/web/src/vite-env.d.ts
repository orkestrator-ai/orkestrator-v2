/// <reference types="vite/client" />

interface Window {
  __orkestratorClientPlatform?:
    "desktop-browser" | "ios-wkwebview" | "ipad-wkwebview" | "iphone-wkwebview";
  orkestratorGateway?: {
    enabled: boolean;
    /** True when gateway metadata was supplied by the Electron preload. */
    desktop?: boolean;
    /** Backend origin used when the renderer was loaded from a separate host. */
    baseUrl?: string;
    /**
     * Electron only: the current origin of the window's machine. A tunnelled
     * route's local port can change after a reconnect, so direct URLs call
     * this instead of keeping `baseUrl` from page load.
     */
    resolveBaseUrl?: () => string;
  };
  /**
   * Electron only: the machine this renderer is bound to, for presentation
   * storage namespaces. Never a route, port or credential.
   */
  /**
   * The command node this client is connected to, while the window's
   * workspace (`orkestrator`) is on another node. Only the portal layer uses
   * it; see `lib/portal/portal-transport.ts`.
   */
  orkestratorPortal?: {
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen<T = unknown>(event: string, callback: (payload: T) => void): () => void;
    eventStreamReady?(event: string): Promise<void>;
  };
  /** The node the window's workspace is on, when it is not the command node. */
  orkestratorWorkspaceTarget?: {
    nodeId: string;
    nodeName: string;
    path: "direct" | "relay";
    routeKind?: "https" | "ssh";
    via?: string;
  };
  orkestratorDesktopIdentity?: {
    connectionId: string;
    backendId: string | null;
    legacyOrigin: string | null;
    /** The window's own machine, while its workspace is on another node. */
    portal?: { connectionId: string; backendId: string | null; legacyOrigin: string | null };
  };
  orkestrator?: {
    /** Electron owns physical shortcut input and restores native-view focus. */
    keyboardShortcuts?: { closed(): Promise<void> };
    /** Electron windows keep focus and renderer storage independent. */
    isolatedViewState?: true;
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen<T = unknown>(event: string, callback: (payload: T) => void): () => void;
    /** Browser gateway only: resolves once the event's filtered stream is live. */
    eventStreamReady?(event: string): Promise<void>;
    /**
     * Browser gateway only: whether the authoritative main event stream is up.
     * Electron reports transport state through `connections` instead.
     */
    eventStreamConnection?: {
      state(): import("@/lib/native/web-gateway").GatewayEventStreamConnectionState;
      subscribe(
        listener: (
          state: import("@/lib/native/web-gateway").GatewayEventStreamConnectionState,
        ) => void,
      ): () => void;
    };
    clipboard: {
      readText(): Promise<string>;
      writeText(text: string): Promise<void>;
      readImage(): Promise<{
        width: number;
        height: number;
        /** Electron transport. Browser gateways return the original Blob. */
        dataUrl?: string;
        /** Browser-only transport, retained to allow bounded bitmap decoding. */
        blob?: Blob;
      } | null>;
      writeImage(dataUrl: string): Promise<void>;
    };
    /** Electron only: opens web URLs with the client operating system. */
    shell?: {
      openExternal(url: string): Promise<void>;
    };
    /** Electron only: checks protected macOS folders before agent work begins. */
    permissions?: {
      getMacOsStatus(): Promise<
        import("@orkestrator/protocol/macos-permissions").MacOsPermissionsStatus
      >;
      openMacOsSettings(
        pane: import("@orkestrator/protocol/macos-permissions").MacOsPrivacySettingsPane,
      ): Promise<void>;
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
      probe(connectionId: string): Promise<boolean>;
      connect(
        input: import("@orkestrator/protocol/connections").ConnectToRemoteInput,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      updateToken(
        connectionId: string,
        token: string,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      /** Sets a display nickname; `null` or a blank value restores the hostname. */
      rename?(
        connectionId: string,
        nickname: string | null,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      use(
        connectionId: string,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      /** Electron only: what making a machine the command node would hand over. */
      previewCommandHandover?(
        targetConnectionId: string,
      ): Promise<import("@orkestrator/protocol/command-nodes").CommandHandoverPreviewResult>;
      /** Electron only: make a machine the command node and switch this window to it. */
      handOverCommand?(input: {
        targetConnectionId: string;
        nodeIds?: string[];
        connectionIds: string[];
        includeSelf: boolean;
        confirmation?: import("@orkestrator/protocol/command-nodes").CommandHandoverConfirmation;
      }): Promise<import("@orkestrator/protocol/command-nodes").CommandHandoverResult | null>;
      forget(
        connectionId: string,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      /** Electron only: opens a saved connection without switching this renderer. */
      openWindow?(connectionId: string): Promise<void>;
      /** Electron only (qualified platforms): adds a managed SSH route. */
      connectSsh?(
        input: import("@orkestrator/protocol/connections").ConnectSshRouteInput,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      probeSshHostKey?(input: { destination: string; sshPort?: number }): Promise<{
        probeId: string;
        destination: string;
        fingerprints: Array<{ type: string; fingerprint: string }>;
      }>;
      trustSshHostKey?(probeId: string): Promise<{ added: number }>;
      removeRoute?(
        connectionId: string,
        routeId: string,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      setRouteOrder?(
        connectionId: string,
        routeIds: string[],
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      setRouteEnabled?(
        connectionId: string,
        routeId: string,
        enabled: boolean,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      useRoute?(
        connectionId: string,
        routeId: string,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      setAutoConnect?(
        connectionId: string,
        autoConnect: boolean,
      ): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      setFeatures?(features: {
        federation?: boolean;
        sshRoutes?: boolean;
        routeFallback?: boolean;
      }): Promise<import("@orkestrator/protocol/connections").ConnectionList>;
      answerSshPrompt?(promptId: string, answer: string | null): void;
    };
    /**
     * Electron only: workspace realms of other nodes in this window's central
     * region (see `lib/federation/workspace-realm.ts`). The main process binds
     * each to its node; the window only places it and passes messages.
     */
    workspaceViews?: {
      open(input: {
        nodeId: string;
        request: Omit<import("@/lib/federation/workspace-realm").RealmSelectRequest, "type">;
      }): Promise<{ viewId: string }>;
      setBounds(
        viewId: string,
        bounds: { x: number; y: number; width: number; height: number },
      ): Promise<void>;
      setVisible(viewId: string, visible: boolean): Promise<void>;
      /** A still of the realm (a data URL), shown while one of the window's overlays covers it. */
      capture(viewId: string): Promise<string | null>;
      send(
        viewId: string,
        message: import("@/lib/federation/workspace-realm").ShellToRealmMessage,
      ): Promise<void>;
      close(viewId: string): Promise<void>;
      onEvent(
        callback: (
          event:
            | { viewId: string; type: "message"; message: unknown }
            | { viewId: string; type: "closed" | "crashed" | "load-failed" },
        ) => void,
      ): () => void;
    };
    /** Electron only, in a workspace realm: messages to and from its window. */
    workspaceRealm?: {
      post(message: import("@/lib/federation/workspace-realm").RealmToShellMessage): void;
      onMessage(callback: (message: unknown) => void): () => void;
    };
    process: {
      exit(code?: number): Promise<void>;
      /** Electron only: relaunches the application to recover owned services. */
      restart?(): Promise<void>;
    };
    window: {
      startDragging(): Promise<void>;
      /** Electron only. Browser gateway implementations return false. */
      setZoomFactor?(factor: number): Promise<boolean>;
    };
    /** Electron only: the sandboxed live host for interactive transcript artifacts. */
    artifactHost?: import("@orkestrator/protocol/artifact-host-ipc").ArtifactHostApi;
    browserPreview?: {
      attach(
        input: import("@orkestrator/protocol/browser-preview").BrowserPreviewAttachInput,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      setBounds(
        tabId: string,
        bounds: import("@orkestrator/protocol/browser-preview").BrowserPreviewBounds,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      setVisible(
        tabId: string,
        visible: boolean,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState | null>;
      navigate(
        tabId: string,
        url: string,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      goBack(
        tabId: string,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      goForward(
        tabId: string,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      reload(
        tabId: string,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      openDevTools(
        tabId: string,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      /**
       * Trusted web annotation capture (selection, pending spool, pins).
       * Present only on desktop builds that implement it; feature-detect.
       */
      capture?: import("@orkestrator/protocol/browser-preview").BrowserPreviewCaptureApi;
      destroy(tabId: string): Promise<void>;
      /** Present on desktop builds with service previews. */
      resetServiceSiteData?(
        target: import("@orkestrator/protocol/browser-preview").BrowserPreviewServiceTarget,
      ): Promise<void>;
      /** Present on desktop builds with private preview publication. */
      openServiceExternally?(
        target: import("@orkestrator/protocol/browser-preview").BrowserPreviewServiceTarget,
      ): Promise<void>;
    };
  };
}
