import {
  describeRoute,
  orderedRoutes,
  type SavedBackend,
  type SavedRoute,
} from "@orkestrator/protocol/device-catalogue";
import type { RouteId } from "@orkestrator/protocol/federation";
import { checkBackendRoute, connectionCheckError, type HelloOutcome } from "./backend-hello.js";
import type { Established, MachineStatus } from "./connection-records.js";
import {
  classifyRouteFailure,
  openRoute,
  routeError,
  type OpenedRoute,
  type SshTunnelProvider,
} from "./connection-routes.js";

export type RouteSelectionContext = {
  status: MachineStatus;
  supportedRouteKinds: ReadonlyArray<"https" | "ssh">;
  routeFallback: boolean;
  timeoutMs: number;
  sshTunnels: SshTunnelProvider | null;
  resolveToken(route: SavedRoute): Promise<string | null>;
};

/**
 * Try a machine's routes in the user's order. A retryable network failure
 * moves on to the next approved route only for a verified machine with
 * fallback enabled and an equivalent credential; a trust, credential or
 * compatibility failure stops and is reported — it is never hidden by
 * trying somewhere else.
 */
export async function establishRoute(
  context: RouteSelectionContext,
  backend: SavedBackend,
  options: { interactive: boolean; preferRouteId?: RouteId; onlyRouteId?: RouteId },
): Promise<Established> {
  const status = context.status;
  const supported = context.supportedRouteKinds;
  let candidates = orderedRoutes(backend).filter(
    (route) => route.enabled && supported.includes(route.kind),
  );
  if (options.onlyRouteId) {
    candidates = orderedRoutes(backend).filter((route) => route.id === options.onlyRouteId);
    if (candidates[0] && !supported.includes(candidates[0].kind)) {
      throw routeError("ssh-unavailable", "This client cannot open SSH routes.", false);
    }
  } else {
    candidates = candidates.filter((route) => !status.blockedRoutes.has(route.id));
    if (options.preferRouteId) {
      candidates.sort(
        (a, b) => Number(b.id === options.preferRouteId) - Number(a.id === options.preferRouteId),
      );
    }
  }
  if (candidates.length === 0) {
    const blocked = Array.from(status.blockedRoutes.values())[0];
    if (blocked) throw routeError("identity-mismatch", blocked, false);
    throw routeError(
      "no-route",
      orderedRoutes(backend).some((route) => route.kind === "ssh")
        ? "This machine only has SSH routes, which need the desktop app. Add its HTTPS route to use it here."
        : "This machine has no enabled connection method.",
      false,
    );
  }
  const fallbackAllowed =
    !options.onlyRouteId &&
    context.routeFallback &&
    Boolean(backend.verifiedInstallationId) &&
    status.identity !== "conflict";
  let firstToken: string | null = null;
  let lastError: unknown = null;
  for (const [index, route] of candidates.entries()) {
    if (index > 0 && !fallbackAllowed) break;
    let token: string | null;
    try {
      token = await context.resolveToken(route);
    } catch {
      throw connectionCheckError(
        "authentication-required",
        "The route credential could not be resolved.",
      );
    }
    if (!token) {
      lastError = connectionCheckError(
        "authentication-required",
        "Enter the gateway token to reconnect to this server.",
      );
      // Without the first route's credential, grant equivalence cannot be
      // established; a different route needs an explicit choice.
      break;
    }
    // Automatic fallback never changes effective access: only a route
    // holding the same grant may take over without an explicit choice.
    if (index > 0 && firstToken && token !== firstToken) continue;
    if (index === 0) firstToken = token;
    let transport: OpenedRoute;
    try {
      transport = await openRoute(route, {
        interactive: options.interactive,
        ssh: context.sshTunnels,
      });
    } catch (error) {
      lastError = error;
      if (!classifyRouteFailure(error).retryable) break;
      continue;
    }
    try {
      const outcome = await checkBackendRoute(transport.baseUrl, token, {
        timeoutMs: context.timeoutMs,
        ...(route.kind === "ssh"
          ? {
              unreachableMessage:
                "The SSH connection worked, but no Orkestrator client gateway answered on that remote port.",
            }
          : {}),
      });
      if (route.kind === "ssh") assertSshOutcome(outcome);
      if (outcome.kind === "hello") {
        if (
          backend.verifiedInstallationId &&
          outcome.hello.installationId !== backend.verifiedInstallationId
        ) {
          throw identityMismatch(backend, describeRoute(route));
        }
      } else if (backend.verifiedInstallationId && index > 0) {
        // A fallback that cannot prove identity is not the same machine.
        throw routeError(
          "identity-mismatch",
          "This route could not prove the machine's identity.",
          false,
        );
      }
      return { route, transport, token, outcome };
    } catch (error) {
      transport.release();
      lastError = error;
      const failure = classifyRouteFailure(error);
      if (failure.quarantine) {
        status.blockedRoutes.set(route.id, failure.message);
        break;
      }
      if (!failure.retryable) break;
    }
  }
  throw lastError ?? new Error("Could not connect to this machine.");
}

export function assertSshOutcome(outcome: HelloOutcome): void {
  if (outcome.kind !== "hello") {
    throw routeError(
      "legacy-backend",
      "This backend is too old for SSH routes. Update it, or use its HTTPS route.",
      false,
    );
  }
  if (outcome.hello.endpointRole !== "client") {
    throw routeError(
      "control-endpoint",
      "That remote port is Orkestrator's privileged control listener. Forward the loopback client gateway instead (see --loopback-client-port).",
      false,
    );
  }
}

export function identityMismatch(backend: SavedBackend, routeLabel: string) {
  return routeError(
    "identity-mismatch",
    `${routeLabel} answered as a different Orkestrator installation than ${backend.localAlias || backend.fallbackName}. Nothing was merged; check the address or re-pair the machine.`,
    false,
  );
}
