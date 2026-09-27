/**
 * Real-Docker qualification for environment networks (plan step 09).
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * Restricted mode needs outbound access to api.github.com (the firewall
 * resolves GitHub's published ranges). Every resource is labelled with this
 * run's private owner namespace and removed by that label afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../../../apps/backend/src/core/shell";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import { waitForContainerBoot } from "../../../apps/backend/src/core/container-readiness";
import type { Environment } from "../../../apps/backend/src/core/models";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 600_000;

let dataDir = "";
let owner = "";
const servers: Array<{ stop: (force?: boolean) => void }> = [];

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

async function dockerStatus(args: string[], timeoutMs = 60_000): Promise<number> {
  try {
    await runCommand("docker", args, { timeoutMs });
    return 0;
  } catch {
    return 1;
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-network-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ENABLED) return;
  for (const server of servers) server.stop(true);
  const ids = (await docker(["ps", "-aq", "--filter", `label=orkestrator-owner=${owner}`]))
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) await docker(["rm", "-f", ...ids]).catch(() => undefined);
  const networks = (
    await docker(["network", "ls", "-q", "--filter", `label=orkestrator-owner=${owner}`])
  )
    .split("\n")
    .filter(Boolean);
  if (networks.length > 0) await docker(["network", "rm", ...networks]).catch(() => undefined);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

function hostListener(): number {
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("host-ok") });
  servers.push(server);
  return server.port!;
}

function networkContext(environments: Environment[], servicePort: number) {
  const fixture = memoryLifecycleContext(environments, dataDir);
  Object.assign(fixture.context, {
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
    agentTools: {
      connection: () => {
        throw new Error("not used");
      },
      revokeEnvironment: () => undefined,
      servicePort: () => servicePort,
    },
  });
  Object.assign(fixture.context.storage, {
    getProject: async () => ({
      id: "project-1",
      name: "Project",
      gitUrl: "https://example.invalid/none.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { allowedDomains: ["registry.npmjs.org"], enabledAgentPlatforms: [] },
      repositories: {},
    }),
  });
  return fixture;
}

/**
 * curl's exit status from inside the container: 0 reached, 7 refused or
 * rejected (the container firewall answers REJECT at once), 28 timed out
 * (the packet left the container; a host firewall may still drop it).
 */
async function probe(containerId: string, url: string): Promise<number> {
  const out = await docker([
    "exec",
    "-u",
    "node",
    containerId,
    "sh",
    "-c",
    `curl -fsS -o /dev/null --max-time 4 ${url} 2>/dev/null; echo $?`,
  ]);
  return Number(out.split("\n").at(-1));
}

/** Left the container: reached, or dropped further on by the host. */
const LEFT_CONTAINER = [0, 28];

describe("C22 environment networks and narrow host access", () => {
  live(
    "a restricted runtime reaches only the backend service port and not its siblings",
    async () => {
      const { createDockerContainer } =
        await import("../../../apps/backend/src/core/commands-containers");
      const { resolveDockerImage } = await import("../../../apps/backend/src/core/docker-image");
      const { ensureContainerHostServicePorts } =
        await import("../../../apps/backend/src/core/commands-environment");
      const { environmentNetworkPolicy, removeEnvironmentNetwork, environmentNetworkName } =
        await import("../../../apps/backend/src/core/container-network");
      const servicePort = hostListener();
      const otherPort = hostListener();
      const restricted = lifecycleEnvironment({
        id: `env-${RUN}-a`,
        networkAccessMode: "restricted",
      });
      const sibling = lifecycleEnvironment({ id: `env-${RUN}-b`, networkAccessMode: "full" });
      const { context } = networkContext([restricted, sibling], servicePort);
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");

      const siblingId = await createDockerContainer(sibling, context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
      });
      await docker(["start", siblingId]);
      await waitForContainerBoot(siblingId);
      await docker([
        "exec",
        "-d",
        "-u",
        "node",
        siblingId,
        "bun",
        "-e",
        'Bun.serve({ hostname: "0.0.0.0", port: 8080, fetch: () => new Response("sibling") })',
      ]);
      const siblingIp = await docker([
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        siblingId,
      ]);

      const containerId = await createDockerContainer(restricted, context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
      });
      await context.storage.updateEnvironment(restricted.id, { containerId, status: "running" });
      await docker(["start", containerId]);
      await waitForContainerBoot(containerId);

      // Each environment has its own labelled network; neither is the default bridge.
      const networks = await docker([
        "inspect",
        "-f",
        "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}",
        containerId,
      ]);
      expect(networks).toBe(environmentNetworkName(owner, restricted.id));

      const policy = await environmentNetworkPolicy(restricted.id, context);
      expect(policy.policyVersion).toBe(2);
      expect(policy.effective).toMatchObject({
        mode: "restricted",
        state: "applied",
        hostServicePorts: String(servicePort),
      });
      expect(["blocked", "disabled"]).toContain(policy.effective!.ipv6!);
      expect(
        await docker(["exec", containerId, "cat", "/proc/sys/net/ipv6/conf/all/disable_ipv6"]),
      ).toBe("1");

      // Host: exactly the service port leaves the container; any other host
      // port is rejected by the container firewall itself.
      expect(LEFT_CONTAINER).toContain(
        await probe(containerId, `http://host.docker.internal:${servicePort}/`),
      );
      expect(await probe(containerId, `http://host.docker.internal:${otherPort}/`)).toBe(7);
      // Sibling: rejected, not merely unanswered.
      expect(await probe(containerId, `http://${siblingIp}:8080/`)).toBe(7);
      // The internet beyond the allowlist.
      expect(await probe(containerId, "https://example.com/")).not.toBe(0);
      // A full-access sibling proves the listener itself answers.
      expect(await probe(siblingId, "http://127.0.0.1:8080/")).toBe(0);

      // Ingress through a published port still works.
      await docker([
        "exec",
        "-d",
        "-u",
        "node",
        containerId,
        "bun",
        "-e",
        'Bun.serve({ hostname: "0.0.0.0", port: 4096, fetch: () => new Response("ingress-ok") })',
      ]);
      const published = await docker(["port", containerId, "4096/tcp"]);
      const hostPort = published.split("\n")[0]!.split(":").at(-1)!;
      let ingress = "";
      for (let attempt = 0; attempt < 20 && ingress !== "ingress-ok"; attempt += 1) {
        // Host curl: the test runner's global fetch is a DOM implementation.
        ingress = await runCommand(
          "curl",
          ["-sS", "--max-time", "3", `http://127.0.0.1:${hostPort}/`],
          {
            timeoutMs: 10_000,
          },
        ).then(
          (result) => result.stdout.trim(),
          () => "",
        );
        if (ingress !== "ingress-ok") await Bun.sleep(250);
      }
      expect(ingress).toBe("ingress-ok");

      // A backend restart on another port: the durable policy follows it.
      await ensureContainerHostServicePorts(containerId, otherPort);
      expect(LEFT_CONTAINER).toContain(
        await probe(containerId, `http://host.docker.internal:${otherPort}/`),
      );
      expect(await probe(containerId, `http://host.docker.internal:${servicePort}/`)).toBe(7);
      expect(
        await docker(["exec", containerId, "cat", "/etc/orkestrator/host-service-ports"]),
      ).toBe(String(otherPort));
      // ...and survives a restart of the container.
      await docker(["restart", "-t", "5", containerId]);
      await waitForContainerBoot(containerId);
      expect(LEFT_CONTAINER).toContain(
        await probe(containerId, `http://host.docker.internal:${otherPort}/`),
      );
      expect(await probe(containerId, `http://host.docker.internal:${servicePort}/`)).toBe(7);

      // The network is removed only once nothing is attached.
      expect(await removeEnvironmentNetwork(context, restricted.id)).toBe("in-use");
      await docker(["rm", "-f", containerId]);
      expect(await removeEnvironmentNetwork(context, restricted.id)).toBe("removed");
      expect(await removeEnvironmentNetwork(context, restricted.id)).toBe("absent");
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C24 resource budgets are enforced and reported as applied", () => {
  live(
    "limits are applied, pressure stays inside the container, and a live update is read back",
    async () => {
      const { createDockerContainer } =
        await import("../../../apps/backend/src/core/commands-containers");
      const { resolveDockerImage } = await import("../../../apps/backend/src/core/docker-image");
      const {
        environmentResourcePolicy,
        sampleContainerUsage,
        updateEnvironmentResources,
        resetResourceCaches,
      } = await import("../../../apps/backend/src/core/container-resources");
      resetResourceCaches();
      const limited = lifecycleEnvironment({
        id: `env-${RUN}-limited`,
        networkAccessMode: "full",
        containerResourceLimits: { cpus: 1, memoryMiB: 512, pids: 256 },
      });
      const { context } = networkContext([limited], 1);
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const containerId = await createDockerContainer(limited, context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
      });
      await context.storage.updateEnvironment(limited.id, { containerId, status: "running" });
      await docker(["start", containerId]);
      await waitForContainerBoot(containerId);

      const policy = await environmentResourcePolicy(limited.id, context);
      expect(policy.source).toBe("environment");
      expect(policy.applied).toEqual({ cpus: 1, memoryMiB: 512, pids: 256 });

      // PID pressure: creation beyond the limit fails inside the container;
      // the container itself stays usable once the processes are gone.
      const pidResult = await docker([
        "exec",
        "-u",
        "node",
        containerId,
        "bash",
        "-c",
        "for i in $(seq 1 400); do sleep 4 2>/dev/null & done 2>/dev/null; echo started=$(jobs -p | wc -l); wait; true",
      ]).catch((error: unknown) => String(error));
      const started = Number(/started=(\d+)/.exec(pidResult)?.[1] ?? "0");
      expect(started).toBeLessThan(400);
      // Once those processes exit, the container is usable again.
      let alive = "";
      for (let attempt = 0; attempt < 30 && alive !== "alive"; attempt += 1) {
        alive = await docker(["exec", containerId, "echo", "alive"]).catch(() => "");
        if (alive !== "alive") await Bun.sleep(1_000);
      }
      expect(alive).toBe("alive");

      // Memory pressure: the allocating process is killed; PID 1 survives.
      const oom = await dockerStatus(
        [
          "exec",
          "-u",
          "node",
          containerId,
          "bun",
          "-e",
          "const a = []; for (;;) a.push(Buffer.alloc(32 * 1024 * 1024, 1));",
        ],
        120_000,
      );
      expect(oom).not.toBe(0);
      expect(await docker(["inspect", "-f", "{{.State.Status}}", containerId])).toBe("running");

      const usage = await sampleContainerUsage(context);
      const sample = usage.containers.find((entry) => entry.containerId === containerId);
      expect(sample?.memoryLimitBytes).toBe(512 * 1024 * 1024);
      expect(sample?.cpuCores).not.toBeNull();

      // A live update goes through the lifecycle and is read back.
      const updated = await updateEnvironmentResources(
        {
          environmentId: limited.id,
          limits: { cpus: 2, memoryMiB: 1024, pids: 512 },
          applyNow: true,
        },
        context,
      );
      expect(updated.applied).toEqual({ cpus: 2, memoryMiB: 1024, pids: 512 });
      await docker(["rm", "-f", containerId]);
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C26 bounded logs", () => {
  live(
    "new runtimes use the bounded local driver, bridge output rotates and followers stop",
    async () => {
      const { createDockerContainer } =
        await import("../../../apps/backend/src/core/commands-containers");
      const { resolveDockerImage } = await import("../../../apps/backend/src/core/docker-image");
      const { ContainerLogService } =
        await import("../../../apps/backend/src/core/container-log-service");
      const { boundedBackgroundLaunch } =
        await import("../../../apps/backend/src/core/container-log-bounds");
      const { resetResourceCaches } =
        await import("../../../apps/backend/src/core/container-resources");
      resetResourceCaches();
      const environment = lifecycleEnvironment({
        id: `env-${RUN}-logs`,
        networkAccessMode: "full",
      });
      const { context } = networkContext([environment], 1);
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const containerId = await createDockerContainer(environment, context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
      });
      expect(
        await docker([
          "inspect",
          "-f",
          "{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}",
          containerId,
        ]),
      ).toBe('local {"max-file":"3","max-size":"10m"}');
      await docker(["start", containerId]);
      await waitForContainerBoot(containerId);

      // A chatty process through the same launch the bridges use: ~40 MB of
      // output stays within 3 × 5 MiB, and the producer is never blocked.
      const launch = boundedBackgroundLaunch(
        "sh -c 'yes orkestrator-bounded-log-line-with-some-padding | head -c 40000000'",
        "/tmp/chatty.log",
      );
      await docker(["exec", "-u", "node", containerId, "bash", "-c", launch]);
      let files = "";
      for (let attempt = 0; attempt < 60; attempt += 1) {
        files = await docker([
          "exec",
          containerId,
          "sh",
          "-c",
          "pgrep -f [o]rkestrator-log-writer >/dev/null && echo running || ls /tmp/chatty.log*",
        ]);
        if (files !== "running") break;
        await Bun.sleep(1_000);
      }
      expect(files.split("\n").sort()).toEqual([
        "/tmp/chatty.log",
        "/tmp/chatty.log.1",
        "/tmp/chatty.log.2",
      ]);
      const total = Number(
        await docker(["exec", containerId, "sh", "-c", "cat /tmp/chatty.log* | wc -c"]),
      );
      expect(total).toBeLessThanOrEqual(3 * 5 * 1024 * 1024);

      // Real followers: open, read, close; the `docker logs -f` child is gone
      // after the idle grace.
      const events: unknown[] = [];
      const service = new ContainerLogService((_event, payload) => events.push(payload));
      const first = service.open(containerId);
      const second = service.open(containerId);
      expect(service.followerCount()).toBe(1);
      await Bun.sleep(1_000);
      const read = service.read(first.subscriptionId, first.sourceId, first.cursor);
      expect(read.kind).toBe("records");
      service.close(first.subscriptionId);
      service.close(second.subscriptionId);
      await Bun.sleep(6_000);
      expect(service.followerCount()).toBe(0);
      service.shutdown();
      await docker(["rm", "-f", containerId]);
    },
    LIVE_TIMEOUT_MS,
  );
});
