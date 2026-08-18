import { createHash, runCommand } from "./commands-dependencies.js";
import type { AgentToolConnection } from "./commands-dependencies.js";
import {
  ACP_LOCAL_SERVER_HEALTH_ATTEMPTS,
  LOCAL_SERVER_HEALTH_ATTEMPTS,
  LOCAL_SERVER_HEALTH_INTERVAL_MS,
} from "./commands-runtime-state.js";
import type { LocalServerKind } from "./commands-runtime-state.js";

/**
 * Liveness probing for locally bound agent servers and bridges.
 *
 * A leaf: `commands-containers` imported nothing from `commands-servers`
 * except these, which made the container module a back-edge into the server
 * module. Depends only on `commands-dependencies` and the runtime-state leaf.
 */

export async function dockerExecDetached(
  containerId: string,
  command: string,
  redactValues?: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  await runCommand("docker", ["exec", "-d", containerId, "bash", "-lc", command], {
    timeoutMs: 30_000,
    redactValues,
  });
}

export async function checkHttpHealth(
  port: number,
  pathName = "/global/health",
  headers?: Record<string, string>,
): Promise<boolean> {
  const http = await import("node:http");
  return new Promise((resolve) => {
    let settled = false;
    const complete = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      resolve(healthy);
    };
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        timeout: 2_000,
        headers,
      },
      (response) => {
        response.resume();
        complete((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
      },
    );
    request.once("timeout", () => {
      request.destroy();
      complete(false);
    });
    request.once("error", () => complete(false));
  });
}

/**
 * Distinguish "nothing is listening" from an authenticated server returning
 * 401/403. Health checks intentionally treat those statuses as unhealthy, but
 * replacement logic still has to stop that process before binding a new one.
 */
export async function isHttpServerReachable(
  port: number,
  pathName = "/global/health",
): Promise<boolean> {
  const http = await import("node:http");
  return new Promise((resolve) => {
    let settled = false;
    const complete = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      resolve(reachable);
    };
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        complete(true);
      },
    );
    request.once("timeout", () => {
      request.destroy();
      complete(false);
    });
    request.once("error", () => complete(false));
  });
}

export function localServerHealthAttempts(kind: LocalServerKind): number {
  return kind === "cursor" || kind === "grok"
    ? ACP_LOCAL_SERVER_HEALTH_ATTEMPTS
    : LOCAL_SERVER_HEALTH_ATTEMPTS;
}

export async function waitForHealth(
  port: number,
  pathName = "/global/health",
  attempts = LOCAL_SERVER_HEALTH_ATTEMPTS,
  headers?: Record<string, string>,
  dependencies: {
    checkHealth?: typeof checkHttpHealth;
    delay?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const checkHealth = dependencies.checkHealth ?? checkHttpHealth;
  const delay =
    dependencies.delay ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await checkHealth(port, pathName, headers)) return;
    await delay(LOCAL_SERVER_HEALTH_INTERVAL_MS);
  }
  throw new Error(`Server on port ${port} did not become healthy`);
}

export async function waitForLocalServerHealth(
  port: number,
  kind: LocalServerKind,
  headers?: Record<string, string>,
  dependencies?: Parameters<typeof waitForHealth>[4],
): Promise<void> {
  await waitForHealth(
    port,
    "/global/health",
    localServerHealthAttempts(kind),
    headers,
    dependencies,
  );
}

export async function waitForHttpServerExit(port: number, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await isHttpServerReachable(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server on port ${port} did not stop`);
}

export async function waitForUnhealthy(port: number, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await checkHttpHealth(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server on port ${port} did not stop`);
}

export function openCodeHealthHeaders(password: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  };
}

export function bearerBridgeHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function claudeBridgeAuthHeaders(token: string): Record<string, string> {
  return { "X-Orkestrator-Claude-Token": token };
}

export function agentToolConnectionFingerprint(connection: AgentToolConnection): string {
  return createHash("sha256")
    .update(connection.url)
    .update("\0")
    .update(connection.token)
    .digest("hex");
}
