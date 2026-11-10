/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by a production build of `apps/web`; see `vite-plugin-renderer-security.ts`. */
  readonly ORKESTRATOR_DESIGN_FRAME_DOCUMENT?: string;
  /** Set by a production build of `apps/web`; the static HTML presentation frame. */
  readonly ORKESTRATOR_STATIC_HTML_FRAME_DOCUMENT?: string;
  /** `"unavailable"` in a build whose hosting policy cannot run the frame. */
  readonly ORKESTRATOR_STATIC_HTML_PRESENTATION?: string;
  /** The dev launcher's profile flavor (`development` or `agent-test`); unset in builds. */
  readonly VITE_ORKESTRATOR_PROFILE_FLAVOR?: string;
}

interface Window {
  __orkestratorClientPlatform?:
    "desktop-browser" | "ios-wkwebview" | "ipad-wkwebview" | "iphone-wkwebview";
  orkestratorGateway?: {
    enabled: boolean;
    /** True when gateway metadata was supplied by the Electron preload. */
    desktop?: boolean;
    /**
     * Electron only: the gateway leads back to this computer's own backend, as
     * when a command node on another machine shows this computer as a leaf.
     */
    backendOnThisDevice?: boolean;
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
  orkestratorDesktopIdentity?: {
    connectionId: string;
    backendId: string | null;
    legacyOrigin: string | null;
    /**
     * This computer's own backend installation id, null until known: a node
     * is on this device exactly when its id equals this
     * (`backendOnThisDevice(nodeId)` in `lib/gateway-url.ts`).
     */
    localInstallationId?: string | null;
  };
  /**
   * Electron only, on a local window using the direct gateway transport: the
   * preload's API and the backend's origin, never a credential. `web-gateway`
   * composes `orkestrator` from them.
   */
  orkestratorDesktopHost?: {
    api: NonNullable<Window["orkestrator"]>;
    baseUrl: string;
  };
  orkestrator?: {
    /** Electron owns physical shortcut input and restores native-view focus. */
    keyboardShortcuts?: { closed(): Promise<void> };
    /** Electron windows keep focus and renderer storage independent. */
    isolatedViewState?: true;
    /** Electron also takes `{ nodeId?, envelope? }`; an absent `nodeId` is the command node. */
    invoke<T = unknown>(
      command: string,
      args?: Record<string, unknown>,
      options?: { nodeId?: string; envelope?: Record<string, unknown> },
    ): Promise<T>;
    /**
     * Browser gateway (and a local desktop window on the direct gateway
     * transport) only: the command node's hello, `null` when it answered
     * none (plan item 2011). Electron's IPC windows read it from
     * `nodes.gateway(commandNodeId)` instead.
     */
    hello?(): Promise<unknown>;
    /**
     * Electron only: another node through this window's scope on it. Refusals
     * lead their message with `[code] ` (`unknown-node`, `node-scope-closed`, ...;
     * `@orkestrator/protocol/contract/node-refusal`).
     */
    node?(nodeId: string): {
      readonly nodeId: string;
      invoke<T = unknown>(
        command: string,
        args?: Record<string, unknown>,
        options?: { envelope?: Record<string, unknown> },
      ): Promise<T>;
      listen<T = unknown>(event: string, callback: (payload: T) => void): () => void;
      eventStreamReady(event: string): Promise<void>;
      eventStreamConnection: {
        state(): "idle" | "connecting" | "connected" | "disconnected";
        subscribe(
          listener: (state: "idle" | "connecting" | "connected" | "disconnected") => void,
        ): () => void;
      };
    };
    /** Electron only: release and read a node scope's snapshot (`node(id)` opens it). */
    nodes?: {
      release(nodeId: string): Promise<void>;
      gateway(nodeId: string): Promise<unknown>;
    };
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
    /** Electron only: captures this page for the Report a bug sheet. */
    bugReport?: {
      captureWindow(): Promise<string>;
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
    process: {
      exit(code?: number): Promise<void>;
      /** Electron only: relaunches the application to recover owned services. */
      restart?(): Promise<void>;
    };
    window: {
      startDragging(): Promise<void>;
      /** Electron only. Browser gateway implementations return false. */
      setZoomFactor?(factor: number): Promise<boolean>;
      /**
       * Electron only: this renderer's `orkestrator:debug` preference, so the
       * Help menu offers Open Developer Tools while it is on.
       */
      setRendererDebugLogging?(enabled: boolean): Promise<boolean>;
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
      /** Present on desktop builds that can copy a browser sign-in into a preview. */
      startSessionImport?(
        tabId: string,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      dismissSessionNotice?(
        tabId: string,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
      openServiceSignIn?(
        tabId: string,
        port: number,
      ): Promise<import("@orkestrator/protocol/browser-preview").BrowserPreviewState>;
    };
  };
}
