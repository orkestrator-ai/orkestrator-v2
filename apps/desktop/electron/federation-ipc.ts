import type { ConnectSshRouteInput, ConnectionList } from "@orkestrator/protocol/connections";
import type { FederationFeatureFlags } from "@orkestrator/protocol/device-catalogue";
import { isTrustedRendererUrl } from "./window.js";
import type { WorkspaceViewBounds, WorkspaceViewOpenInput } from "./workspace-views.js";

/**
 * IPC for the multi-machine client: managed SSH routes, route management,
 * workspace realms (other nodes' workspaces in a window's central region) and
 * the portal channel of a realm to its window's command node. Every
 * destination is one the main process resolves for the requesting renderer;
 * the renderer never supplies a URL, a credential or an SSH command line.
 */

/** Events of a realm's command node (its window's own connection). */
export const PORTAL_EVENT_CHANNEL = "orkestrator:portal-event";

type IpcEventLike = {
  senderFrame?: { url: string } | null;
  sender?: { id: number };
};

type IpcMainLike = {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  on?(
    channel: string,
    listener: (event: IpcEventLike & { returnValue: unknown }, ...args: unknown[]) => void,
  ): void;
};

export type HostKeyProbe = {
  probeId: string;
  destination: string;
  fingerprints: Array<{ type: string; fingerprint: string }>;
};

export type GatewaySnapshot = {
  baseUrl: string | null;
  connectionId: string;
  backendId: string | null;
  legacyOrigin: string | null;
  /** A workspace realm's node. */
  workspaceTarget?: {
    nodeId: string;
    nodeName: string;
    path: "direct" | "relay";
    routeKind?: "https" | "ssh";
    via?: string;
  };
  /** A realm's window's own machine. */
  portalIdentity?: { connectionId: string; backendId: string | null; legacyOrigin: string | null };
};

export type FederationIpcDependencies = {
  ipc: IpcMainLike;
  trustedRendererUrl: string;
  gatewaySnapshot(event: IpcEventLike): GatewaySnapshot;
  connectSsh(event: IpcEventLike, input: ConnectSshRouteInput): Promise<ConnectionList>;
  probeSshHostKey(
    event: IpcEventLike,
    input: { destination: string; sshPort?: number },
  ): Promise<HostKeyProbe>;
  trustSshHostKey(event: IpcEventLike, probeId: string): Promise<{ added: number }>;
  removeRoute(event: IpcEventLike, connectionId: string, routeId: string): Promise<ConnectionList>;
  setRouteOrder(
    event: IpcEventLike,
    connectionId: string,
    routeIds: string[],
  ): Promise<ConnectionList>;
  setRouteEnabled(
    event: IpcEventLike,
    connectionId: string,
    routeId: string,
    enabled: boolean,
  ): Promise<ConnectionList>;
  useRoute(event: IpcEventLike, connectionId: string, routeId: string): Promise<ConnectionList>;
  setAutoConnect(
    event: IpcEventLike,
    connectionId: string,
    autoConnect: boolean,
  ): Promise<ConnectionList>;
  setFeatures(
    event: IpcEventLike,
    features: Partial<FederationFeatureFlags>,
  ): Promise<ConnectionList>;
  openWorkspaceView(
    event: IpcEventLike,
    input: WorkspaceViewOpenInput,
  ): Promise<{ viewId: string }>;
  setWorkspaceViewBounds(event: IpcEventLike, viewId: string, bounds: WorkspaceViewBounds): void;
  setWorkspaceViewVisible(event: IpcEventLike, viewId: string, visible: boolean): void;
  captureWorkspaceView(event: IpcEventLike, viewId: string): Promise<string | null>;
  sendToWorkspaceView(event: IpcEventLike, viewId: string, message: Record<string, unknown>): void;
  closeWorkspaceView(event: IpcEventLike, viewId: string): void;
  postFromWorkspaceRealm(event: IpcEventLike, message: Record<string, unknown>): void;
  portalInvoke(
    event: IpcEventLike,
    command: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
};

const MAX_ID_LENGTH = 256;

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Errors cross IPC as plain messages. A typed failure keeps its code as a
 * bracketed prefix so the renderer can offer the right recovery (approve a
 * host key, enter a token) without parsing prose.
 */
export function withErrorCode<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof Error && typeof code === "string" && /^[a-z][a-z-]{1,40}$/.test(code)) {
      throw new Error(`[${code}] ${error.message}`, { cause: error });
    }
    throw error;
  });
}

/** What a realm opens on: only known selection fields ever reach its URL. */
function realmSearch(request: Record<string, unknown>): Record<string, string> {
  const search: Record<string, string> = {};
  const optionalId = (value: unknown, label: string) =>
    value === undefined ? undefined : id(value, label);
  const projectId = optionalId(request.projectId, "a project ID");
  const environmentId = optionalId(request.environmentId, "an environment ID");
  const createEnvironment = optionalId(request.createEnvironmentProjectId, "a project ID");
  if (projectId) search.project = projectId;
  if (projectId && environmentId) search.environment = environmentId;
  if (
    projectId &&
    (request.boardTab === "coordinator" ||
      request.boardTab === "kanban" ||
      request.boardTab === "github" ||
      request.boardTab === "linear" ||
      request.boardTab === "features")
  )
    search.boardTab = request.boardTab;
  if (request.addProject === true) search.addProject = "1";
  if (createEnvironment) search.createEnvironment = createEnvironment;
  if (
    projectId &&
    (request.dialog === "repository-settings" ||
      request.dialog === "delete-project" ||
      (request.dialog === "environment-settings" && environmentId))
  )
    search.dialog = request.dialog;
  return search;
}

function viewBounds(value: unknown): WorkspaceViewBounds {
  const input = record(value, "bounds");
  const coordinate = (field: unknown, label: string) => {
    if (typeof field !== "number" || !Number.isFinite(field) || Math.abs(field) > 100_000) {
      throw new Error(`Expected ${label} to be a number`);
    }
    return field;
  };
  return {
    x: coordinate(input.x, "x"),
    y: coordinate(input.y, "y"),
    width: Math.max(0, coordinate(input.width, "width")),
    height: Math.max(0, coordinate(input.height, "height")),
  };
}

/** Messages between a window and its realms are small; each side parses its own. */
function boundedMessage(value: unknown): Record<string, unknown> {
  const message = record(value, "a message");
  if (JSON.stringify(message).length > 4096) throw new Error("Message too large");
  return message;
}

export function registerFederationIpc(deps: FederationIpcDependencies): void {
  const isTrustedSender = (event: IpcEventLike) =>
    isTrustedRendererUrl(event.senderFrame?.url ?? "", deps.trustedRendererUrl);
  const handle = (
    channel: string,
    listener: (event: IpcEventLike, ...args: unknown[]) => unknown,
  ) => {
    deps.ipc.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event))
        throw new Error("Blocked IPC request from an untrusted renderer");
      return listener(event, ...args);
    });
  };

  deps.ipc.on?.("orkestrator:connections:gateway-sync", (event) => {
    if (!isTrustedSender(event)) {
      event.returnValue = null;
      return;
    }
    try {
      event.returnValue = deps.gatewaySnapshot(event);
    } catch {
      event.returnValue = null;
    }
  });

  handle("orkestrator:connections:connect-ssh", (event, value) => {
    const input = record(value, "SSH route details");
    const {
      destination,
      sshPort,
      identityFile,
      remoteGatewayPort,
      token,
      nickname,
      connectionId,
      select,
    } = input;
    if (typeof destination !== "string" || typeof token !== "string") {
      throw new Error("Expected an SSH destination and gateway token");
    }
    if (typeof remoteGatewayPort !== "number" && typeof remoteGatewayPort !== "string") {
      throw new Error("Expected the remote gateway port");
    }
    const optionalString = (field: unknown, label: string) => {
      if (field === undefined || field === null || field === "") return undefined;
      if (typeof field !== "string") throw new Error(`Expected ${label} to be a string`);
      return field;
    };
    return withErrorCode(() =>
      deps.connectSsh(event, {
        destination,
        token,
        remoteGatewayPort: Number(remoteGatewayPort),
        ...(select === true ? { select: true } : {}),
        ...(sshPort === undefined || sshPort === null || sshPort === ""
          ? {}
          : { sshPort: Number(sshPort) }),
        ...(optionalString(identityFile, "the identity file")
          ? { identityFile: optionalString(identityFile, "the identity file")! }
          : {}),
        ...(optionalString(nickname, "the nickname")
          ? { nickname: optionalString(nickname, "the nickname")! }
          : {}),
        ...(optionalString(connectionId, "the connection ID")
          ? { connectionId: optionalString(connectionId, "the connection ID")! }
          : {}),
      }),
    );
  });
  handle("orkestrator:connections:ssh-probe-host-key", (event, value) => {
    const input = record(value, "SSH host details");
    if (typeof input.destination !== "string") throw new Error("Expected an SSH destination");
    return withErrorCode(() =>
      deps.probeSshHostKey(event, {
        destination: input.destination as string,
        ...(input.sshPort === undefined || input.sshPort === null || input.sshPort === ""
          ? {}
          : { sshPort: Number(input.sshPort) }),
      }),
    );
  });
  handle("orkestrator:connections:ssh-trust-host-key", (event, probeId) =>
    withErrorCode(() => deps.trustSshHostKey(event, id(probeId, "a host key probe"))),
  );
  handle("orkestrator:connections:remove-route", (event, connectionId, routeId) =>
    deps.removeRoute(event, id(connectionId, "a connection ID"), id(routeId, "a route ID")),
  );
  handle("orkestrator:connections:set-route-order", (event, connectionId, routeIds) => {
    if (!Array.isArray(routeIds) || routeIds.length > 16) throw new Error("Expected route IDs");
    return deps.setRouteOrder(
      event,
      id(connectionId, "a connection ID"),
      routeIds.map((routeId) => id(routeId, "a route ID")),
    );
  });
  handle("orkestrator:connections:set-route-enabled", (event, connectionId, routeId, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Expected enabled to be a boolean");
    return deps.setRouteEnabled(
      event,
      id(connectionId, "a connection ID"),
      id(routeId, "a route ID"),
      enabled,
    );
  });
  handle("orkestrator:connections:use-route", (event, connectionId, routeId) =>
    withErrorCode(() =>
      deps.useRoute(event, id(connectionId, "a connection ID"), id(routeId, "a route ID")),
    ),
  );
  handle("orkestrator:connections:set-auto-connect", (event, connectionId, autoConnect) => {
    if (typeof autoConnect !== "boolean") throw new Error("Expected autoConnect to be a boolean");
    return deps.setAutoConnect(event, id(connectionId, "a connection ID"), autoConnect);
  });
  handle("orkestrator:connections:set-features", (event, value) => {
    const input = record(value, "feature flags");
    const features: Partial<FederationFeatureFlags> = {};
    for (const key of ["federation", "sshRoutes", "routeFallback"] as const) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== "boolean") throw new Error(`Expected ${key} to be a boolean`);
        features[key] = input[key] as boolean;
      }
    }
    return deps.setFeatures(event, features);
  });

  handle("orkestrator:workspace-views:open", (event, value) => {
    const input = record(value, "workspace details");
    const request = input.request === undefined ? {} : record(input.request, "a selection");
    return withErrorCode(() =>
      deps.openWorkspaceView(event, {
        nodeId: id(input.nodeId, "a node ID"),
        search: realmSearch(request),
      }),
    );
  });
  handle("orkestrator:workspace-views:set-bounds", (event, viewId, bounds) =>
    deps.setWorkspaceViewBounds(event, id(viewId, "a workspace view"), viewBounds(bounds)),
  );
  handle("orkestrator:workspace-views:set-visible", (event, viewId, visible) => {
    if (typeof visible !== "boolean") throw new Error("Expected visible to be a boolean");
    deps.setWorkspaceViewVisible(event, id(viewId, "a workspace view"), visible);
  });
  handle("orkestrator:workspace-views:capture", (event, viewId) =>
    deps.captureWorkspaceView(event, id(viewId, "a workspace view")),
  );
  handle("orkestrator:workspace-views:send", (event, viewId, message) =>
    deps.sendToWorkspaceView(event, id(viewId, "a workspace view"), boundedMessage(message)),
  );
  handle("orkestrator:workspace-views:close", (event, viewId) =>
    deps.closeWorkspaceView(event, id(viewId, "a workspace view")),
  );
  handle("orkestrator:workspace-realm:post", (event, message) =>
    deps.postFromWorkspaceRealm(event, boundedMessage(message)),
  );
  handle("orkestrator:portal:invoke", (event, command, args) => {
    if (typeof command !== "string" || !command) throw new Error("Expected a command");
    return deps.portalInvoke(event, command, args === undefined ? {} : record(args, "arguments"));
  });
}
