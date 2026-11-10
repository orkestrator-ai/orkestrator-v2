/**
 * Real-Docker check of a rootless daemon whose RootlessKit lets containers
 * reach the host's loopback (to-do 5510 tasks 2 and 3).
 *
 * Three loopback-bound host listeners are the targets:
 * - the named service port, the agent tools port that a restricted runtime's
 *   firewall admits. It is the positive control: a restricted runtime must
 *   reach it before any refusal below means anything;
 * - a real Orkestrator gateway in agent-test mode, bound to 127.0.0.1, which
 *   answers an unauthenticated request with 401 and gates its login bootstrap
 *   on a loopback peer;
 * - another loopback port that nothing names.
 *
 * A restricted runtime behind its egress gateway, a full runtime, and a
 * restricted runtime from a variant of the same image that lacks the
 * `egress-gateway` capability (an older image's firewall inside the workload,
 * with `NET_ADMIN`) each probe all three. Each listener records the peer
 * address it saw, and the firewalls' `OUTPUT` REJECT counters are read before
 * and after. The variant also shows what runtime root can do: it can rewrite
 * an in-container firewall, while a gateway runtime's root cannot.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1, ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * and ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK=enabled, which
 * `mise run docker:disposable -- start --host-loopback` prints. Docker does
 * not report the RootlessKit setting, so the caller declares it; the test
 * also requires `docker info` to report rootless and skips otherwise. The
 * refused case is `container-live-rootless-loopback.test.ts`.
 * Every container, network and volume is labelled with this run's private
 * owner namespace and removed by that label; the variant image tag is removed
 * by name. ORKESTRATOR_LIVE_REPORT=<file> writes the observed matrix there
 * (peer addresses, HTTP statuses, curl exits and counters; no bodies or
 * tokens).
 *
 * Restricted firewalls fail closed without GitHub's ranges. The backend
 * fetches them once into its data directory and seeds each gateway; on a host
 * whose address has spent GitHub's 60 unauthenticated requests an hour, that
 * fetch and the gateway's own both get 403. ORKESTRATOR_LIVE_GITHUB_RANGES_SEED
 * names a file in the backend's seed format (`# github-ranges <time>` and
 * then one IPv4 CIDR per line) to use instead.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IMAGE_MANIFEST_PATH } from "@orkestrator/protocol/image-manifest";
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
const DECLARED_ENABLED = process.env.ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK === "enabled";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0 && DECLARED_ENABLED;
const REPORT_PATH = process.env.ORKESTRATOR_LIVE_REPORT?.trim() ?? "";
const GITHUB_SEED = process.env.ORKESTRATOR_LIVE_GITHUB_RANGES_SEED?.trim() ?? "";
const RUN = `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 900_000;
const HOST_LOOPBACK = "10.0.2.2";
const CAPABILITIES_LABEL = "org.orkestrator.image.capabilities";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

async function dockerSucceeds(args: string[]): Promise<boolean> {
  try {
    await runCommand("docker", args, { timeoutMs: 60_000 });
    return true;
  } catch {
    return false;
  }
}

async function daemonIsRootless(): Promise<boolean> {
  const options = await docker(["info", "--format", "{{json .SecurityOptions}}"]).catch(() => "");
  return options.includes("name=rootless");
}

const ROOTLESS = ENABLED ? await daemonIsRootless() : false;
const live = ROOTLESS ? test : test.skip;

let dataDir = "";
let owner = "";
let variantImage = "";
const servers: Array<{ stop: (force?: boolean) => void }> = [];

beforeAll(async () => {
  if (!ROOTLESS) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-rootless-host-loopback-"));
  owner = dockerOwnerNamespace(dataDir);
  // A fresh copy counts as the backend's own seed for the next hour.
  if (GITHUB_SEED) await fs.copyFile(GITHUB_SEED, path.join(dataDir, GITHUB_RANGES_FILE));
});

afterAll(async () => {
  if (!ROOTLESS) return;
  for (const server of servers) server.stop(true);
  const leftovers = await removeLabelledResources(docker, [`label=orkestrator-owner=${owner}`]);
  if (variantImage) {
    await docker(["image", "rm", variantImage]).catch(() => undefined);
    if (await dockerSucceeds(["image", "inspect", variantImage])) {
      leftovers.push(`image ${variantImage}`);
    }
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 180_000);

/** A loopback-only listener that records each peer address it sees. */
function loopbackListener(answer: string): { port: number; peers: Set<string> } {
  const peers = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
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
  body: string;
}

/**
 * One request from inside a container as `node`, bounded at 8 s. `host`
 * replaces the `Host` header, as any client that writes its own headers can.
 */
async function probe(
  containerId: string,
  url: string,
  options: { method?: string; host?: string } = {},
): Promise<Probe> {
  const script =
    'out=$(curl -sS --max-time 8 -X "$2" ${3:+-H} ${3:+"Host: $3"} -w "\\n%{http_code}" "$1" 2>/dev/null); ' +
    'rc=$?; printf "%s\\n%s\\n" "$out" "$rc"';
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
  const lines = output.split("\n");
  const exit = Number(lines.at(-1));
  const status = Number(lines.at(-2)) || 0;
  return { exit, status, body: lines.slice(0, -2).join("\n") };
}

/** Packets the final `OUTPUT` REJECT rule has counted in a firewall's namespace. */
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

async function capEff(containerId: string, user: string): Promise<string> {
  return docker([
    "exec",
    "-u",
    user,
    containerId,
    "awk",
    "/^CapEff/ { print $2 }",
    "/proc/self/status",
  ]);
}

/**
 * The qualification image as one that does not declare `egress-gateway` (nor
 * `egress-filter`, which needs it): both are dropped from its manifest, which
 * is what the backend reads, and from its label. The backend then keeps the
 * firewall in the workload with `NET_ADMIN`, as for an image built before the
 * gateway existed. Everything else, the firewall scripts and the entrypoint
 * included, is the qualification image's.
 */
async function inContainerFirewallImage(): Promise<string> {
  const capabilities = await docker([
    "image",
    "inspect",
    "--format",
    `{{ index .Config.Labels "${CAPABILITIES_LABEL}" }}`,
    IMAGE,
  ]);
  const reduced = capabilities
    .split(",")
    .filter((entry) => !/^egress-(gateway|filter)=/.test(entry))
    .join(",");
  expect(reduced).not.toBe(capabilities);
  expect(reduced).toContain("network-policy=3");
  const dockerfile = [
    `FROM ${IMAGE}`,
    "USER root",
    `RUN jq 'del(.capabilities["egress-gateway"], .capabilities["egress-filter"])' ${IMAGE_MANIFEST_PATH} > /tmp/manifest.json \\`,
    ` && install -m 0644 /tmp/manifest.json ${IMAGE_MANIFEST_PATH} && rm /tmp/manifest.json`,
    `LABEL ${CAPABILITIES_LABEL}="${reduced}"`,
    "USER node",
    "",
  ].join("\n");
  variantImage = `orkestrator-v2:qualification-in-container-${RUN}`;
  const build = Bun.spawn(["docker", "build", "-q", "-t", variantImage, "-"], {
    stdin: new TextEncoder().encode(dockerfile),
    timeout: 600_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code !== 0) throw new Error(`variant image build failed: ${stderr.slice(-2000)}`);
  return variantImage;
}

describe("rootless daemon with host loopback enabled", () => {
  live(
    "only the named service port is reachable from restricted runtimes; full runtimes reach every loopback listener as 127.0.0.1",
    async () => {
      const { ContainerHostReachabilityService } =
        await import("../src/core/container-host-reachability");
      const { createDockerContainer } = await import("../src/core/commands-containers");
      const { resolveDockerImage } = await import("../src/core/docker-image");
      const { networkOwnerContainer } = await import("../src/core/container-network-owner");

      const service = loopbackListener("service-ok");
      const other = loopbackListener("other-ok");
      const { info } = await startGateway({ agentTestMode: true });
      const gatewayPort = Number(new URL(info.url).port);
      const gatewayStatusPath = "/__orkestrator/status";
      const loginPath = "/__orkestrator/agent-test/login?code=not-a-code";
      const mintPath = "/__orkestrator/agent-test/bootstrap";

      // From the host itself: the gateway is real, unauthenticated requests
      // get 401, and its loopback-gated login route is served (401, not 404).
      const fromHost = async (url: string, method = "GET") =>
        (await fetch(url, { method, redirect: "manual" })).status;
      expect(await fromHost(`http://127.0.0.1:${gatewayPort}${gatewayStatusPath}`)).toBe(401);
      expect(await fromHost(`http://127.0.0.1:${gatewayPort}${loginPath}`)).toBe(401);
      expect(await fromHost(`http://127.0.0.1:${gatewayPort}${mintPath}`, "POST")).toBe(401);

      const reachability = new ContainerHostReachabilityService({
        servicePort: () => service.port,
        ownerNamespace: owner,
        fallbackImage: () => IMAGE,
      });
      const host = await reachability.check("manual");
      expect(host.dockerRootless).toBe(true);
      expect(host.status).toBe("reachable");
      expect(host.hostAddress).toBe(HOST_LOOPBACK);
      expect(host.remediation ?? null).toBeNull();

      const variant = await inContainerFirewallImage();
      const environments: Environment[] = [
        lifecycleEnvironment({ id: `env-${RUN}-gw`, networkAccessMode: "restricted" }),
        lifecycleEnvironment({ id: `env-${RUN}-full`, networkAccessMode: "full" }),
        lifecycleEnvironment({ id: `env-${RUN}-incont`, networkAccessMode: "restricted" }),
      ];
      const { context } = hostServiceContext(environments, dataDir, service.port);
      context.containerHostReachability = reachability;
      const create = async (environment: Environment, image: string) => {
        const resolved = await resolveDockerImage(image);
        if (resolved.kind !== "present") throw new Error(`image missing: ${image}`);
        const containerId = await createDockerContainer(environment, context, {
          imageId: resolved.imageId,
          runtimeGeneration: 1,
        });
        await context.storage.updateEnvironment(environment.id, { containerId, status: "running" });
        try {
          await startRuntime(containerId);
          await waitForContainerBoot(containerId);
        } catch (error) {
          // The fixture containers' own boot output (no credentials), bounded:
          // the runtime's and, when it has one, its egress gateway's.
          const name = await docker(["inspect", "--format", "{{.Name}}", containerId]).catch(
            () => "",
          );
          const tails: string[] = [];
          for (const target of [containerId, `${name.replace(/^\//, "")}-egress`]) {
            const { stdout } = await runCommand(
              "sh",
              ["-c", 'docker logs --tail 40 "$1" 2>&1', "logs", target],
              { timeoutMs: 30_000 },
            ).catch(() => ({ stdout: "" }));
            tails.push(`--- ${target}\n${stdout}`);
          }
          // The firewall's own report says which step failed.
          const report = await docker([
            "exec",
            "-u",
            "root",
            `${name.replace(/^\//, "")}-egress`,
            "cat",
            "/run/orkestrator-firewall/firewall.json",
          ]).catch(() => "");
          tails.push(`--- firewall report\n${report.slice(0, 4000)}`);
          throw new Error(`${environment.id} did not boot: ${String(error)}\n${tails.join("\n")}`);
        }
        return containerId;
      };
      const gatewayRuntime = await create(environments[0]!, IMAGE);
      const fullRuntime = await create(environments[1]!, IMAGE);
      const inContainerRuntime = await create(environments[2]!, variant);

      // Where each runtime's firewall lives.
      const egressGateway = await networkOwnerContainer(gatewayRuntime);
      expect(egressGateway).not.toBe(gatewayRuntime);
      expect(await networkOwnerContainer(inContainerRuntime)).toBe(inContainerRuntime);
      expect(await capEff(gatewayRuntime, "node")).toBe("0000000000000000");
      // CAP_NET_ADMIN is capability 12.
      const netAdmin = (caps: string) => (BigInt(`0x${caps}`) & (1n << 12n)) !== 0n;
      expect(netAdmin(await capEff(gatewayRuntime, "orkroot"))).toBe(false);
      expect(netAdmin(await capEff(inContainerRuntime, "orkroot"))).toBe(true);
      const inContainerCaps = await docker([
        "inspect",
        "--format",
        "{{json .HostConfig.CapAdd}}",
        inContainerRuntime,
      ]);
      expect(inContainerCaps).toContain("NET_ADMIN");
      for (const firewall of [egressGateway, inContainerRuntime]) {
        const report = JSON.parse(
          await docker([
            "exec",
            "-u",
            "root",
            firewall,
            "cat",
            "/run/orkestrator-firewall/firewall.json",
          ]),
        );
        expect(report).toMatchObject({ mode: "restricted", state: "applied" });
      }

      const targets = (address: string) => ({
        service: `http://${address}:${service.port}/`,
        other: `http://${address}:${other.port}/`,
        gatewayStatus: `http://${address}:${gatewayPort}${gatewayStatusPath}`,
        gatewayLogin: `http://${address}:${gatewayPort}${loginPath}`,
      });
      // The gateway's Host check refuses a multi-label name it does not know
      // (421) and accepts an IP literal. It guards browsers against DNS
      // rebinding only; a container writes its own Host header.
      const loopbackHost = `127.0.0.1:${gatewayPort}`;
      const probeAll = async (containerId: string) => {
        const results: Record<string, Probe> = {};
        for (const address of ["host.docker.internal", HOST_LOOPBACK]) {
          for (const [name, url] of Object.entries(targets(address))) {
            results[`${name}@${address}`] = await probe(containerId, url);
          }
        }
        const named = targets("host.docker.internal");
        results["gatewayStatus@host.docker.internal+loopback-host"] = await probe(
          containerId,
          named.gatewayStatus,
          { host: loopbackHost },
        );
        results["gatewayLogin@host.docker.internal+loopback-host"] = await probe(
          containerId,
          named.gatewayLogin,
          { host: loopbackHost },
        );
        results[`gatewayMint@${HOST_LOOPBACK}`] = await probe(
          containerId,
          `http://${HOST_LOOPBACK}:${gatewayPort}${mintPath}`,
          { method: "POST" },
        );
        return results;
      };

      const matrix: Record<string, unknown> = { hostAddress: host.hostAddress };
      for (const [label, runtime, firewall] of [
        ["restricted-gateway", gatewayRuntime, egressGateway],
        ["restricted-in-container", inContainerRuntime, inContainerRuntime],
      ] as const) {
        const before = await rejectCount(firewall);
        const results = await probeAll(runtime);
        const after = await rejectCount(firewall);
        matrix[label] = { results: summarize(results), rejectBefore: before, rejectAfter: after };
        // Positive control first: the named service port answers.
        for (const address of ["host.docker.internal", HOST_LOOPBACK]) {
          expect(results[`service@${address}`]).toMatchObject({ exit: 0, status: 200 });
          expect(results[`service@${address}`]!.body).toBe("service-ok");
        }
        // Everything else is rejected by the firewall at once: no response,
        // curl exit 7, and one REJECT counted per refused connection.
        const refused = Object.entries(results).filter(([name]) => !name.startsWith("service@"));
        for (const [, result] of refused) expect(result).toMatchObject({ exit: 7, status: 0 });
        expect(after - before).toBeGreaterThanOrEqual(refused.length);
      }

      const full = await probeAll(fullRuntime);
      matrix.full = { results: summarize(full) };
      for (const address of ["host.docker.internal", HOST_LOOPBACK]) {
        expect(full[`service@${address}`]).toMatchObject({ exit: 0, status: 200 });
        expect(full[`other@${address}`]).toMatchObject({ exit: 0, status: 200 });
        expect(full[`other@${address}`]!.body).toBe("other-ok");
      }
      // The real gateway answers. By its alias the Host check refuses it; by
      // the IP literal, or with a loopback Host header, it asks for a login.
      expect(full["gatewayStatus@host.docker.internal"]).toMatchObject({ exit: 0, status: 421 });
      expect(full["gatewayLogin@host.docker.internal"]).toMatchObject({ exit: 0, status: 421 });
      for (const name of [
        `gatewayStatus@${HOST_LOOPBACK}`,
        "gatewayStatus@host.docker.internal+loopback-host",
      ]) {
        expect(full[name]).toMatchObject({ exit: 0, status: 401 });
      }
      // 401 rather than 404: the gateway took the container for a loopback
      // peer, so its loopback-gated login route was served, and still refused
      // the request without a valid single-use code.
      for (const name of [
        `gatewayLogin@${HOST_LOOPBACK}`,
        "gatewayLogin@host.docker.internal+loopback-host",
      ]) {
        expect(full[name]).toMatchObject({ exit: 0, status: 401 });
      }
      // Minting a login code needs the gateway token even from loopback.
      expect(full[`gatewayMint@${HOST_LOOPBACK}`]).toMatchObject({ exit: 0, status: 401 });
      // RootlessKit dials the host's loopback itself, so every listener saw
      // 127.0.0.1, never the container's own address.
      matrix.peers = { service: [...service.peers], other: [...other.peers] };
      expect([...service.peers]).toEqual(["127.0.0.1"]);
      expect([...other.peers]).toEqual(["127.0.0.1"]);

      // Runtime root and the firewall. Behind a gateway, uid 0 in the runtime
      // has no NET_ADMIN, so it cannot change the rules and the gateway stays
      // refused. With the firewall in the workload, uid 0 can, and then the
      // runtime reaches the gateway like a full one.
      const openAll = ["iptables", "-I", "OUTPUT", "1", "-j", "ACCEPT"];
      expect(await dockerSucceeds(["exec", "-u", "orkroot", gatewayRuntime, ...openAll])).toBe(
        false,
      );
      const gatewayAfterTamper = await probe(gatewayRuntime, targets(HOST_LOOPBACK).gatewayStatus);
      expect(gatewayAfterTamper).toMatchObject({ exit: 7, status: 0 });
      expect(await dockerSucceeds(["exec", "-u", "orkroot", inContainerRuntime, ...openAll])).toBe(
        true,
      );
      const inContainerAfterTamper = await probe(
        inContainerRuntime,
        targets(HOST_LOOPBACK).gatewayStatus,
      );
      expect(inContainerAfterTamper).toMatchObject({ exit: 0, status: 401 });
      matrix.rootTamper = summarize({
        gatewayRuntime: gatewayAfterTamper,
        inContainerRuntime: inContainerAfterTamper,
      });

      if (REPORT_PATH) await Bun.write(REPORT_PATH, `${JSON.stringify(matrix, null, 2)}\n`);
    },
    LIVE_TIMEOUT_MS,
  );
});

/** Exit and status per probe, without bodies. */
function summarize(results: Record<string, Probe>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(results).map(([name, result]) => [
      name,
      `exit ${result.exit} http ${result.status}`,
    ]),
  );
}
