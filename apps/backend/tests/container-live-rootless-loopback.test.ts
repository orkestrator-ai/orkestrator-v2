/**
 * Real-Docker check of the default rootless topology (to-do 4730 task 2):
 * on a rootless daemon whose RootlessKit refuses host loopback (its default),
 * the backend reports the agent tools path `blocked` with the rootless
 * remediation, and a restricted runtime behind its egress gateway cannot
 * reach a listener on the host.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1, ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * and ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK=disabled, which
 * `mise run docker:disposable -- start` prints for a daemon it started with
 * host loopback refused. Docker does not report the RootlessKit setting, so
 * the caller declares it; the test then also requires `docker info` to report
 * rootless and skips otherwise. On a rootful daemon, or a rootless one with
 * host loopback enabled, these assertions would not hold; the enabled case is
 * `container-live-rootless-host-loopback.test.ts`.
 * Every resource is labelled with this run's private owner namespace and
 * removed by that label afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/core/shell";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { lifecycleEnvironment } from "./container-lifecycle-fixtures";
import { hostServiceContext } from "./container-live-host-service-context";
import { startRuntime } from "./container-live-start";
import { removeLabelledResources } from "./container-live-cleanup";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const DECLARED_DISABLED = process.env.ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK === "disabled";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0 && DECLARED_DISABLED;
const RUN = `l${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 600_000;

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

async function daemonIsRootless(): Promise<boolean> {
  const options = await docker(["info", "--format", "{{json .SecurityOptions}}"]).catch(() => "");
  return options.includes("name=rootless");
}

const ROOTLESS = ENABLED ? await daemonIsRootless() : false;
const live = ROOTLESS ? test : test.skip;

let dataDir = "";
let owner = "";
const servers: Array<{ stop: (force?: boolean) => void }> = [];

beforeAll(async () => {
  if (!ROOTLESS) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-rootless-loopback-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ROOTLESS) return;
  for (const server of servers) server.stop(true);
  const leftovers = await removeLabelledResources(docker, [`label=orkestrator-owner=${owner}`]);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 180_000);

function hostListener(): number {
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("host-ok") });
  servers.push(server);
  return server.port!;
}

describe("rootless daemon with host loopback refused", () => {
  live(
    "host discovery reports blocked with the rootless remediation, and a gateway runtime cannot reach the host",
    async () => {
      const { ContainerHostReachabilityService } =
        await import("../src/core/container-host-reachability");
      const { createDockerContainer } = await import("../src/core/commands-containers");
      const { resolveDockerImage } = await import("../src/core/docker-image");
      const { networkOwnerContainer } = await import("../src/core/container-network-owner");

      const servicePort = hostListener();
      const reachability = new ContainerHostReachabilityService({
        servicePort: () => servicePort,
        ownerNamespace: owner,
        fallbackImage: () => IMAGE,
      });
      const host = await reachability.check("manual");
      expect(host.dockerRootless).toBe(true);
      expect(host.status).toBe("blocked");
      expect(host.hostAddress ?? null).toBeNull();
      expect(host.remediation?.commands.join("\n")).toContain(
        "DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false",
      );

      const environment = lifecycleEnvironment({
        id: `env-${RUN}`,
        networkAccessMode: "restricted",
      });
      const { context } = hostServiceContext([environment], dataDir, servicePort);
      context.containerHostReachability = reachability;
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const containerId = await createDockerContainer(environment, context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
      });
      await context.storage.updateEnvironment(environment.id, { containerId, status: "running" });
      await startRuntime(containerId);
      await waitForContainerBoot(containerId);
      // The runtime sits behind its own egress gateway.
      expect(await networkOwnerContainer(containerId)).not.toBe(containerId);

      const probe = await reachability.checkEnvironmentContainer(containerId, {
        reason: "qualification",
      });
      expect(probe).not.toBeNull();
      expect(["refused", "unreachable", "timeout"]).toContain(probe!.outcome);
    },
    LIVE_TIMEOUT_MS,
  );
});
