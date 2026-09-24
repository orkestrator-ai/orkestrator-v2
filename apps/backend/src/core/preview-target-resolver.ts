import { connect } from "node:net";

import {
  previewError,
  type PreviewServiceDefinition,
} from "@orkestrator/protocol/preview-services";

import {
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  CURSOR_BRIDGE_PORT,
  GROK_ACP_BRIDGE_PORT,
  OPENCODE_SERVER_PORT,
  PI_BRIDGE_PORT,
} from "./constants.js";
import type { Environment } from "./models.js";
import type {
  PreviewResolution,
  PreviewTargetResolverPort,
  ResolvedPreviewTarget,
} from "./preview-service-registry.js";

export type DockerRunner = (
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string }>;

export interface PreviewTargetResolverOptions {
  runDocker: DockerRunner;
  /** `orkestrator-owner` label value this backend creates containers with. */
  dockerOwner: string;
  /** Require the owner label to be present (packaged/strict profiles). */
  strictOwner: boolean;
  /** Ports that belong to Orkestrator itself and may never become preview targets. */
  reservedPorts: () => Promise<ReadonlySet<number>> | ReadonlySet<number>;
  /** Inspect results are shared by related services for this long. */
  inspectCacheMs?: number;
  inspectTimeoutMs?: number;
  /** Loopback family probe used by `addressFamily: "auto"`. */
  probeFamily?: (host: "127.0.0.1" | "::1", port: number, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  /** Optional relay adapter (step 13). */
  relay?: {
    available(environment: Environment): boolean;
  };
}

export interface ContainerInspection {
  id: string;
  status: string;
  owner: string;
  environmentId: string;
  ports: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
}

/** Docker's container API, CLI, and managed-bridge ports, plus well-known daemon ports. */
const ALWAYS_RESERVED = new Set([2375, 2376]);

/**
 * Agent servers inside owned containers. They are published for the backend's
 * own use and reachable through the relay, but are never preview targets.
 */
const CONTAINER_AGENT_PORTS = new Set([
  OPENCODE_SERVER_PORT,
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  CURSOR_BRIDGE_PORT,
  GROK_ACP_BRIDGE_PORT,
  PI_BRIDGE_PORT,
]);

const INSPECT_FORMAT =
  '{{.Id}}\t{{.State.Status}}\t{{index .Config.Labels "orkestrator-owner"}}\t{{index .Config.Labels "environment-id"}}\t{{json .NetworkSettings.Ports}}';

export function parseContainerInspection(stdout: string): ContainerInspection | null {
  const line = stdout.trim().split("\n")[0] ?? "";
  const [id, status, owner, environmentId, portsJson] = line.split("\t");
  if (!id || !status || portsJson === undefined) return null;
  let ports: ContainerInspection["ports"] = {};
  try {
    const parsed: unknown = JSON.parse(portsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      ports = parsed as ContainerInspection["ports"];
  } catch {
    return null;
  }
  return {
    id,
    status,
    owner: owner === "<no value>" ? "" : (owner ?? ""),
    environmentId: environmentId === "<no value>" ? "" : (environmentId ?? ""),
    ports,
  };
}

/**
 * Choose a loopback-reachable binding for one container port. Docker may list
 * IPv4 and IPv6 bindings, wildcard and specific addresses. A binding on a
 * non-loopback interface is not something this backend should dial.
 */
export function selectLoopbackBinding(
  bindings: Array<{ HostIp?: string; HostPort?: string }>,
): { host: "127.0.0.1" | "::1"; family: "ipv4" | "ipv6"; port: number } | null {
  const candidates: Array<{
    rank: number;
    host: "127.0.0.1" | "::1";
    family: "ipv4" | "ipv6";
    port: number;
  }> = [];
  for (const binding of bindings) {
    const port = Number(binding.HostPort);
    if (!/^[1-9]\d{0,4}$/.test(binding.HostPort ?? "") || port > 65_535) continue;
    const ip = (binding.HostIp ?? "").replace(/^\[|\]$/g, "");
    if (ip === "127.0.0.1") candidates.push({ rank: 0, host: "127.0.0.1", family: "ipv4", port });
    else if (ip === "" || ip === "0.0.0.0")
      candidates.push({ rank: 1, host: "127.0.0.1", family: "ipv4", port });
    else if (ip === "::1") candidates.push({ rank: 2, host: "::1", family: "ipv6", port });
    else if (ip === "::") candidates.push({ rank: 3, host: "::1", family: "ipv6", port });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  const best = candidates[0];
  return best ? { host: best.host, family: best.family, port: best.port } : null;
}

export function defaultProbeFamily(
  host: "127.0.0.1" | "::1",
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, family: host === "::1" ? 6 : 4 });
    const done = (value: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Maps a stable service to its currently authorized endpoint on the backend
 * machine. Container identity comes from backend storage, never from a request.
 * A missing publication is `target-unmapped` — there is no fallback to a
 * similarly numbered host port.
 */
export class PreviewTargetResolver implements PreviewTargetResolverPort {
  private readonly inspections = new Map<
    string,
    { at: number; promise: Promise<ContainerInspection | "missing"> }
  >();
  private readonly environmentContainers = new Map<string, string>();
  private readonly inspectCacheMs: number;
  private readonly inspectTimeoutMs: number;
  private readonly now: () => number;
  private readonly probeFamily: NonNullable<PreviewTargetResolverOptions["probeFamily"]>;
  private inflightInspections = 0;

  constructor(private readonly options: PreviewTargetResolverOptions) {
    this.inspectCacheMs = options.inspectCacheMs ?? 1_500;
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.probeFamily = options.probeFamily ?? defaultProbeFamily;
  }

  invalidate(environmentId: string, containerId?: string | null): void {
    const known = containerId ?? this.environmentContainers.get(environmentId);
    if (known) this.inspections.delete(known);
    this.environmentContainers.delete(environmentId);
  }

  stats() {
    return {
      cachedInspections: this.inspections.size,
      inflightInspections: this.inflightInspections,
    };
  }

  async resolve(
    definition: PreviewServiceDefinition,
    environment: Environment,
    { signal }: { signal: AbortSignal },
  ): Promise<PreviewResolution> {
    switch (definition.targetKind) {
      case "container":
        return this.resolveContainer(definition, environment, signal);
      case "worktree":
        if (environment.environmentType !== "local") {
          return {
            ok: false,
            error: previewError("target-unverified", {
              message: "Worktree services require a local environment.",
            }),
          };
        }
        if (environment.status !== "running") return this.stopped(environment);
        return this.resolveLoopback(definition, "user-registered");
      case "backend-host":
        return this.resolveLoopback(definition, "user-registered");
    }
  }

  private stopped(environment: Environment): PreviewResolution {
    return {
      ok: false,
      error: previewError("environment-stopped"),
      readiness: {
        environment: {
          state: "failed",
          lifecycle: environment.status === "stopped" ? "stopped" : "other",
          failure: "environment-stopped",
        },
        binding: { state: "skipped" },
      },
    };
  }

  private async resolveContainer(
    definition: PreviewServiceDefinition,
    environment: Environment,
    signal: AbortSignal,
  ): Promise<PreviewResolution> {
    if (environment.environmentType !== "containerized") {
      return {
        ok: false,
        error: previewError("target-unverified", {
          message: "Container services require a containerized environment.",
        }),
      };
    }
    if (CONTAINER_AGENT_PORTS.has(definition.applicationPort)) {
      return {
        ok: false,
        error: previewError("forbidden", {
          layer: "binding",
          message: `Container port ${definition.applicationPort} is an Orkestrator agent server and cannot be previewed.`,
        }),
      };
    }
    const containerId = environment.containerId;
    if (environment.status !== "running" || !containerId) return this.stopped(environment);
    this.environmentContainers.set(environment.id, containerId);
    let inspection: ContainerInspection | "missing";
    try {
      inspection = await this.inspect(containerId, signal);
    } catch (error) {
      if (signal.aborted) return { ok: false, error: previewError("generation-changed") };
      const timedOut = error instanceof Error && /timed? ?out/i.test(error.message);
      return {
        ok: false,
        error: previewError(timedOut ? "connect-timeout" : "backend-unavailable", {
          layer: "binding",
          message: timedOut
            ? "Docker did not answer in time."
            : "Docker is unavailable on the backend.",
        }),
      };
    }
    if (inspection === "missing") {
      return {
        ok: false,
        error: previewError("environment-stopped", {
          message: "The environment's container no longer exists.",
        }),
        readiness: {
          environment: { state: "failed", lifecycle: "missing", failure: "environment-stopped" },
        },
      };
    }
    // Ownership: the container must be this environment's container, created by
    // this backend profile. An environment id label that disagrees means the
    // stored container id points at someone else's container.
    const ownerMismatch = inspection.owner
      ? inspection.owner !== this.options.dockerOwner
      : this.options.strictOwner;
    if (inspection.environmentId !== environment.id || ownerMismatch) {
      return {
        ok: false,
        error: previewError("target-unverified", {
          message: "The container is not owned by this environment.",
        }),
      };
    }
    if (inspection.status !== "running") return this.stopped({ ...environment, status: "stopped" });

    const key = `${definition.applicationPort}/tcp`;
    const bindings = inspection.ports[key];
    if (!bindings || bindings.length === 0) {
      const relay = this.options.relay?.available(environment) ?? false;
      if (relay) {
        return {
          ok: true,
          target: {
            transportKind: "container-relay",
            host: "127.0.0.1",
            port: definition.applicationPort,
            addressFamily: "ipv4",
            containerId: inspection.id,
            ownership: "owned-container",
            bindingKey: `relay:${inspection.id}:${definition.applicationPort}`,
            tls:
              definition.scheme === "https"
                ? { servername: definition.tlsServerName ?? "localhost" }
                : null,
            relay: {
              environmentId: environment.id,
              containerId: inspection.id,
              port: definition.applicationPort,
            },
          },
        };
      }
      return {
        ok: false,
        error: previewError("target-unmapped", {
          message: `Container port ${definition.applicationPort} is not published. Add a mapping, or use the relay if available.`,
        }),
        readiness: {
          environment: { state: "ok", lifecycle: "running" },
          binding: { state: "failed", failure: "target-unmapped" },
        },
      };
    }
    const selected = selectLoopbackBinding(bindings);
    if (!selected) {
      return {
        ok: false,
        error: previewError("target-unmapped", {
          message: `Container port ${definition.applicationPort} is published only on a non-loopback interface.`,
        }),
        readiness: {
          environment: { state: "ok", lifecycle: "running" },
          binding: { state: "failed", failure: "target-unmapped" },
        },
      };
    }
    const target: ResolvedPreviewTarget = {
      transportKind: "published-port",
      host: selected.host,
      port: selected.port,
      addressFamily: selected.family,
      containerId: inspection.id,
      ownership: "owned-container",
      bindingKey: `container:${inspection.id}:${selected.family}:${selected.port}`,
      tls:
        definition.scheme === "https"
          ? { servername: definition.tlsServerName ?? "localhost" }
          : null,
    };
    return { ok: true, target };
  }

  private inspect(
    containerId: string,
    signal: AbortSignal,
  ): Promise<ContainerInspection | "missing"> {
    const cached = this.inspections.get(containerId);
    if (cached && this.now() - cached.at < this.inspectCacheMs) return cached.promise;
    this.inflightInspections += 1;
    const promise = this.options
      .runDocker(["inspect", "--type", "container", "--format", INSPECT_FORMAT, containerId], {
        timeoutMs: this.inspectTimeoutMs,
        signal,
      })
      .then(({ stdout }) => {
        const parsed = parseContainerInspection(stdout);
        if (!parsed) throw new Error("Unrecognized docker inspect output");
        return parsed;
      })
      .catch((error: unknown): "missing" => {
        const message = error instanceof Error ? error.message : String(error);
        if (/no such (object|container)/i.test(message)) return "missing";
        throw error;
      })
      .finally(() => {
        this.inflightInspections -= 1;
      });
    this.inspections.set(containerId, { at: this.now(), promise });
    // Failures are not cached: the next caller retries.
    promise.catch(() => {
      if (this.inspections.get(containerId)?.promise === promise)
        this.inspections.delete(containerId);
    });
    // Bound the cache: containers come and go with environments.
    if (this.inspections.size > 256) {
      const oldest = this.inspections.keys().next().value;
      if (oldest) this.inspections.delete(oldest);
    }
    return promise;
  }

  private async resolveLoopback(
    definition: PreviewServiceDefinition,
    ownership: "user-registered" | "managed-process",
  ): Promise<PreviewResolution> {
    const reserved = await this.options.reservedPorts();
    if (
      ALWAYS_RESERVED.has(definition.applicationPort) ||
      reserved.has(definition.applicationPort)
    ) {
      return {
        ok: false,
        error: previewError("forbidden", {
          layer: "binding",
          message: `Port ${definition.applicationPort} belongs to Orkestrator or Docker and cannot be previewed.`,
        }),
      };
    }
    let family: "ipv4" | "ipv6";
    if (definition.addressFamily === "ipv4") family = "ipv4";
    else if (definition.addressFamily === "ipv6") family = "ipv6";
    else if (await this.probeFamily("127.0.0.1", definition.applicationPort, 500)) family = "ipv4";
    else if (await this.probeFamily("::1", definition.applicationPort, 500)) family = "ipv6";
    else family = "ipv4";
    const host = family === "ipv6" ? "::1" : "127.0.0.1";
    return {
      ok: true,
      target: {
        transportKind: "backend-loopback",
        host,
        port: definition.applicationPort,
        addressFamily: family,
        containerId: null,
        ownership,
        bindingKey: `loopback:${family}:${definition.applicationPort}`,
        tls:
          definition.scheme === "https"
            ? { servername: definition.tlsServerName ?? "localhost" }
            : null,
      },
    };
  }
}
