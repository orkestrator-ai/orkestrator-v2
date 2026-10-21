import { randomUUID } from "node:crypto";
import {
  BACKEND_PROFILE_CHANGED_EVENT,
  defaultMachineColor,
  parseBackendProfile,
  type BackendHello,
} from "@orkestrator/protocol/backend-profile";
import {
  LOCAL_CONNECTION_ID,
  normalizeConnectionNickname,
  type ConnectSshRouteInput,
  type ConnectToRemoteInput,
  type ConnectionList,
  type ConnectionSummary,
  type ConnectionTransportState,
} from "@orkestrator/protocol/connections";
import {
  describeRoute,
  emptyDeviceCatalogue,
  orderedRoutes,
  validateIdentityFile,
  validatePort,
  validateSshDestination,
  type DeviceCatalogue,
  type FederationFeatureFlags,
  type SavedBackend,
  type SavedHttpsRoute,
  type SavedRoute,
  type SavedSshRoute,
} from "@orkestrator/protocol/device-catalogue";
import type { RouteId } from "@orkestrator/protocol/federation";
import { normalizeGatewayToken } from "@orkestrator/protocol/gateway-token";
import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";
import { BackendHttpClient } from "./backend-process.js";
import { checkBackendRoute, connectionCheckError, type HelloOutcome } from "./backend-hello.js";
import {
  backendAddress,
  newRouteId,
  normalizeRemoteAddress,
  primaryHttpsRoute,
  replaceRoute,
  withAlias,
  type Established,
  type MachineStatus,
} from "./connection-records.js";
import { backendConnectionSummary, localConnectionSummary } from "./connection-summaries.js";
import {
  assertSshOutcome,
  establishRoute,
  identityMismatch,
} from "./connection-route-selection.js";
import {
  LocalBackendCatalogueStore,
  loadOrMigrateCatalogue,
  type ConnectionCatalogueStore,
} from "./connection-catalogue-store.js";
import { BackgroundAttemptLimiter, ReconnectScheduler } from "./connection-scheduling.js";
import {
  classifyRouteFailure,
  openRoute,
  probeSshHostKey,
  routeError,
  sanitizeDiagnostic,
  type OpenedRoute,
  type SshTunnelProvider,
} from "./connection-routes.js";

type LocalBackend = Pick<
  BackendHttpClient,
  | "invoke"
  | "probe"
  | "getWebClientStatus"
  | "setWebClientEnabled"
  | "resetWebClientServe"
  | "getTokenSettings"
  | "setToken"
> & {
  /** Authenticated hello of the local backend; absent on test doubles. */
  hello?: (timeoutMs: number) => Promise<BackendHello | null>;
};

export type SecureStorage = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
};

export type ConnectionManagerOptions = {
  localBackend: LocalBackend;
  /** Starts unavailable when the desktop's local backend failed to start. */
  localBackendAvailable?: boolean;
  secureStorage: SecureStorage;
  /**
   * Device-owned catalogue persistence. Omitted, the manager persists the
   * version-1 list through the local backend as before.
   */
  catalogueStore?: ConnectionCatalogueStore;
  /** Read once to migrate the version-1 list when the native store is empty. */
  legacyCatalogue?: LocalBackendCatalogueStore | null;
  /** Native OpenSSH supervisor; absent where SSH routes are not qualified. */
  sshTunnels?: SshTunnelProvider | null;
  platform?: NodeJS.Platform;
  connectionTimeoutMs?: number;
  onEvent: (event: string, payload: unknown) => void;
  onConnectionEvent?: (connectionId: string, event: string, payload: unknown) => void;
  /** Machine state (transport, identity, profile) changed; republish lists. */
  onStateChange?: () => void;
  /** Reconnect delays for background recovery, in milliseconds. */
  reconnectDelaysMs?: readonly number[];
};

const CONNECTION_TIMEOUT_MS = 10_000;
const CONNECTION_PROBE_TIMEOUT_MS = 3_000;
export const DEFAULT_CONNECTION_SCOPE = "default";
/** Background connection attempts across all machines. User actions bypass this. */
const MAX_BACKGROUND_ATTEMPTS = 4;
/** Consecutive event-stream drops before an approved fallback route is tried. */
const STREAM_FAILURES_BEFORE_FALLBACK = 3;
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const LOCAL_HELLO_TIMEOUT_MS = 3_000;

type RemoteConnection = {
  connectionId: string;
  routeId: RouteId;
  client: BackendHttpClient;
  token: string;
  scopes: Set<string>;
  /** Client-local fence: changes on every route change, reconnect and token change. */
  epoch: number;
  transport: OpenedRoute;
  unsubscribeTransport: (() => void) | null;
  generation: string | null;
  streamFailures: number;
  handover: Promise<void> | null;
  workspaceNodeId?: string;
  onWorkspaceUnavailable?: () => void;
};

/** Connection IDs of panel scopes bound to another node's workspace. */
export const WORKSPACE_CONNECTION_PREFIX = "workspace:";

/** Another node's workspace: a client grant and the route chosen for it. */
export type WorkspaceScopeInput = {
  workspaceId: string;
  baseUrl: string;
  token: string;
  nodeId?: string;
  onUnavailable?: () => void;
};

/** A saved machine and the first gateway token that could be decrypted for it. */
export type SavedMachineExport = { backend: SavedBackend; token: string | null };

/**
 * Owns this device's connections to the backends it can use as its target.
 *
 * A window *binds* to one target: normally this computer's own backend, the
 * desktop's command node, which itself connects to the other nodes and
 * serves the multi-machine views (docs/architecture/command-nodes.md). A
 * saved machine can still be bound directly. A window's scope can be
 * pointed at another node's workspace with a client grant
 * (`retargetScopeToWorkspace`) and back (`restoreScopeFrom`). Nothing here
 * starts, stops or moves work.
 */
export class ConnectionManager {
  private readonly localBackend: LocalBackend;
  private readonly secureStorage: SecureStorage;
  private readonly platform: NodeJS.Platform;
  private readonly onEvent: (event: string, payload: unknown) => void;
  private readonly onConnectionEvent?: ConnectionManagerOptions["onConnectionEvent"];
  private readonly onStateChange?: () => void;
  private readonly connectionTimeoutMs: number;
  private readonly store: ConnectionCatalogueStore;
  private readonly legacyCatalogue: LocalBackendCatalogueStore | null;
  private readonly sshTunnels: SshTunnelProvider | null;
  private readonly reconnectDelaysMs: readonly number[];
  private catalogue: DeviceCatalogue = emptyDeviceCatalogue();
  private readonly bindings = new Map<string, string>();
  private readonly remoteConnections = new Map<string, RemoteConnection>();
  private readonly statuses = new Map<string, MachineStatus>();
  private readonly scopeGenerations = new Map<string, number>([[DEFAULT_CONNECTION_SCOPE, 1]]);
  /** Observation leases a scope holds on machines it may not be bound to. */
  private nextScopeGeneration = 1;
  private nextEpoch = 1;
  private secureStorageAvailable = false;
  private localBackendAvailable: boolean;
  private localHello: BackendHello | null = null;
  /** Gateway tokens accepted during this process, per route. Never persisted. */
  private readonly sessionTokens = new Map<string, string>();
  private readonly scopeQueues = new Map<string, Promise<unknown>>();
  private catalogueQueue: Promise<unknown> = Promise.resolve();
  private readonly activations = new Map<string, Promise<RemoteConnection>>();
  private readonly backgroundAttempts = new BackgroundAttemptLimiter(MAX_BACKGROUND_ATTEMPTS);
  private readonly reconnects: ReconnectScheduler;
  private disposed = false;

  constructor(options: ConnectionManagerOptions) {
    this.localBackend = options.localBackend;
    this.localBackendAvailable = options.localBackendAvailable ?? true;
    this.secureStorage = options.secureStorage;
    this.platform = options.platform ?? process.platform;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS;
    if (!Number.isFinite(this.connectionTimeoutMs) || this.connectionTimeoutMs <= 0) {
      throw new Error("Connection timeout must be a positive number of milliseconds.");
    }
    this.onEvent = options.onEvent;
    this.onConnectionEvent = options.onConnectionEvent;
    this.onStateChange = options.onStateChange;
    this.store =
      options.catalogueStore ??
      new LocalBackendCatalogueStore(this.localBackend, () => this.localBackendAvailable);
    this.legacyCatalogue = options.catalogueStore ? (options.legacyCatalogue ?? null) : null;
    this.sshTunnels = options.sshTunnels ?? null;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.reconnects = new ReconnectScheduler(this.reconnectDelaysMs, (connectionId) => {
      if (!this.isWanted(connectionId)) return;
      if (this.remoteConnections.has(connectionId)) this.startHandover(connectionId, "retry");
      else void this.backgroundActivate(connectionId);
    });
  }

  async initialize(): Promise<void> {
    this.secureStorageAvailable = await this.detectSecureStorage();
    this.catalogue = await loadOrMigrateCatalogue(this.store, this.legacyCatalogue);
    this.bindings.set(DEFAULT_CONNECTION_SCOPE, LOCAL_CONNECTION_ID);
    await this.refreshLocalHello();
    if (this.catalogue.activeConnectionId === LOCAL_CONNECTION_ID) return;
    try {
      await this.activateForScope(
        DEFAULT_CONNECTION_SCOPE,
        this.catalogue.activeConnectionId,
        false,
        false,
      );
    } catch (error) {
      console.warn(
        "[Connections] Could not restore the previous remote connection; using Local:",
        sanitizeDiagnostic(error instanceof Error ? error.message : String(error)),
      );
      await this.mutateCatalogue((current) => ({
        ...current,
        activeConnectionId: LOCAL_CONNECTION_ID,
      })).catch(() => {
        this.catalogue = { ...this.catalogue, activeConnectionId: LOCAL_CONNECTION_ID };
      });
      this.bindings.set(DEFAULT_CONNECTION_SCOPE, LOCAL_CONNECTION_ID);
    }
  }

  /** Stop every owned connection and tunnel. Remote work is unaffected. */
  dispose(): void {
    this.disposed = true;
    this.reconnects.dispose();
    for (const connectionId of Array.from(this.remoteConnections.keys())) {
      this.teardownRemote(connectionId);
    }
    void this.sshTunnels?.disposeAll?.().catch(() => undefined);
  }

  getList(scope = DEFAULT_CONNECTION_SCOPE): ConnectionList {
    const activeConnectionId = this.connectionIdForScope(scope);
    const supportedRouteKinds = this.supportedRouteKinds();
    return {
      activeConnectionId,
      credentialStorage: this.secureStorageAvailable ? "secure" : "session-only",
      localAvailable: this.localBackendAvailable,
      features: { ...this.catalogue.features },
      supportedRouteKinds,
      connections: [
        this.localSummary(activeConnectionId),
        ...this.catalogue.backends.map((backend) =>
          this.backendSummary(backend, activeConnectionId, supportedRouteKinds),
        ),
      ],
    };
  }

  private localSummary(activeConnectionId: string): ConnectionSummary {
    return localConnectionSummary(this.localHello, this.localBackendAvailable, activeConnectionId);
  }

  private backendSummary(
    backend: SavedBackend,
    activeConnectionId: string,
    supportedRouteKinds: ReadonlyArray<"https" | "ssh">,
  ): ConnectionSummary {
    return backendConnectionSummary({
      backend,
      status: this.statuses.get(backend.id),
      activeRouteId: this.remoteConnections.get(backend.id)?.routeId ?? null,
      activeConnectionId,
      supportedRouteKinds,
      hasSessionToken: (routeId) => this.sessionTokens.has(routeId),
    });
  }

  private supportedRouteKinds(): Array<"https" | "ssh"> {
    const qualified = this.platform === "darwin" || this.platform === "linux";
    return this.sshTunnels && qualified && this.catalogue.features.sshRoutes
      ? ["https", "ssh"]
      : ["https"];
  }

  async connect(
    input: ConnectToRemoteInput,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    return this.enqueueScope(scope, async () => {
      this.assertScopeGeneration(scope, generation);
      const address = normalizeRemoteAddress(input.address, this.knownAddresses());
      const token = normalizeGatewayToken(input.token);
      const requestedNickname = normalizeConnectionNickname(input.nickname);
      this.secureStorageAvailable = await this.detectSecureStorage();
      this.assertScopeGeneration(scope, generation);

      const outcome = await checkBackendRoute(address, token, {
        timeoutMs: this.connectionTimeoutMs,
      });
      this.assertScopeGeneration(scope, generation);
      const encryptedToken = await this.encryptForStorage(token);
      this.assertScopeGeneration(scope, generation);

      const byAddress = this.catalogue.backends.find((backend) =>
        backend.routes.some((route) => route.kind === "https" && route.origin === address),
      );
      const hello = outcome.kind === "hello" ? outcome.hello : null;
      if (input.connectionId) {
        // "Add connection method": only for a verified machine, and only when
        // the new address proves that same installation.
        const target = this.findBackend(input.connectionId);
        if (!target) throw new Error("That saved connection no longer exists.");
        if (!target.verifiedInstallationId) {
          throw new Error(
            "Connect to this machine over its existing route once before adding another, so its identity can be verified.",
          );
        }
        if (!hello || hello.installationId !== target.verifiedInstallationId) {
          throw identityMismatch(target, address);
        }
        if (byAddress && byAddress.id !== target.id) {
          throw new Error("That address is already saved as another machine.");
        }
      }
      if (
        byAddress?.verifiedInstallationId &&
        hello &&
        byAddress.verifiedInstallationId !== hello.installationId
      ) {
        throw identityMismatch(byAddress, address);
      }
      // A new address that proves an installation already saved here is not
      // silently merged: matching IDs alone are not trusted (a copied data
      // directory can repeat one). The user adds it as another connection
      // method of that machine explicitly, which checks identity again.
      const byIdentity = hello
        ? this.catalogue.backends.find(
            (backend) => backend.verifiedInstallationId === hello.installationId,
          )
        : undefined;
      if (!input.connectionId && !byAddress && byIdentity) {
        throw routeError(
          "identity-duplicate",
          `This address answers as ${byIdentity.localAlias || byIdentity.fallbackName}, which is already saved. If it is the same machine, add it from that machine's Details as another connection method.`,
          false,
        );
      }
      const existing = byAddress ?? byIdentity;
      const existingRoute = existing?.routes.find(
        (route): route is SavedHttpsRoute => route.kind === "https" && route.origin === address,
      );
      const now = new Date().toISOString();
      const route: SavedHttpsRoute = {
        id: existingRoute?.id ?? newRouteId("https"),
        kind: "https",
        origin: address,
        encryptedToken,
        enabled: true,
        lastConnectedAt: now,
      };
      const nickname = requestedNickname ?? existing?.localAlias;
      const newId = randomUUID();
      const base: SavedBackend = existing ?? {
        id: newId,
        fallbackName: new URL(address).hostname,
        routeOrder: [],
        routes: [],
        autoConnect: true,
        // Shown until the machine publishes its canonical profile.
        provisionalColor: defaultMachineColor(newId),
      };
      const routes = existingRoute
        ? base.routes.map((candidate) => (candidate.id === route.id ? route : candidate))
        : [...base.routes, route];
      let record: SavedBackend = withAlias(
        {
          ...base,
          ...(existing ? {} : { fallbackName: new URL(address).hostname }),
          routes,
          routeOrder: existingRoute ? base.routeOrder : [...base.routeOrder, route.id],
          lastConnectedAt: now,
        },
        nickname,
      );
      if (hello) record = this.recordHello(record, hello);
      const committed = record;
      const select = input.select !== false;
      await this.mutateCatalogue((current) => {
        this.assertScopeGeneration(scope, generation);
        return {
          ...current,
          activeConnectionId: select ? committed.id : current.activeConnectionId,
          backends: [
            committed,
            ...current.backends.filter((backend) => backend.id !== committed.id),
          ],
        };
      });
      this.assertScopeGeneration(scope, generation);
      this.sessionTokens.set(route.id, token);
      this.markHello(record.id, outcome);
      this.blockedRoutes(record.id).delete(route.id);
      if (select || this.isWanted(record.id) || this.remoteConnections.has(record.id)) {
        this.installRemote(
          record.id,
          route,
          { baseUrl: address, release: () => undefined },
          token,
          outcome,
        );
      }
      if (select) this.bindScope(scope, record.id);
      this.emitStateChange();
      return this.getList(scope);
    });
  }

  /**
   * Add a managed SSH route: a new machine, or (with `connectionId`) another
   * connection method for an existing one. The forward reaches the remote
   * backend's loopback client gateway; gateway authentication still applies.
   */
  async connectSsh(
    input: ConnectSshRouteInput,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    if (!this.supportedRouteKinds().includes("ssh")) {
      throw new Error("SSH routes are not available in this client.");
    }
    const generation = this.captureScopeGeneration(scope);
    return this.enqueueScope(scope, async () => {
      this.assertScopeGeneration(scope, generation);
      const destination = validateSshDestination(input.destination);
      const sshPort =
        input.sshPort === undefined ? undefined : validatePort(input.sshPort, "SSH port");
      const identityFile = validateIdentityFile(input.identityFile);
      const remoteGatewayPort = validatePort(input.remoteGatewayPort, "remote gateway port");
      const token = normalizeGatewayToken(input.token);
      const nickname = normalizeConnectionNickname(input.nickname);
      const target = input.connectionId
        ? this.catalogue.backends.find((backend) => backend.id === input.connectionId)
        : undefined;
      if (input.connectionId && !target) throw new Error("That saved connection no longer exists.");
      const route: SavedSshRoute = {
        id: newRouteId("ssh"),
        kind: "ssh",
        destination,
        ...(sshPort ? { sshPort } : {}),
        ...(identityFile ? { identityFile } : {}),
        remoteGatewayPort,
        encryptedToken: "",
        enabled: true,
      };
      this.secureStorageAvailable = await this.detectSecureStorage();
      const transport = await openRoute(route, { interactive: true, ssh: this.sshTunnels });
      let outcome: HelloOutcome;
      try {
        outcome = await checkBackendRoute(transport.baseUrl, token, {
          timeoutMs: this.connectionTimeoutMs,
          unreachableMessage:
            "The SSH connection worked, but no Orkestrator client gateway answered on that remote port.",
        });
        assertSshOutcome(outcome);
        this.assertScopeGeneration(scope, generation);
      } catch (error) {
        transport.release();
        throw error;
      }
      const hello = outcome.kind === "hello" ? outcome.hello : null;
      try {
        if (
          target?.verifiedInstallationId &&
          hello &&
          target.verifiedInstallationId !== hello.installationId
        ) {
          throw identityMismatch(target, `ssh ${destination}`);
        }
        if (target && !target.verifiedInstallationId) {
          throw new Error(
            "Connect to this machine over its existing route once before adding another, so its identity can be verified.",
          );
        }
        const byIdentity =
          !target && hello
            ? this.catalogue.backends.find(
                (backend) => backend.verifiedInstallationId === hello.installationId,
              )
            : undefined;
        if (byIdentity) {
          throw routeError(
            "identity-duplicate",
            `This SSH route reaches ${byIdentity.localAlias || byIdentity.fallbackName}, which is already saved. Add it from that machine's Details as another connection method.`,
            false,
          );
        }
        const owner = target;
        const now = new Date().toISOString();
        const savedRoute: SavedSshRoute = {
          ...route,
          encryptedToken: await this.encryptForStorage(token),
          lastConnectedAt: now,
        };
        let record: SavedBackend = owner
          ? {
              ...owner,
              routes: [...owner.routes, savedRoute],
              routeOrder: [...owner.routeOrder, savedRoute.id],
              lastConnectedAt: now,
            }
          : (() => {
              const id = randomUUID();
              return {
                id,
                fallbackName: destination,
                routes: [savedRoute],
                routeOrder: [savedRoute.id],
                autoConnect: true,
                lastConnectedAt: now,
                provisionalColor: defaultMachineColor(id),
              };
            })();
        if (nickname) record = withAlias(record, nickname);
        if (hello) record = this.recordHello(record, hello);
        const committed = record;
        await this.mutateCatalogue((current) => {
          this.assertScopeGeneration(scope, generation);
          const known = current.backends.some((backend) => backend.id === committed.id);
          return {
            ...current,
            activeConnectionId:
              !target && input.select === true ? committed.id : current.activeConnectionId,
            backends: known
              ? current.backends.map((backend) =>
                  backend.id === committed.id ? committed : backend,
                )
              : [committed, ...current.backends],
          };
        });
        this.assertScopeGeneration(scope, generation);
        this.sessionTokens.set(savedRoute.id, token);
        this.markHello(record.id, outcome);
        if (target || owner) {
          // Adding a method to a known machine never moves its active route.
          transport.release();
          if (!target && input.select === true) this.bindScopeAfterActivation(scope, record.id);
        } else {
          this.installRemote(record.id, savedRoute, transport, token, outcome);
          if (input.select === true) this.bindScope(scope, record.id);
          else this.releaseIfUnused(record.id);
        }
        this.emitStateChange();
        return this.getList(scope);
      } catch (error) {
        transport.release();
        throw error;
      }
    });
  }

  /** First-use host-key review; see `probeSshHostKey` in connection-routes. */
  probeSshHostKey(input: { destination: string; sshPort?: number }) {
    return probeSshHostKey(
      this.supportedRouteKinds().includes("ssh") ? this.sshTunnels : null,
      input,
    );
  }

  /** Record explicit approval of a probed host key in Orkestrator's own known_hosts. */
  trustSshHostKey(probeId: string): Promise<{ added: number }> {
    if (!this.sshTunnels?.trustHostKey) {
      return Promise.reject(new Error("SSH routes are not available in this client."));
    }
    return this.sshTunnels.trustHostKey({ probeId });
  }

  async use(connectionId: string, scope = DEFAULT_CONNECTION_SCOPE): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    return this.enqueueScope(scope, async () => {
      this.assertScopeGeneration(scope, generation);
      if (connectionId === LOCAL_CONNECTION_ID) {
        await this.mutateCatalogue((current) => {
          this.assertScopeGeneration(scope, generation);
          return { ...current, activeConnectionId: LOCAL_CONNECTION_ID };
        });
        this.assertScopeGeneration(scope, generation);
        this.setScopeLocal(scope);
        return this.getList(scope);
      }
      await this.activateForScope(scope, connectionId, true, true, generation);
      return this.getList(scope);
    });
  }

  /**
   * Forget a machine on this device only. It does not revoke the device,
   * stop the backend or delete remote data.
   */
  async forget(connectionId: string, scope = DEFAULT_CONNECTION_SCOPE): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    return this.enqueueScope(scope, async () => {
      this.assertScopeGeneration(scope, generation);
      if (connectionId === LOCAL_CONNECTION_ID)
        throw new Error("The Local connection cannot be removed.");
      const backend = this.findBackend(connectionId);
      if (!backend) throw new Error("That saved connection no longer exists.");
      const activeScopes = Array.from(this.bindings.entries())
        .filter(([, activeConnectionId]) => activeConnectionId === connectionId)
        .map(([boundScope]) => boundScope);
      if (
        activeScopes.some(
          (activeScope) => activeScope !== DEFAULT_CONNECTION_SCOPE && activeScope !== scope,
        )
      ) {
        throw new Error("Switch or close every window using this connection before removing it.");
      }
      await this.mutateCatalogue((current) => {
        this.assertScopeGeneration(scope, generation);
        return {
          ...current,
          activeConnectionId:
            current.activeConnectionId === connectionId
              ? LOCAL_CONNECTION_ID
              : current.activeConnectionId,
          backends: current.backends.filter((entry) => entry.id !== connectionId),
        };
      });
      this.assertScopeGeneration(scope, generation);
      for (const route of backend.routes) this.sessionTokens.delete(route.id);
      for (const activeScope of activeScopes) this.setScopeLocal(activeScope);
      this.reconnects.cancel(connectionId);
      this.teardownRemote(connectionId);
      this.statuses.delete(connectionId);
      this.emitStateChange();
      return this.getList(scope);
    });
  }

  /** Remove one route; a machine still reachable through another route is kept. */
  async removeRoute(
    connectionId: string,
    routeId: string,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    this.assertScopeGeneration(scope, generation);
    await this.updateBackend(connectionId, (backend) => {
      if (!backend.routes.some((route) => route.id === routeId)) {
        throw new Error("That connection method no longer exists.");
      }
      if (backend.routes.length === 1) {
        throw new Error(
          "This is the machine's only connection method. Forget the machine instead.",
        );
      }
      return {
        ...backend,
        routes: backend.routes.filter((route) => route.id !== routeId),
        routeOrder: backend.routeOrder.filter((id) => id !== routeId),
      };
    });
    {
      this.sessionTokens.delete(routeId);
      this.blockedRoutes(connectionId).delete(routeId);
      if (this.remoteConnections.get(connectionId)?.routeId === routeId) {
        this.startHandover(connectionId, "route-removed");
      }
      this.emitStateChange();
      return this.getList(scope);
    }
  }

  /** User-defined route preference. Never switches a healthy active route by itself. */
  async setRouteOrder(
    connectionId: string,
    routeIds: readonly string[],
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    this.assertScopeGeneration(scope, generation);
    await this.updateBackend(connectionId, (backend) => {
      const known = new Set(backend.routes.map((route) => route.id as string));
      if (
        routeIds.length !== known.size ||
        new Set(routeIds).size !== routeIds.length ||
        !routeIds.every((id) => known.has(id))
      ) {
        throw new Error("The route order must list every connection method exactly once.");
      }
      return { ...backend, routeOrder: routeIds as RouteId[] };
    });
    this.emitStateChange();
    return this.getList(scope);
  }

  async setRouteEnabled(
    connectionId: string,
    routeId: string,
    enabled: boolean,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    this.assertScopeGeneration(scope, generation);
    await this.updateBackend(connectionId, (backend) => {
      const route = backend.routes.find((candidate) => candidate.id === routeId);
      if (!route) throw new Error("That connection method no longer exists.");
      return replaceRoute(backend, { ...route, enabled });
    });
    if (!enabled && this.remoteConnections.get(connectionId)?.routeId === routeId) {
      this.startHandover(connectionId, "route-disabled");
    }
    this.emitStateChange();
    return this.getList(scope);
  }

  /**
   * Explicitly choose a route. This is also how a quarantined route is
   * retried after the user resolved the trust problem.
   */
  async useRoute(
    connectionId: string,
    routeId: string,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    return this.enqueueScope(scope, async () => {
      this.assertScopeGeneration(scope, generation);
      const backend = this.requireBackend(connectionId);
      if (!backend.routes.some((route) => route.id === routeId)) {
        throw new Error("That connection method no longer exists.");
      }
      this.blockedRoutes(connectionId).delete(routeId);
      const established = await this.establish(backend, {
        interactive: true,
        onlyRouteId: routeId as RouteId,
      });
      try {
        this.assertScopeGeneration(scope, generation);
      } catch (error) {
        established.transport.release();
        throw error;
      }
      this.adoptEstablished(connectionId, established, true);
      return this.getList(scope);
    });
  }

  async setAutoConnect(
    connectionId: string,
    autoConnect: boolean,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    this.assertScopeGeneration(scope, generation);
    await this.updateBackend(connectionId, (backend) => ({ ...backend, autoConnect }));
    this.emitStateChange();
    return this.getList(scope);
  }

  /** Client feature flags. Disabling one stops client machinery only, never remote work. */
  async setFeatures(
    features: Partial<FederationFeatureFlags>,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    this.assertScopeGeneration(scope, generation);
    {
      const updated = await this.mutateCatalogue((current) => {
        const flags: FederationFeatureFlags = { ...current.features };
        for (const key of ["federation", "sshRoutes", "routeFallback"] as const) {
          if (typeof features[key] === "boolean") flags[key] = features[key];
        }
        return { ...current, features: flags };
      });
      const next = updated.features;
      if (!next.sshRoutes) {
        for (const remote of Array.from(this.remoteConnections.values())) {
          const route = this.findBackend(remote.connectionId)?.routes.find(
            (candidateRoute) => candidateRoute.id === remote.routeId,
          );
          if (route?.kind === "ssh") this.startHandover(remote.connectionId, "ssh-disabled");
        }
      }
      this.emitStateChange();
      return this.getList(scope);
    }
  }

  /** Set or clear (`null`/blank) the display nickname of a saved remote connection. */
  async rename(
    connectionId: string,
    value: string | null,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    this.assertScopeGeneration(scope, generation);
    if (connectionId === LOCAL_CONNECTION_ID) {
      throw new Error("The Local connection cannot be renamed.");
    }
    const nickname = normalizeConnectionNickname(value);
    await this.updateBackend(connectionId, (backend) => withAlias(backend, nickname));
    // Once durable, reconcile shared state even if the initiating window closed.
    this.emitStateChange();
    this.assertScopeGeneration(scope, generation);
    return this.getList(scope);
  }

  async updateToken(
    connectionId: string,
    value: string,
    scope = DEFAULT_CONNECTION_SCOPE,
    routeId?: string,
  ): Promise<ConnectionList> {
    const generation = this.captureScopeGeneration(scope);
    return this.enqueueScope(scope, async () => {
      this.assertScopeGeneration(scope, generation);
      const backend = this.findBackend(connectionId);
      if (!backend) throw new Error("That saved connection no longer exists.");
      const remote = this.remoteConnections.get(connectionId);
      const route =
        backend.routes.find((candidate) => candidate.id === (routeId ?? remote?.routeId)) ??
        orderedRoutes(backend)[0];
      if (!route) throw new Error("That saved connection no longer exists.");

      const token = normalizeGatewayToken(value);
      if (!route.enabled) throw new Error("Enable that route before updating its credential.");
      const reusesTransport = remote?.routeId === route.id && !remote.client.isSuspended;
      const transport = reusesTransport
        ? { baseUrl: remote.client.origin, release: () => undefined }
        : await openRoute(route, { interactive: true, ssh: this.sshTunnels });
      let outcome: HelloOutcome;
      try {
        outcome = await checkBackendRoute(transport.baseUrl, token, {
          timeoutMs: this.connectionTimeoutMs,
        });
        if (route.kind === "ssh") assertSshOutcome(outcome);
        if (
          outcome.kind === "hello" &&
          backend.verifiedInstallationId &&
          outcome.hello.installationId !== backend.verifiedInstallationId
        ) {
          throw identityMismatch(backend, describeRoute(route));
        }
      } finally {
        if (!reusesTransport) transport.release();
      }
      this.assertScopeGeneration(scope, generation);
      this.secureStorageAvailable = await this.detectSecureStorage();
      let encryptedToken = "";
      if (this.secureStorageAvailable) {
        try {
          encryptedToken = (await this.secureStorage.encryptStringAsync(token)).toString("base64");
        } catch {
          // The token was already accepted by the server. Keep it usable for
          // this process even when the OS credential store fails mid-write.
          this.secureStorageAvailable = false;
        }
      }
      this.assertScopeGeneration(scope, generation);
      await this.updateBackend(connectionId, (current) => {
        const currentRoute = current.routes.find((candidate) => candidate.id === route.id);
        if (!currentRoute) throw new Error("That connection method no longer exists.");
        const record = replaceRoute(current, { ...currentRoute, encryptedToken });
        return outcome.kind === "hello" ? this.recordHello(record, outcome.hello) : record;
      });
      this.assertScopeGeneration(scope, generation);
      this.sessionTokens.set(route.id, token);
      this.statuses.get(connectionId)?.blockedRoutes.delete(route.id);
      if (remote && remote.routeId === route.id) {
        if (reusesTransport) this.retargetRemote(remote, null, token, false);
        else this.startHandover(connectionId, "credentials-changed");
      }
      this.emitStateChange();
      return this.getList(scope);
    });
  }

  async probe(connectionId: string): Promise<boolean> {
    const timeoutMs = Math.min(this.connectionTimeoutMs, CONNECTION_PROBE_TIMEOUT_MS);
    if (connectionId === LOCAL_CONNECTION_ID) {
      if (!this.localBackendAvailable) return false;
      try {
        return await this.localBackend.probe(timeoutMs);
      } catch {
        return false;
      }
    }

    const backend = this.findBackend(connectionId);
    if (!backend) return false;
    const remote = this.remoteConnections.get(connectionId);
    if (remote)
      return remote.client.isSuspended
        ? false
        : this.checkStatus(remote.client.origin, remote.token, timeoutMs);
    // Probing an unconnected machine never opens a tunnel: only an HTTPS
    // route with a credential can be probed cheaply.
    const route = primaryHttpsRoute(backend);
    if (!route?.enabled) return false;
    try {
      const token = await this.resolveToken(route, false);
      if (!token) return false;
      return await this.checkStatus(route.origin, token, timeoutMs);
    } catch {
      return false;
    }
  }

  invoke<T>(
    command: string,
    args: Record<string, unknown> = {},
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<T> {
    const connectionId = this.connectionIdForScope(scope);
    if (connectionId === LOCAL_CONNECTION_ID) return this.localBackend.invoke<T>(command, args);
    return this.invokeRemote<T>(connectionId, command, args);
  }

  private async invokeRemote<T>(
    connectionId: string,
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    let remote = this.remoteConnections.get(connectionId);
    if (!remote) throw new Error("The selected remote connection is not available.");
    // One mutation destination at a time: a command issued during a route
    // handover waits for the verified route instead of racing two.
    if (remote.handover) {
      await remote.handover.catch(() => undefined);
      remote = this.remoteConnections.get(connectionId);
      if (!remote) throw new Error("The selected remote connection is not available.");
    }
    return remote.client.invoke<T>(command, args);
  }

  /** Connection epoch of a machine, for fencing late renderer work. */
  epochOf(connectionId: string): number {
    if (connectionId === LOCAL_CONNECTION_ID) return 0;
    return this.remoteConnections.get(connectionId)?.epoch ?? -1;
  }

  /** Current origin of a scope's bound machine; ephemeral for a tunnelled route. */
  getGatewayBaseUrl(scope = DEFAULT_CONNECTION_SCOPE): string | null {
    const remote = this.remoteForScope(scope);
    return remote && !remote.client.isSuspended ? remote.transport.baseUrl : null;
  }

  handleLocalEvent(event: string, payload: unknown): void {
    if (!this.localBackendAvailable) return;
    if (event === BACKEND_PROFILE_CHANGED_EVENT && this.localHello) {
      try {
        this.localHello = { ...this.localHello, profile: parseBackendProfile(payload) };
        this.emitStateChange();
      } catch {
        // A malformed profile event changes nothing; the next hello reconciles.
      }
    }
    this.dispatchConnectionEvent(LOCAL_CONNECTION_ID, event, payload);
  }

  markLocalBackendUnavailable(): void {
    this.localBackendAvailable = false;
    this.emitStateChange();
  }

  /** Preview tunnel URL for the window's connection, when its client supports it. */
  getPreviewTunnelUrl(scope = DEFAULT_CONNECTION_SCOPE): string | null {
    try {
      const connectionId = this.connectionIdForScope(scope);
      const backend =
        connectionId === LOCAL_CONNECTION_ID
          ? (this.localBackend as { previewTunnelUrl?: () => string })
          : this.remoteConnections.get(connectionId)?.client;
      return backend?.previewTunnelUrl?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The client of one connection while any window holds it (Local always),
   * for work that belongs to that connection rather than to a window's
   * current binding.
   */
  backendForConnection(connectionId: string): LocalBackend | null {
    if (connectionId === LOCAL_CONNECTION_ID) return this.localBackend;
    return this.remoteConnections.get(connectionId)?.client ?? null;
  }

  /**
   * Bearer for a renderer request, only to the exact current origin of the
   * scope's bound machine and only for gateway paths. Two tunnels on the
   * same loopback host differ by port, so they never share a credential.
   */
  getRendererRequestAuthorization(
    urlValue: string,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): string | null {
    const activeRemote = this.remoteForScope(scope);
    if (!activeRemote || activeRemote.client.isSuspended) return null;
    try {
      const url = new URL(urlValue);
      if (
        url.origin !== activeRemote.client.origin ||
        !url.pathname.startsWith(
          `${new URL(activeRemote.transport.baseUrl).pathname.replace(/\/$/, "")}/__orkestrator/`,
        )
      ) {
        return null;
      }
      return `Bearer ${activeRemote.token}`;
    } catch {
      return null;
    }
  }

  getWebClientStatus(scope = DEFAULT_CONNECTION_SCOPE): Promise<WebClientStatus> {
    return this.currentBackend(scope).getWebClientStatus();
  }

  setWebClientEnabled(
    enabled: boolean,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<WebClientStatus> {
    return this.currentBackend(scope).setWebClientEnabled(enabled);
  }

  resetWebClientServe(scope = DEFAULT_CONNECTION_SCOPE): Promise<WebClientStatus> {
    return this.currentBackend(scope).resetWebClientServe();
  }

  getGatewayTokenSettings(scope = DEFAULT_CONNECTION_SCOPE): Promise<GatewayTokenSettings> {
    return this.currentBackend(scope).getTokenSettings();
  }

  getTokenSettings(scope = DEFAULT_CONNECTION_SCOPE): Promise<GatewayTokenSettings> {
    return this.getGatewayTokenSettings(scope);
  }

  async setGatewayToken(
    token: string,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<GatewayTokenSettings> {
    const generation = this.captureScopeGeneration(scope);
    const connectionId = this.connectionIdForScope(scope);
    return this.enqueueScope(scope, async () => {
      this.assertScopeConnection(scope, generation, connectionId);
      const target =
        connectionId === LOCAL_CONNECTION_ID
          ? null
          : (this.remoteConnections.get(connectionId) ?? null);
      if (connectionId !== LOCAL_CONNECTION_ID && !target) {
        throw new Error("The selected remote connection is not available.");
      }
      const settings = await (target?.client ?? this.localBackend).setToken(token);
      // Once the backend accepts a token rotation it is authoritative even if
      // the initiating window closes. Finish reconciling shared consumers;
      // only the pre-dispatch assertion is allowed to cancel this operation.
      if (!target) return settings;

      target.token = settings.token;
      this.sessionTokens.set(target.routeId, settings.token);
      this.secureStorageAvailable = await this.detectSecureStorage();
      const backend = this.findBackend(connectionId);
      const route = backend?.routes.find((candidate) => candidate.id === target.routeId);
      try {
        const encryptedToken = this.secureStorageAvailable
          ? (await this.secureStorage.encryptStringAsync(settings.token)).toString("base64")
          : "";
        if (backend && route) {
          await this.updateBackend(connectionId, (current) =>
            replaceRoute(current, { ...route, encryptedToken }),
          );
        }
        this.retargetRemote(target, null, settings.token, false);
      } catch (error) {
        const current = this.findBackend(connectionId);
        if (current && route) {
          this.catalogue = this.withBackend(
            replaceRoute(current, { ...route, encryptedToken: "" }),
          );
        }
        this.retargetRemote(target, null, settings.token, false);
        throw error;
      }
      return settings;
    });
  }

  setToken(token: string, scope = DEFAULT_CONNECTION_SCOPE): Promise<GatewayTokenSettings> {
    return this.setGatewayToken(token, scope);
  }

  getConnectionId(scope = DEFAULT_CONNECTION_SCOPE): string {
    return this.connectionIdForScope(scope);
  }

  /** Verified installation identity of a scope's bound machine, when proved. */
  getBackendIdentity(scope = DEFAULT_CONNECTION_SCOPE): {
    connectionId: string;
    backendId: string | null;
    legacyOrigin: string | null;
  } {
    const connectionId = this.connectionIdForScope(scope);
    if (connectionId === LOCAL_CONNECTION_ID) {
      return {
        connectionId,
        backendId: this.localHello?.installationId ?? null,
        legacyOrigin: null,
      };
    }
    const backend = this.findBackend(connectionId);
    const status = this.statuses.get(connectionId);
    return {
      connectionId,
      backendId:
        this.remoteConnections.get(connectionId)?.workspaceNodeId ??
        (backend?.verifiedInstallationId && status?.identity !== "conflict"
          ? backend.verifiedInstallationId
          : null),
      legacyOrigin: backend ? backendAddress(backend) : null,
    };
  }

  async bind(
    scope: string,
    connectionId = this.catalogue.activeConnectionId,
  ): Promise<ConnectionList> {
    if (!scope) throw new Error("Connection scope cannot be empty.");
    if (scope === DEFAULT_CONNECTION_SCOPE || this.scopeGenerations.has(scope)) {
      throw new Error("Connection scope is already active.");
    }
    const generation = ++this.nextScopeGeneration;
    this.scopeGenerations.set(scope, generation);
    const binding = this.enqueueScope(scope, async () => {
      this.assertScopeGeneration(scope, generation);
      if (connectionId === LOCAL_CONNECTION_ID) {
        this.setScopeLocal(scope);
        return this.getList(scope);
      }
      await this.activateForScope(scope, connectionId, false, false, generation);
      return this.getList(scope);
    });
    return binding.catch((error) => {
      if (this.scopeGenerations.get(scope) === generation) {
        this.releaseScopeRemote(scope);
        this.bindings.delete(scope);
        this.scopeGenerations.delete(scope);
      }
      throw error;
    });
  }

  /**
   * Point a window's live scope at another node's workspace, reached with a
   * client grant the command node obtained (directly, or over the command
   * node's own route to it): the window becomes that node's client. The
   * grant is held for this scope only, never saved, and released when the
   * scope is pointed back or closed. The caller keeps the window's command
   * connection bound to a portal scope, so pointing back needs no reconnect.
   */
  retargetScopeToWorkspace(scope: string, input: WorkspaceScopeInput): void {
    this.captureScopeGeneration(scope);
    const connectionId = `${WORKSPACE_CONNECTION_PREFIX}${input.workspaceId}`;
    if (this.remoteConnections.has(connectionId)) {
      throw new Error("That workspace is already open.");
    }
    this.releaseScopeRemote(scope);
    // Late work started for the scope's previous machine must not apply.
    this.scopeGenerations.set(scope, ++this.nextScopeGeneration);
    this.installWorkspace(scope, connectionId, input);
  }

  /** Point a scope back at the machine another scope is bound to (the window's command node). */
  restoreScopeFrom(scope: string, sourceScope: string): void {
    this.captureScopeGeneration(scope);
    const connectionId = this.connectionIdForScope(sourceScope);
    this.scopeGenerations.set(scope, ++this.nextScopeGeneration);
    if (connectionId === LOCAL_CONNECTION_ID) this.setScopeLocal(scope);
    else this.bindScope(scope, connectionId);
  }

  private installWorkspace(scope: string, connectionId: string, input: WorkspaceScopeInput): void {
    const client = new BackendHttpClient(input.baseUrl, input.token);
    const remote: RemoteConnection = {
      connectionId,
      ...(input.nodeId ? { workspaceNodeId: input.nodeId } : {}),
      ...(input.onUnavailable ? { onWorkspaceUnavailable: input.onUnavailable } : {}),
      routeId: "workspace" as RouteId,
      client,
      token: input.token,
      scopes: new Set([scope]),
      epoch: this.nextEpoch++,
      transport: { baseUrl: input.baseUrl, release: () => undefined },
      unsubscribeTransport: null,
      generation: null,
      streamFailures: 0,
      handover: null,
    };
    this.remoteConnections.set(connectionId, remote);
    this.bindings.set(scope, connectionId);
    client.listen(
      (event, payload) => {
        if (this.remoteConnections.get(connectionId)?.client === client) {
          this.handleRemoteEvent(connectionId, event, payload);
        }
      },
      { onStreamState: (state) => this.handleStreamState(connectionId, client, state) },
    );
  }

  rebindWorkspace(scope: string, input: { baseUrl: string; token: string }): void {
    const remote = this.remoteForScope(scope);
    if (!remote?.connectionId.startsWith(WORKSPACE_CONNECTION_PREFIX))
      throw new Error("Workspace is closed.");
    remote.transport = { baseUrl: input.baseUrl, release: () => undefined };
    this.retargetRemote(remote, input.baseUrl, input.token, false);
  }

  release(scope: string): void {
    this.releaseScopeRemote(scope);
    this.bindings.delete(scope);
    this.scopeQueues.delete(scope);
    if (scope !== DEFAULT_CONNECTION_SCOPE) this.scopeGenerations.delete(scope);
  }

  /*
   * Activation
   */

  private currentBackend(scope: string): LocalBackend {
    const connectionId = this.connectionIdForScope(scope);
    if (connectionId === LOCAL_CONNECTION_ID) return this.localBackend;
    const remote = this.remoteConnections.get(connectionId);
    if (!remote) throw new Error("The selected remote connection is not available.");
    return remote.client;
  }

  /** Bind a scope to a machine, connecting it if needed (user-initiated). */
  private async activateForScope(
    scope: string,
    connectionId: string,
    updateLastConnected: boolean,
    persistSelection = true,
    generation = this.captureScopeGeneration(scope),
  ): Promise<void> {
    this.assertScopeGeneration(scope, generation);
    const backend = this.findBackend(connectionId);
    if (!backend) throw new Error("That saved connection no longer exists.");
    if (
      !orderedRoutes(backend).some(
        (route) => route.encryptedToken || this.sessionTokens.has(route.id),
      )
    ) {
      throw new Error("Enter the gateway token to reconnect to this server.");
    }
    this.secureStorageAvailable = await this.detectSecureStorage();
    this.assertScopeGeneration(scope, generation);
    const existing = this.remoteConnections.get(connectionId);
    let established: Established;
    try {
      established = await this.establish(backend, {
        interactive: true,
        ...(existing ? { preferRouteId: existing.routeId } : {}),
      });
    } catch (error) {
      // The machine list shows why; the caller still gets the error.
      const failure = classifyRouteFailure(error);
      if (failure.code !== "cancelled") {
        this.setStatus(connectionId, { transport: failure.state, detail: failure.message });
      }
      throw error;
    }
    try {
      this.assertScopeGeneration(scope, generation);
    } catch (error) {
      if (!existing || existing.transport !== established.transport)
        established.transport.release();
      throw error;
    }
    const now = new Date().toISOString();
    const commit = this.mutateCatalogue((current) => {
      this.assertScopeGeneration(scope, generation);
      let record = current.backends.find((entry) => entry.id === connectionId);
      if (!record) throw new Error("That saved connection no longer exists.");
      if (updateLastConnected) {
        const currentRoute =
          record.routes.find((route) => route.id === established.route.id) ?? established.route;
        record = replaceRoute(
          { ...record, lastConnectedAt: now },
          {
            ...currentRoute,
            lastConnectedAt: now,
          },
        );
      }
      if (established.outcome.kind === "hello") {
        record = this.recordHello(record, established.outcome.hello);
      }
      const committed = record;
      return {
        ...current,
        backends: current.backends.map((entry) => (entry.id === committed.id ? committed : entry)),
        activeConnectionId: persistSelection ? committed.id : current.activeConnectionId,
      };
    });
    try {
      if (persistSelection) await commit;
      else await commit.catch(() => undefined);
      this.assertScopeGeneration(scope, generation);
    } catch (error) {
      if (!existing || existing.transport !== established.transport)
        established.transport.release();
      throw error;
    }
    this.adoptEstablished(connectionId, established, false);
    this.bindScope(scope, connectionId);
  }

  /**
   * Reconnect a bound machine without user interaction. One attempt
   * per machine is coalesced, and at most four run at once across machines,
   * so one slow host never holds the others.
   */
  private backgroundActivate(connectionId: string): Promise<RemoteConnection | null> {
    const existing = this.remoteConnections.get(connectionId);
    if (existing) return Promise.resolve(existing);
    const pending = this.activations.get(connectionId);
    if (pending) return pending.catch(() => null);
    const attempt = (async () => {
      await this.backgroundAttempts.acquire();
      try {
        const backend = this.findBackend(connectionId);
        if (!backend || this.disposed) throw new Error("That saved connection no longer exists.");
        if (!this.isWanted(connectionId)) throw routeError("cancelled", "No longer in use.", false);
        this.setStatus(connectionId, { transport: "connecting" });
        const established = await this.establish(backend, { interactive: false });
        if (!this.isWanted(connectionId) || !this.findBackend(connectionId)) {
          established.transport.release();
          throw routeError("cancelled", "No longer in use.", false);
        }
        const already = this.remoteConnections.get(connectionId);
        if (already) {
          established.transport.release();
          return already;
        }
        this.adoptEstablished(connectionId, established, true);
        return this.remoteConnections.get(connectionId)!;
      } finally {
        this.backgroundAttempts.release();
      }
    })();
    this.activations.set(connectionId, attempt);
    attempt.then(
      () => {
        this.activations.delete(connectionId);
        this.reconnects.cancel(connectionId);
      },
      (error) => {
        this.activations.delete(connectionId);
        this.recordFailure(connectionId, error);
      },
    );
    return attempt.catch(() => null);
  }

  private establish(
    backend: SavedBackend,
    options: { interactive: boolean; preferRouteId?: RouteId; onlyRouteId?: RouteId },
  ): Promise<Established> {
    return establishRoute(
      {
        status: this.statusFor(backend.id),
        supportedRouteKinds: this.supportedRouteKinds(),
        routeFallback: this.catalogue.features.routeFallback,
        timeoutMs: this.connectionTimeoutMs,
        sshTunnels: this.sshTunnels,
        resolveToken: (route) => this.resolveToken(route, true),
      },
      backend,
      options,
    );
  }

  /** Install an established route as the machine's live connection. */
  private adoptEstablished(connectionId: string, established: Established, fresh: boolean): void {
    const existing = this.remoteConnections.get(connectionId);
    if (existing && existing.transport === established.transport) return;
    this.sessionTokens.set(established.route.id, established.token);
    this.markHello(connectionId, established.outcome);
    if (established.outcome.kind === "hello") {
      const hello = established.outcome.hello;
      const backend = this.findBackend(connectionId);
      if (backend && this.recordHello(backend, hello) !== backend) {
        void this.updateBackend(connectionId, (current) => this.recordHello(current, hello)).catch(
          () => undefined,
        );
      }
    }
    this.installRemote(
      connectionId,
      established.route,
      established.transport,
      established.token,
      established.outcome,
    );
    if (fresh) this.emitStateChange();
  }

  private installRemote(
    connectionId: string,
    route: SavedRoute,
    transport: OpenedRoute,
    token: string,
    outcome: HelloOutcome,
  ): void {
    const generation = outcome.kind === "hello" ? outcome.hello.generation : null;
    const existing = this.remoteConnections.get(connectionId);
    if (existing) {
      const sameRoute =
        existing.routeId === route.id &&
        existing.client.origin === new URL(transport.baseUrl).origin;
      if (
        sameRoute &&
        existing.token === token &&
        !existing.client.isSuspended &&
        generation === existing.generation
      ) {
        if (existing.transport !== transport) transport.release();
        existing.generation = generation ?? existing.generation;
        return;
      }
      const previousTransport = existing.transport;
      existing.unsubscribeTransport?.();
      existing.routeId = route.id;
      existing.transport = transport;
      existing.unsubscribeTransport = this.watchTransport(connectionId, transport);
      this.retargetRemote(
        existing,
        transport.baseUrl,
        token,
        generation !== null && generation === existing.generation,
      );
      existing.generation = generation;
      if (previousTransport !== transport) previousTransport.release();
      return;
    }
    const client = new BackendHttpClient(transport.baseUrl, token);
    const remote: RemoteConnection = {
      connectionId,
      routeId: route.id,
      client,
      token,
      scopes: new Set(),
      epoch: this.nextEpoch++,
      transport,
      unsubscribeTransport: null,
      generation,
      streamFailures: 0,
      handover: null,
    };
    remote.unsubscribeTransport = this.watchTransport(connectionId, transport);
    this.remoteConnections.set(connectionId, remote);
    this.setStatus(connectionId, { transport: "connected", detail: undefined });
    client.listen(
      (event, payload) => {
        if (this.remoteConnections.get(connectionId)?.client === client) {
          this.handleRemoteEvent(connectionId, event, payload);
        }
      },
      { onStreamState: (state) => this.handleStreamState(connectionId, client, state) },
    );
  }

  private retargetRemote(
    remote: RemoteConnection,
    baseUrl: string | null,
    token: string,
    preserveCursor: boolean,
  ): void {
    remote.token = token;
    remote.epoch = this.nextEpoch++;
    remote.streamFailures = 0;
    remote.client.retarget(baseUrl ?? remote.client.origin, token, { preserveCursor });
    this.emitStateChange();
  }

  private watchTransport(connectionId: string, transport: OpenedRoute): (() => void) | null {
    return (
      transport.onClosed?.((failure) => {
        const remote = this.remoteConnections.get(connectionId);
        if (!remote || remote.transport !== transport) return;
        remote.client.suspend();
        this.setStatus(connectionId, {
          transport: "reconnecting",
          detail: sanitizeDiagnostic(failure.message),
        });
        this.startHandover(connectionId, "transport-closed");
      }) ?? null
    );
  }

  private handleStreamState(
    connectionId: string,
    client: BackendHttpClient,
    state: "open" | "closed",
  ): void {
    const remote = this.remoteConnections.get(connectionId);
    if (!remote || remote.client !== client) return;
    if (state === "open") {
      if (remote.streamFailures > 0) remote.epoch = this.nextEpoch++;
      remote.streamFailures = 0;
      this.setStatus(connectionId, { transport: "connected", detail: undefined });
      return;
    }
    remote.streamFailures += 1;
    if (remote.onWorkspaceUnavailable) {
      remote.client.suspend();
      remote.onWorkspaceUnavailable();
      return;
    }
    this.setStatus(connectionId, {
      transport: "reconnecting",
      detail: "Connection lost; reconnecting.",
    });
    const backend = this.findBackend(connectionId);
    const alternatives =
      backend?.routes.filter((route) => route.id !== remote.routeId && route.enabled).length ?? 0;
    if (
      remote.streamFailures >= STREAM_FAILURES_BEFORE_FALLBACK &&
      alternatives > 0 &&
      this.catalogue.features.routeFallback &&
      !remote.handover
    ) {
      this.startHandover(connectionId, "stream-failures");
    }
  }

  /**
   * Route handover: fence the old route with a new epoch, verify a candidate
   * (the current route first, then approved fallbacks), and let consumers
   * re-read authoritative snapshots. In-flight reads may be abandoned; an
   * abandoned mutation is never resubmitted here.
   */
  private startHandover(connectionId: string, _reason: string): void {
    const remote = this.remoteConnections.get(connectionId);
    if (!remote) return;
    const backend = this.findBackend(connectionId);
    if (!backend) return;
    remote.epoch = this.nextEpoch++;
    const activeRoute = backend.routes.find((route) => route.id === remote.routeId);
    if (!activeRoute?.enabled || _reason === "transport-closed") {
      remote.client.suspend();
      remote.unsubscribeTransport?.();
      remote.unsubscribeTransport = null;
      remote.transport.release();
    }
    if (remote.handover) return;
    remote.handover = (async () => {
      try {
        const established = await this.establish(backend, {
          interactive: false,
          preferRouteId: remote.routeId,
        });
        if (
          !this.findBackend(connectionId)?.routes.some(
            (route) => route.id === established.route.id && route.enabled,
          )
        ) {
          established.transport.release();
          throw routeError("route-disabled", "The route was disabled while connecting.", true);
        }
        if (this.remoteConnections.get(connectionId) !== remote) {
          established.transport.release();
          return;
        }
        this.adoptEstablished(connectionId, established, true);
        this.setStatus(connectionId, { transport: "connected", detail: undefined });
        this.reconnects.cancel(connectionId);
      } catch (error) {
        if (!classifyRouteFailure(error).retryable) remote.client.suspend();
        this.recordFailure(connectionId, error);
      } finally {
        if (this.remoteConnections.get(connectionId) === remote) remote.handover = null;
      }
    })();
  }

  private recordFailure(connectionId: string, error: unknown): void {
    if (!this.findBackend(connectionId)) return;
    const failure = classifyRouteFailure(error);
    if (failure.code === "cancelled") return;
    this.setStatus(connectionId, { transport: failure.state, detail: failure.message });
    if (failure.retryable && this.isWanted(connectionId)) this.reconnects.schedule(connectionId);
  }

  private isWanted(connectionId: string): boolean {
    const remote = this.remoteConnections.get(connectionId);
    if (remote && remote.scopes.size > 0) return true;
    for (const [scope, boundId] of this.bindings) {
      if (boundId === connectionId && scope) return true;
    }
    return false;
  }

  private releaseIfUnused(connectionId: string): void {
    const remote = this.remoteConnections.get(connectionId);
    if (!remote) return;
    if (remote.scopes.size > 0) return;
    this.teardownRemote(connectionId);
    this.reconnects.cancel(connectionId);
    const status = this.statuses.get(connectionId);
    if (status) status.transport = "disabled";
  }

  private teardownRemote(connectionId: string): void {
    const remote = this.remoteConnections.get(connectionId);
    if (!remote) return;
    remote.client.stopListening();
    remote.unsubscribeTransport?.();
    remote.transport.release();
    this.remoteConnections.delete(connectionId);
  }

  /** Bind after the machine's own (already established) connection, if any. */
  private bindScopeAfterActivation(scope: string, connectionId: string): void {
    if (this.remoteConnections.has(connectionId)) this.bindScope(scope, connectionId);
  }

  private bindScope(scope: string, connectionId: string): void {
    this.releaseScopeRemote(scope);
    const remote = this.remoteConnections.get(connectionId);
    remote?.scopes.add(scope);
    this.bindings.set(scope, connectionId);
  }

  private setScopeLocal(scope: string): void {
    this.releaseScopeRemote(scope);
    this.bindings.set(scope, LOCAL_CONNECTION_ID);
  }

  private releaseScopeRemote(scope: string): void {
    const connectionId = this.bindings.get(scope);
    if (!connectionId || connectionId === LOCAL_CONNECTION_ID) return;
    const remote = this.remoteConnections.get(connectionId);
    if (!remote) return;
    remote.scopes.delete(scope);
    this.releaseIfUnused(connectionId);
  }

  private remoteForScope(scope: string): RemoteConnection | null {
    const connectionId = this.connectionIdForScope(scope);
    return connectionId === LOCAL_CONNECTION_ID
      ? null
      : (this.remoteConnections.get(connectionId) ?? null);
  }

  private connectionIdForScope(scope: string): string {
    const connectionId = this.bindings.get(scope);
    if (connectionId) return connectionId;
    if (scope === DEFAULT_CONNECTION_SCOPE) return this.catalogue.activeConnectionId;
    throw new Error("The requesting window is no longer available.");
  }

  private captureScopeGeneration(scope: string): number {
    const generation = this.scopeGenerations.get(scope);
    if (generation === undefined) {
      throw new Error("The requesting window is no longer available.");
    }
    return generation;
  }

  private assertScopeGeneration(scope: string, generation: number): void {
    if (this.scopeGenerations.get(scope) !== generation) {
      throw new Error("The requesting window is no longer available.");
    }
  }

  private assertScopeConnection(scope: string, generation: number, connectionId: string): void {
    this.assertScopeGeneration(scope, generation);
    if (this.connectionIdForScope(scope) !== connectionId) {
      throw new Error("The requesting window changed connections before the operation started.");
    }
  }

  /*
   * Events
   */

  private handleRemoteEvent(connectionId: string, event: string, payload: unknown): void {
    if (event === BACKEND_PROFILE_CHANGED_EVENT) this.applyProfileEvent(connectionId, payload);
    this.dispatchConnectionEvent(connectionId, event, payload);
  }

  private applyProfileEvent(connectionId: string, payload: unknown): void {
    const status = this.statuses.get(connectionId);
    if (!status?.hello) return;
    try {
      const profile = parseBackendProfile(payload);
      if (profile.revision < status.hello.profile.revision) return;
      status.hello = { ...status.hello, profile };
      const hello = status.hello;
      if (this.findBackend(connectionId)) {
        void this.updateBackend(connectionId, (current) => this.recordHello(current, hello)).catch(
          () => undefined,
        );
      }
      this.emitStateChange();
    } catch {
      // Malformed profile events change nothing; the next hello reconciles.
    }
  }

  private dispatchConnectionEvent(connectionId: string, event: string, payload: unknown): void {
    this.onConnectionEvent?.(connectionId, event, payload);
    if (this.connectionIdForScope(DEFAULT_CONNECTION_SCOPE) === connectionId) {
      this.onEvent(event, payload);
    }
  }

  /*
   * Identity and status
   */

  private async refreshLocalHello(): Promise<void> {
    if (!this.localBackendAvailable || !this.localBackend.hello) return;
    try {
      this.localHello = await this.localBackend.hello(LOCAL_HELLO_TIMEOUT_MS);
    } catch {
      this.localHello = null;
    }
  }

  /** Re-read the local backend's identity, e.g. after it restarted. */
  async refreshLocal(): Promise<void> {
    await this.refreshLocalHello();
    this.emitStateChange();
  }

  private recordHello(backend: SavedBackend, hello: BackendHello): SavedBackend {
    const cache = {
      displayName: hello.profile.displayName,
      colorToken: hello.profile.colorToken,
      revision: hello.profile.revision,
    };
    const sameCache =
      backend.profileCache?.displayName === cache.displayName &&
      backend.profileCache.colorToken === cache.colorToken &&
      backend.profileCache.revision === cache.revision;
    if (backend.verifiedInstallationId === hello.installationId && sameCache) return backend;
    return {
      ...backend,
      verifiedInstallationId: backend.verifiedInstallationId ?? hello.installationId,
      profileCache: cache,
    };
  }

  private markHello(connectionId: string, outcome: HelloOutcome): void {
    const status = this.statusFor(connectionId);
    if (outcome.kind !== "hello") {
      status.identity = "provisional";
      delete status.hello;
      if (outcome.latencyMs !== undefined) status.latencyMs = outcome.latencyMs;
      return;
    }
    status.hello = outcome.hello;
    status.lastHelloAt = new Date().toISOString();
    if (outcome.latencyMs !== undefined) status.latencyMs = outcome.latencyMs;
    const duplicate = this.catalogue.backends.some(
      (backend) =>
        backend.id !== connectionId &&
        backend.verifiedInstallationId === outcome.hello.installationId,
    );
    status.identity = duplicate ? "conflict" : "verified";
    if (duplicate) {
      status.detail =
        "Another saved machine claims the same installation identity. Merge or remove one before using automatic fallback.";
    }
  }

  private statusFor(connectionId: string): MachineStatus {
    let status = this.statuses.get(connectionId);
    if (!status) {
      const backend = this.findBackend(connectionId);
      status = {
        transport: "disabled",
        identity: backend?.verifiedInstallationId ? "verified" : "provisional",
        blockedRoutes: new Map(),
      };
      this.statuses.set(connectionId, status);
    }
    return status;
  }

  private blockedRoutes(connectionId: string): Map<string, string> {
    return this.statusFor(connectionId).blockedRoutes;
  }

  private setStatus(
    connectionId: string,
    update: { transport: ConnectionTransportState; detail?: string | undefined },
  ): void {
    const status = this.statusFor(connectionId);
    const changed = status.transport !== update.transport || status.detail !== update.detail;
    status.transport = update.transport;
    if (update.detail === undefined) delete status.detail;
    else status.detail = update.detail;
    if (changed) this.emitStateChange();
  }

  private emitStateChange(): void {
    this.onStateChange?.();
  }

  /*
   * Catalogue
   */

  private knownAddresses(): string[] {
    const active = this.findBackend(this.catalogue.activeConnectionId);
    return [active, ...this.catalogue.backends].flatMap((backend) => {
      const address = backend ? backendAddress(backend) : null;
      return address ? [address] : [];
    });
  }

  private findBackend(connectionId: string): SavedBackend | undefined {
    return this.catalogue.backends.find((backend) => backend.id === connectionId);
  }

  private requireBackend(connectionId: string): SavedBackend {
    if (connectionId === LOCAL_CONNECTION_ID) {
      throw new Error("The Local connection has no saved routes.");
    }
    const backend = this.findBackend(connectionId);
    if (!backend) throw new Error("That saved connection no longer exists.");
    return backend;
  }

  private withBackend(record: SavedBackend): DeviceCatalogue {
    return {
      ...this.catalogue,
      backends: this.catalogue.backends.map((backend) =>
        backend.id === record.id ? record : backend,
      ),
    };
  }

  /**
   * Apply a change to the latest catalogue under the short catalogue lock,
   * persist it, then adopt it. A failed save leaves memory unchanged.
   */
  private mutateCatalogue(
    mutate: (current: DeviceCatalogue) => DeviceCatalogue,
  ): Promise<DeviceCatalogue> {
    return this.enqueueCatalogue(async () => {
      const candidate = mutate(this.catalogue);
      await this.persist(candidate);
      this.catalogue = candidate;
      return candidate;
    });
  }

  private updateBackend(
    connectionId: string,
    mutate: (backend: SavedBackend) => SavedBackend,
  ): Promise<DeviceCatalogue> {
    return this.mutateCatalogue((current) => {
      const backend = current.backends.find((entry) => entry.id === connectionId);
      if (!backend) {
        throw new Error(
          connectionId === LOCAL_CONNECTION_ID
            ? "The Local connection has no saved routes."
            : "That saved connection no longer exists.",
        );
      }
      const record = mutate(backend);
      return {
        ...current,
        backends: current.backends.map((entry) => (entry.id === record.id ? record : entry)),
      };
    });
  }

  /**
   * The saved machines with their decrypted gateway tokens, for the one-time
   * import into the local command node's registry. Tokens leave Electron
   * main only in the request to the local backend; a route whose token
   * cannot be decrypted contributes none.
   */
  async savedMachinesForCommandNode(): Promise<SavedMachineExport[]> {
    const machines: SavedMachineExport[] = [];
    for (const backend of this.catalogue.backends) {
      let token: string | null = null;
      for (const route of orderedRoutes(backend)) {
        try {
          token = await this.resolveToken(route, false);
        } catch {
          token = null;
        }
        if (token) break;
      }
      machines.push({ backend, token });
    }
    return machines;
  }

  private async resolveToken(route: SavedRoute, reEncrypt: boolean): Promise<string | null> {
    const sessionToken = this.sessionTokens.get(route.id);
    if (sessionToken) return sessionToken;
    if (!route.encryptedToken) return null;
    if (!this.secureStorageAvailable) {
      throw connectionCheckError(
        "authentication-required",
        "Secure credential storage is unavailable. Enter the gateway token again.",
      );
    }
    const decrypted = await this.secureStorage.decryptStringAsync(
      Buffer.from(route.encryptedToken, "base64"),
    );
    const token = normalizeGatewayToken(decrypted.result);
    if (reEncrypt && decrypted.shouldReEncrypt) {
      const encryptedToken = (await this.secureStorage.encryptStringAsync(token)).toString(
        "base64",
      );
      const backend = this.catalogue.backends.find((candidate) =>
        candidate.routes.some((candidateRoute) => candidateRoute.id === route.id),
      );
      if (backend) {
        this.catalogue = this.withBackend(replaceRoute(backend, { ...route, encryptedToken }));
      }
    }
    return token;
  }

  private async encryptForStorage(token: string): Promise<string> {
    return this.secureStorageAvailable
      ? (await this.secureStorage.encryptStringAsync(token)).toString("base64")
      : "";
  }

  private async checkStatus(baseUrl: string, token: string, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL("/__orkestrator/status", baseUrl), {
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean };
      return response.ok && payload.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async detectSecureStorage(): Promise<boolean> {
    if (!(await this.secureStorage.isAsyncEncryptionAvailable())) return false;
    return (
      this.platform !== "linux" || this.secureStorage.getSelectedStorageBackend?.() !== "basic_text"
    );
  }

  /** Serialize work per window scope; another window's connect never waits on this one. */
  private enqueueScope<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.scopeQueues.get(scope) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.scopeQueues.set(scope, settled);
    return next;
  }

  /** A short lock for catalogue writes; never held while dialing a host. */
  private enqueueCatalogue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.catalogueQueue.then(operation, operation);
    this.catalogueQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async persist(catalogue: DeviceCatalogue): Promise<void> {
    // The in-memory catalogue keeps remote windows usable if the store is
    // unavailable (legacy mode while the local backend is down).
    await this.store.save(catalogue);
  }
}
