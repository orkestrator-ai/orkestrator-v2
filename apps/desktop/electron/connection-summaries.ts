import { defaultMachineColor, type BackendHello } from "@orkestrator/protocol/backend-profile";
import {
  LOCAL_CONNECTION_ID,
  type ConnectionIdentityState,
  type ConnectionRouteSummary,
  type ConnectionSummary,
} from "@orkestrator/protocol/connections";
import {
  describeRoute,
  orderedRoutes,
  type SavedBackend,
} from "@orkestrator/protocol/device-catalogue";
import { backendAddress, type MachineStatus } from "./connection-records.js";

/** Renderer-safe machine summaries: routes are described, never their credentials. */

export function localConnectionSummary(
  hello: BackendHello | null,
  localAvailable: boolean,
  activeConnectionId: string,
): ConnectionSummary {
  return {
    id: LOCAL_CONNECTION_ID,
    name: "Local",
    address: null,
    kind: "local",
    active: activeConnectionId === LOCAL_CONNECTION_ID,
    requiresToken: false,
    transport: localAvailable ? "connected" : "unreachable",
    ...(localAvailable
      ? {}
      : { transportDetail: "The Local backend on this computer is not running." }),
    identity: hello ? "verified" : "provisional",
    ...(hello
      ? {
          backendId: hello.installationId,
          generation: hello.generation,
          profile: {
            displayName: hello.profile.displayName,
            colorToken: hello.profile.colorToken,
            revision: hello.profile.revision,
            cached: false,
          },
        }
      : {}),
    routes: [
      {
        id: LOCAL_CONNECTION_ID,
        kind: "local",
        label: "This computer",
        enabled: true,
        active: true,
        supported: true,
      },
    ],
  };
}

export function backendConnectionSummary(input: {
  backend: SavedBackend;
  status: MachineStatus | undefined;
  activeRouteId: string | null;
  activeConnectionId: string;
  supportedRouteKinds: ReadonlyArray<"https" | "ssh">;
  hasSessionToken(routeId: string): boolean;
}): ConnectionSummary {
  const { backend, status, activeRouteId, activeConnectionId, supportedRouteKinds } = input;
  const hello = status?.hello;
  const profile = hello
    ? {
        displayName: hello.profile.displayName,
        colorToken: hello.profile.colorToken,
        revision: hello.profile.revision,
        cached: false,
      }
    : backend.profileCache
      ? { ...backend.profileCache, cached: true }
      : {
          // No canonical profile yet (unverified or older backend): the
          // colour persisted with this device's entry, labelled as cached.
          displayName: backend.localAlias || backend.fallbackName,
          colorToken: backend.provisionalColor ?? defaultMachineColor(backend.id),
          revision: 0,
          cached: true,
        };
  const routes: ConnectionRouteSummary[] = orderedRoutes(backend).map((route) => {
    const blockedReason = status?.blockedRoutes.get(route.id);
    return {
      id: route.id,
      kind: route.kind,
      label: describeRoute(route),
      enabled: route.enabled,
      active: activeRouteId === route.id,
      supported: supportedRouteKinds.includes(route.kind),
      ...(blockedReason ? { blockedReason } : {}),
      ...(route.kind === "ssh"
        ? {
            sshDestination: route.destination,
            ...(route.sshPort ? { sshPort: route.sshPort } : {}),
          }
        : {}),
    };
  });
  const identity: ConnectionIdentityState =
    status?.identity ?? (backend.verifiedInstallationId ? "verified" : "provisional");
  return {
    id: backend.id,
    name: backend.localAlias || backend.fallbackName,
    ...(backend.localAlias ? { nickname: backend.localAlias } : {}),
    address: backendAddress(backend),
    kind: "remote",
    active: activeConnectionId === backend.id,
    requiresToken:
      backend.id !== activeConnectionId &&
      !orderedRoutes(backend).some(
        (route) => route.encryptedToken || input.hasSessionToken(route.id),
      ),
    ...(backend.lastConnectedAt ? { lastConnectedAt: backend.lastConnectedAt } : {}),
    ...(backend.verifiedInstallationId && identity === "verified"
      ? { backendId: backend.verifiedInstallationId }
      : {}),
    identity,
    ...(profile ? { profile } : {}),
    transport: status?.transport ?? (activeRouteId ? "connected" : "disabled"),
    ...(status?.detail ? { transportDetail: status.detail } : {}),
    routes,
    ...(hello ? { generation: hello.generation } : {}),
    ...(status?.lastHelloAt ? { lastHelloAt: status.lastHelloAt } : {}),
    ...(status?.latencyMs !== undefined ? { latencyMs: status.latencyMs } : {}),
    ...(hello ? { capabilities: Object.keys(hello.capabilities) } : {}),
    autoConnect: backend.autoConnect,
  };
}
