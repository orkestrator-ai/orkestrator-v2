/**
 * Real-Docker check of gateway reach on a rootful daemon whose host has no
 * firewall between Docker's bridges and its own addresses (to-do 5510
 * task 3).
 *
 * Host listeners, all on the machine running this test, which must be the
 * daemon's host (its network namespace):
 * - the named service port on 0.0.0.0, the agent tools port that a
 *   restricted runtime's firewall admits: the positive control;
 * - a real Orkestrator gateway in agent-test mode bound to 0.0.0.0, standing
 *   for a gateway bound to a LAN or Tailscale address, and another bound to
 *   127.0.0.1, the default for a profile without remote access;
 * - an unnamed port on 0.0.0.0 and one on 127.0.0.1, which record the peer
 *   address they see.
 *
 * A restricted runtime behind its egress gateway and a full runtime probe
 * them by `host.docker.internal` and by the host's primary address. The
 * egress gateway's `OUTPUT` REJECT counter is read before and after.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1, ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * and ORKESTRATOR_LIVE_HOST_FIREWALL=none, by which the caller declares that
 * no host firewall filters the bridges (with ufw's default, the full column
 * would time out instead). The test skips unless `docker info` reports a
 * rootful Linux daemon. ORKESTRATOR_LIVE_REPORT=<file> writes the observed
 * matrix (statuses, curl exits, counters and peers; no bodies or tokens), and
 * ORKESTRATOR_LIVE_GITHUB_RANGES_SEED=<file> supplies GitHub's ranges in the
 * backend's seed format when the host's unauthenticated GitHub API quota is
 * spent (see `container-live-rootless-host-loopback.test.ts`).
 * Every container, network and volume is labelled with this run's private
 * owner namespace and removed by that label afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/core/shell";
import { GITHUB_RANGES_FILE } from "../src/core/github-ranges-cache";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import type { Environment } from "../src/core/models";
import { lifecycleEnvironment } from "./container-lifecycle-fixtures";
import { hostServiceContext } from "./container-live-host-service-context";
import { startRuntime } from "./container-live-start";
import { removeLabelledResources } from "./container-live-cleanup";
import { startGateway } from "./gateway-test-harness";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const DECLARED_NO_FIREWALL = process.env.ORKESTRATOR_LIVE_HOST_FIREWALL === "none";
const ENABLED =
  process.env.RUN_LIVE_DOCKER_TESTS === "1" &&
  IMAGE.length > 0 &&
  DECLARED_NO_FIREWALL &&
  process.platform === "linux";
const REPORT_PATH = process.env.ORKESTRATOR_LIVE_REPORT?.trim() ?? "";
const GITHUB_SEED = process.env.ORKESTRATOR_LIVE_GITHUB_RANGES_SEED?.trim() ?? "";
const RUN = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 900_000;

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

async function daemonIsRootful(): Promise<boolean> {
  const info = await docker(["info", "--format", "{{.OSType}} {{json .SecurityOptions}}"]).catch(
    () => "",
  );
  return info.startsWith("linux ") && !info.includes("name=rootless");
}

const ROOTFUL = ENABLED ? await daemonIsRootful() : false;
const live = ROOTFUL ? test : test.skip;

let dataDir = "";
let owner = "";
const servers: Array<{ stop: (force?: boolean) => void }> = [];

beforeAll(async () => {
  if (!ROOTFUL) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-rootful-host-reach-"));
  owner = dockerOwnerNamespace(dataDir);
  if (GITHUB_SEED) await fs.copyFile(GITHUB_SEED, path.join(dataDir, GITHUB_RANGES_FILE));
});

afterAll(async () => {
  if (!ROOTFUL) return;
  for (const server of servers) server.stop(true);
  const leftovers = await removeLabelledResources(docker, [`label=orkestrator-owner=${owner}`]);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 180_000);

function listener(hostname: string, answer: string): { port: number; peers: Set<string> } {
  const peers = new Set<string>();
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch: (request, self) => {
      const peer = self.requestIP(request)?.address;
      if (peer) peers.add(peer);
      return new Response(answer);
    },
  });
  servers.push(server);
  return { port: server.port!, peers };
}

interface Probe {
  /** curl's exit status: 0 answered, 7 refused or rejected, 28 timed out. */
  exit: number;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
}

/** One request from inside a container as `node`, bounded at 8 s. */
async function probe(
  containerId: string,
  url: string,
  options: { method?: string; host?: string } = {},
): Promise<Probe> {
  const script =
    'curl -sS -o /dev/null --max-time 8 -X "$2" ${3:+-H} ${3:+"Host: $3"} -w "%{http_code}" "$1" 2>/dev/null; ' +
    'printf " %s\\n" "$?"';
  const output = await docker([
    "exec",
    "-u",
    "node",
    containerId,
    "sh",
    "-c",
    script,
    "probe",
    url,
    options.method ?? "GET",
    options.host ?? "",
  ]);
  const [status, exit] = output.trim().split(/\s+/);
  return { exit: Number(exit), status: Number(status) || 0 };
}

async function rejectCount(firewallContainer: string): Promise<number> {
  const listing = await docker([
    "exec",
    "-u",
    "root",
    firewallContainer,
    "iptables",
    "-L",
    "OUTPUT",
    "-v",
    "-n",
    "-x",
  ]);
  return listing
    .split("\n")
    .filter((line) => /\sREJECT\s/.test(line))
    .reduce((total, line) => total + Number(line.trim().split(/\s+/)[0] ?? 0), 0);
}

/** The host's source address for its default route. */
async function primaryAddress(): Promise<string> {
  const { stdout } = await runCommand("ip", ["-4", "-j", "route", "get", "192.0.2.1"], {
    timeoutMs: 10_000,
  });
  const route = (JSON.parse(stdout) as Array<{ prefsrc?: string }>)[0];
  if (!route?.prefsrc) throw new Error("no primary IPv4 address");
  return route.prefsrc;
}

function summarize(results: Record<string, Probe>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(results).map(([name, result]) => [
      name,
      `exit ${result.exit} http ${result.status}`,
    ]),
  );
}

describe("rootful daemon with no host firewall", () => {
  live(
    "a full runtime reaches gateways bound to host addresses but not loopback; a restricted runtime reaches only the named service port",
    async () => {
      const { ContainerHostReachabilityService } =
        await import("../src/core/container-host-reachability");
      const { createDockerContainer } = await import("../src/core/commands-containers");
      const { resolveDockerImage } = await import("../src/core/docker-image");
      const { networkOwnerContainer } = await import("../src/core/container-network-owner");

      const service = listener("0.0.0.0", "service-ok");
      const other = listener("0.0.0.0", "other-ok");
      const loopbackOther = listener("127.0.0.1", "loopback-ok");
      const wide = await startGateway({ agentTestMode: true, bindAddress: "0.0.0.0" });
      const loopback = await startGateway({ agentTestMode: true });
      const widePort = Number(new URL(wide.info.url).port);
      const loopbackPort = Number(new URL(loopback.info.url).port);
      const statusPath = "/__orkestrator/status";
      const loginPath = "/__orkestrator/agent-test/login?code=not-a-code";
      const primary = await primaryAddress();

      const reachability = new ContainerHostReachabilityService({
        servicePort: () => service.port,
        ownerNamespace: owner,
        fallbackImage: () => IMAGE,
      });
      const host = await reachability.check("manual");
      expect(host.dockerRootless).toBe(false);
      expect(host.status).toBe("reachable");

      const environments: Environment[] = [
        lifecycleEnvironment({ id: `env-${RUN}-gw`, networkAccessMode: "restricted" }),
        lifecycleEnvironment({ id: `env-${RUN}-full`, networkAccessMode: "full" }),
      ];
      const { context } = hostServiceContext(environments, dataDir, service.port);
      context.containerHostReachability = reachability;
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const runtimes: string[] = [];
      for (const environment of environments) {
        const containerId = await createDockerContainer(environment, context, {
          imageId: resolved.imageId,
          runtimeGeneration: 1,
        });
        await context.storage.updateEnvironment(environment.id, { containerId, status: "running" });
        await startRuntime(containerId);
        await waitForContainerBoot(containerId);
        runtimes.push(containerId);
      }
      const [gatewayRuntime, fullRuntime] = runtimes as [string, string];
      const egressGateway = await networkOwnerContainer(gatewayRuntime);
      expect(egressGateway).not.toBe(gatewayRuntime);
      const report = JSON.parse(
        await docker([
          "exec",
          "-u",
          "root",
          egressGateway,
          "cat",
          "/run/orkestrator-firewall/firewall.json",
        ]),
      );
      expect(report).toMatchObject({ mode: "restricted", state: "applied" });

      const probeAll = async (containerId: string) => {
        const results: Record<string, Probe> = {};
        for (const address of ["host.docker.internal", primary]) {
          const base = (port: number) => `http://${address}:${port}`;
          results[`service@${address}`] = await probe(containerId, `${base(service.port)}/`);
          results[`other@${address}`] = await probe(containerId, `${base(other.port)}/`);
          results[`loopbackOther@${address}`] = await probe(
            containerId,
            `${base(loopbackOther.port)}/`,
          );
          results[`wideGatewayStatus@${address}`] = await probe(
            containerId,
            `${base(widePort)}${statusPath}`,
          );
          results[`loopbackGatewayStatus@${address}`] = await probe(
            containerId,
            `${base(loopbackPort)}${statusPath}`,
          );
        }
        // A loopback Host header passes the Host check; the login route is
        // served only to a loopback peer (404 otherwise).
        results[`wideGatewayLogin@${primary}+loopback-host`] = await probe(
          containerId,
          `http://${primary}:${widePort}${loginPath}`,
          { host: `127.0.0.1:${widePort}` },
        );
        return results;
      };

      const matrix: Record<string, unknown> = {
        primary,
        hostCheck: { status: host.status, firewall: host.firewall.kind },
      };
      const before = await rejectCount(egressGateway);
      const restricted = await probeAll(gatewayRuntime);
      const after = await rejectCount(egressGateway);
      matrix.restricted = {
        results: summarize(restricted),
        rejectBefore: before,
        rejectAfter: after,
      };
      // Positive control: the named service port, through the alias the
      // firewall admits it on.
      expect(restricted["service@host.docker.internal"]).toEqual({ exit: 0, status: 200 });
      const refused = Object.entries(restricted).filter(
        ([name]) => name !== "service@host.docker.internal",
      );
      for (const [, result] of refused) expect(result).toEqual({ exit: 7, status: 0 });
      expect(after - before).toBeGreaterThanOrEqual(refused.length);

      const full = await probeAll(fullRuntime);
      matrix.full = { results: summarize(full) };
      matrix.peers = { other: [...other.peers], loopbackOther: [...loopbackOther.peers] };
      for (const address of ["host.docker.internal", primary]) {
        expect(full[`service@${address}`]).toEqual({ exit: 0, status: 200 });
        expect(full[`other@${address}`]).toEqual({ exit: 0, status: 200 });
        // Nothing listens on those addresses at a loopback-bound port.
        expect(full[`loopbackOther@${address}`]).toEqual({ exit: 7, status: 0 });
        expect(full[`loopbackGatewayStatus@${address}`]).toEqual({ exit: 7, status: 0 });
      }
      // The gateway bound to every address answers: by its alias the Host
      // check refuses it, by the IP literal it asks for a login.
      expect(full["wideGatewayStatus@host.docker.internal"]).toEqual({ exit: 0, status: 421 });
      expect(full[`wideGatewayStatus@${primary}`]).toEqual({ exit: 0, status: 401 });
      // The container is no loopback peer here, so even with a loopback Host
      // header the loopback-gated login route is not served.
      expect(full[`wideGatewayLogin@${primary}+loopback-host`]).toEqual({ exit: 0, status: 404 });
      expect(loopbackOther.peers.size).toBe(0);
      expect(other.peers.size).toBeGreaterThan(0);
      for (const peer of other.peers) expect(peer.startsWith("127.")).toBe(false);

      if (REPORT_PATH) await Bun.write(REPORT_PATH, `${JSON.stringify(matrix, null, 2)}\n`);
    },
    LIVE_TIMEOUT_MS,
  );
});
