import { runCommand } from "./commands-dependencies.js";
import type { EnvironmentStatus } from "./commands-dependencies.js";

/**
 * The one primitive every container-facing command module needs.
 *
 * It lives in its own leaf rather than in `commands-environment` because six of
 * that module's own consumers import nothing from it but this function. Hosting
 * it there made each of them a back-edge into `commands-environment` and turned
 * the `commands-*` graph cyclic; a cycle in this group already had to be worked
 * around once (see the lazy scanner import in `commands-runtime-state`). This
 * module must therefore depend only on `commands-dependencies`.
 */
export async function dockerExec(
  containerId: string,
  command: string,
  timeoutMs = 120_000,
  redactValues?: ReadonlyArray<string | null | undefined>,
): Promise<string> {
  const { stdout } = await runCommand("docker", ["exec", containerId, "bash", "-lc", command], { timeoutMs, redactValues });
  return stdout;
}

export function parseDockerStatus(status: string): EnvironmentStatus {
  switch (status.trim().toLowerCase()) {
    case "running":
      return "running";
    case "created":
    case "restarting":
      return "creating";
    case "exited":
    case "dead":
    case "paused":
      return "stopped";
    default:
      return "error";
  }
}

export async function getDockerStatus(containerId: string): Promise<EnvironmentStatus> {
  const { stdout } = await runCommand("docker", ["inspect", "-f", "{{.State.Status}}", containerId], { timeoutMs: 10_000 });
  return parseDockerStatus(stdout);
}

export async function isContainerRunning(containerId: string): Promise<boolean> {
  try {
    return await getDockerStatus(containerId) === "running";
  } catch {
    return false;
  }
}

export async function getHostPort(containerId: string, containerPort: number, protocol = "tcp"): Promise<number | null> {
  try {
    const { stdout } = await runCommand("docker", ["port", containerId, `${containerPort}/${protocol}`], { timeoutMs: 10_000 });
    const line = stdout.split("\n").find(Boolean);
    if (!line) return null;
    const rawPort = line.split(":").at(-1);
    const port = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

export const CONTAINER_AGENT_TOOLS_HOST = "host.docker.internal";

export const DOCKER_DESKTOP_GATEWAY_HOST = "gateway.docker.internal";

export function shouldAddDockerHostGatewayAlias(
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Docker Desktop publishes host.docker.internal through its own DNS. An
  // explicit host-gateway entry shadows that working address with the Linux VM
  // bridge gateway on macOS/Windows, which cannot reach host-only listeners.
  return platform === "linux";
}

/**
 * How long one `docker ps` snapshot may serve status reads. A multi-project
 * refresh fans out one `get_environments` per project almost simultaneously;
 * without this, each of them would run its own `docker ps`.
 */
export const DOCKER_CONTAINER_STATE_CACHE_MS = 3_000;

export let dockerContainerStateCache: {
  fetchedAt: number;
  ownershipKey: string;
  states: Promise<Map<string, EnvironmentStatus> | null>;
} | null = null;

export function invalidateDockerContainerStateCache(): void {
  dockerContainerStateCache = null;
}

export function setDockerContainerStateCache(
  value: {
    fetchedAt: number;
    ownershipKey: string;
    states: Promise<Map<string, EnvironmentStatus> | null>;
  } | null,
): void {
  dockerContainerStateCache = value;
}
