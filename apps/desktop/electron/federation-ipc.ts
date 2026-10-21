import type { ConnectSshRouteInput, ConnectionList } from "@orkestrator/protocol/connections";
import type { FederationFeatureFlags } from "@orkestrator/protocol/device-catalogue";
import { isTrustedRendererUrl } from "./window.js";

/**
 * IPC for the federated client: commands to an explicit machine, machine
 * observation, managed SSH routes, route management and backend-scoped
 * panels. Every destination is an explicit connection ID the main process
 * validates against the requesting window; the renderer never supplies a
 * URL, a credential or an SSH command line.
 */

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

export type PanelBounds = { x: number; y: number; width: number; height: number };

export type PanelOpenInput = {
  connectionId: string;
  /** Absent opens the machine's project launcher (e.g. to add a project there). */
  projectId?: string;
  environmentId?: string;
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
  panel: boolean;
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
  openPanel(event: IpcEventLike, input: PanelOpenInput): Promise<{ panelId: string }>;
  setPanelBounds(event: IpcEventLike, panelId: string, bounds: PanelBounds): void;
  setPanelVisible(event: IpcEventLike, panelId: string, visible: boolean): void;
  closePanel(event: IpcEventLike, panelId: string): void;
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

function bounds(value: unknown): PanelBounds {
  const { x, y, width, height } = record(value, "panel bounds");
  if (![x, y, width, height].every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error("Expected finite panel bounds");
  }
  return {
    x: Math.max(0, Math.round(x as number)),
    y: Math.max(0, Math.round(y as number)),
    width: Math.max(0, Math.round(width as number)),
    height: Math.max(0, Math.round(height as number)),
  };
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

  handle("orkestrator:panels:open", (event, value) => {
    const input = record(value, "panel details");
    return deps.openPanel(event, {
      connectionId: id(input.connectionId, "a connection ID"),
      ...(input.projectId === undefined ? {} : { projectId: id(input.projectId, "a project ID") }),
      ...(input.environmentId === undefined
        ? {}
        : { environmentId: id(input.environmentId, "an environment ID") }),
    });
  });
  handle("orkestrator:panels:set-bounds", (event, panelId, value) => {
    deps.setPanelBounds(event, id(panelId, "a panel ID"), bounds(value));
  });
  handle("orkestrator:panels:set-visible", (event, panelId, visible) => {
    if (typeof visible !== "boolean") throw new Error("Expected visible to be a boolean");
    deps.setPanelVisible(event, id(panelId, "a panel ID"), visible);
  });
  handle("orkestrator:panels:close", (event, panelId) => {
    deps.closePanel(event, id(panelId, "a panel ID"));
  });
}
