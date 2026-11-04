import { prepareEgressGatewayForStart, stopRuntimeContainer } from "../src/core/egress-gateway";
import { startDockerContainer } from "../src/core/container-start";

/**
 * Starts a runtime the way the backend's start path does: a restricted
 * runtime's egress gateway first, and the runtime once the gateway's firewall
 * applied. Docker refuses a runtime whose gateway is not running, so a live
 * test never starts one with a bare `docker start`. Workloads also use the
 * production automatic-port collision recovery, as gateways already do.
 */
export async function startRuntime(containerId: string): Promise<void> {
  await prepareEgressGatewayForStart(containerId);
  await startDockerContainer(containerId);
}

/** Stops a runtime and then its gateway, and starts both again in order. */
export async function restartRuntime(containerId: string): Promise<void> {
  await stopRuntimeContainer(containerId);
  await startRuntime(containerId);
}
