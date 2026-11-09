import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolsServer } from "../src/core/agent-tools.js";
import { type AgentToolsPeerGate, dockerPeerFilter } from "../src/core/agent-tools-peer-filter.js";
import { ROOTLESSKIT_HOST_LOOPBACK_ADDRESS } from "@orkestrator/protocol/container-host-reachability";
import {
  CONTAINER_HOST_PROBE_IMAGE,
  ContainerHostReachabilityService,
} from "../src/core/container-host-reachability.js";
import {
  ensureEnvironmentNetwork,
  removeEnvironmentNetwork,
} from "../src/core/container-network.js";
import { DOCKER_LABEL_OWNER } from "../src/core/constants.js";
import { dockerOwnerNamespace } from "../src/core/docker-ownership.js";
import { runCommand } from "../src/core/shell.js";
import { StorageService } from "../src/core/storage.js";
import {
  cleanupEvidenceResources,
  daemonIsRootless,
  removeTrackedResources,
  startEvidenceListener,
} from "./agent-tools-peer-evidence-support.js";

/**
 * Live evidence for the agent-tools peer gate (security finding L15), on this
 * machine's Docker:
 *
 *   mise exec -- bun apps/backend/scripts/agent-tools-peer-evidence.ts
 *
 * Runs the production `AgentToolsServer` on the wildcard address and an
 * ephemeral port, with the production Docker-backed peer filter, against a
 * throwaway data directory (never the real one, never ports 34121/34122).
 * It creates a real environment network through `ensureEnvironmentNetwork`,
 * runs the pinned busybox probe image on it, the default bridge and an
 * unowned network, runs the reachability probe from inside the environment
 * container and the throwaway-container host check, and sends requests to
 * the host's own non-loopback interface addresses. It prints, as JSON, the
 * peer address the server saw for each source and what each source got back.
 *
 * Everything it creates carries `orkestrator-s0170-evidence=1` and the
 * throwaway owner label, and only those are removed. The busybox image must
 * already be present (`docker pull <CONTAINER_HOST_PROBE_IMAGE>`); nothing is
 * pulled. Nothing here touches the host firewall, Docker's settings or any
 * login. `--platform-linux` runs the host check's Linux path on any host.
 *
 * On a rootless daemon (Docker info lists the `rootless` security option) the
 * three sources run a second time with `host.docker.internal` naming
 * RootlessKit's host loopback address instead of `host-gateway`, as the
 * backend does once its check finds that address answering
 * (`rootlessHostLoopbackSources`). Point `DOCKER_HOST` at a disposable
 * rootless daemon (`mise run docker:disposable`) to observe it.
 */

const EVIDENCE_LABEL = "orkestrator-s0170-evidence=1";

function exchange(host: string, port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("(timeout)");
    }, 5_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.on("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: agent-tools\r\nConnection: close\r\n\r\n`);
    });
  });
}

function statusLine(raw: string): string {
  return raw === "" ? "(closed, no bytes)" : (raw.split("\r\n")[0] ?? raw);
}

const docker = async (args: string[], timeoutMs = 60_000) =>
  (await runCommand("docker", args, { timeoutMs })).stdout.trim();

const dataDir = await mkdtemp(join(tmpdir(), "ork-s0170-peer-evidence-"));
const owner = dockerOwnerNamespace(dataDir);
const environmentId = `s0170-evidence-${randomBytes(4).toString("hex")}`;
const storage = new StorageService(dataDir);
await storage.init();

const filter = dockerPeerFilter(() => owner);
const peers: { path: string; peer: string; verdict: string }[] = [];
const gate: AgentToolsPeerGate = {
  verdict: (address) => filter.verdict(address),
  admits: (address) => filter.admits(address),
  recordRefusal: (address) => filter.recordRefusal(address),
  followNetworkChanges: () => filter.followNetworkChanges(),
};
const server = new AgentToolsServer(storage, "0.0.0.0", undefined, undefined, {
  ...gate,
  admits: async (address) => {
    const admitted = await filter.admits(address);
    peers.push({ path: "request", peer: String(address), verdict: admitted ? "admit" : "refuse" });
    return admitted;
  },
  verdict: (address) => {
    const verdict = filter.verdict(address);
    if (verdict === "refuse") peers.push({ path: "accept", peer: String(address), verdict });
    return verdict;
  },
});

const created = { containers: [] as string[], networks: [] as string[] };
const result: Record<string, unknown> = { dataDirOwner: owner, environmentId };
try {
  await startEvidenceListener((port) => server.start(port));
  const port = server.servicePort()!;
  result.port = port;
  result.dockerServer = await docker([
    "version",
    "--format",
    "{{.Server.Platform.Name}} {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}",
  ]);
  const rootless = daemonIsRootless(
    await docker(["info", "--format", "{{json .SecurityOptions}}"]),
  );
  result.dockerRootless = rootless;

  // A real environment network, created by the production code path.
  const network = await ensureEnvironmentNetwork({ storage }, environmentId);
  created.networks.push(network);
  result.environmentNetwork = {
    name: network,
    subnet: await docker([
      "network",
      "inspect",
      "-f",
      "{{range .IPAM.Config}}{{.Subnet}}{{end}}",
      network,
    ]),
  };
  // An unowned network: on Linux Engine its subnet is not admitted.
  const foreignNetwork = `s0170-evidence-foreign-${randomBytes(3).toString("hex")}`;
  await docker(["network", "create", "--label", EVIDENCE_LABEL, foreignNetwork]);
  created.networks.push(foreignNetwork);

  const runProbeContainer = async (networkName: string, owned: boolean, hostTarget: string) => {
    const id = await docker([
      "run",
      "--detach",
      "--pull",
      "never",
      "--label",
      EVIDENCE_LABEL,
      ...(owned ? ["--label", `${DOCKER_LABEL_OWNER}=${owner}`] : []),
      "--network",
      networkName,
      "--add-host",
      `host.docker.internal:${hostTarget}`,
      "--memory",
      "64m",
      "--entrypoint",
      "sleep",
      CONTAINER_HOST_PROBE_IMAGE,
      "300",
    ]);
    created.containers.push(id);
    return id;
  };
  const probeSources = async (hostTarget: string) => {
    const sources: Record<string, unknown> = {};
    let environmentContainer = "";
    for (const [label, networkName, owned] of [
      ["environment-network", network, true],
      ["default-bridge", "bridge", true],
      ["unowned-network", foreignNetwork, false],
    ] as const) {
      const id = await runProbeContainer(networkName, owned, hostTarget);
      if (label === "environment-network") environmentContainer = id;
      const address = await docker([
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        id,
      ]);
      const before = peers.length;
      const output = await docker(
        [
          "exec",
          id,
          "sh",
          "-c",
          `wget -S -T 5 -O /dev/null http://host.docker.internal:${port}/mcp 2>&1 | head -3`,
        ],
        30_000,
      ).catch((error: unknown) => String(error));
      sources[label] = {
        containerAddress: address,
        peerSeenByServer: peers.slice(before).map((entry) => `${entry.peer} (${entry.verdict})`),
        response:
          output.split("\n").find((line) => /HTTP\/|error|refused|reset/i.test(line)) ?? output,
      };
    }
    return { sources, environmentContainer };
  };
  const gatewayPass = await probeSources("host-gateway");
  result.containerSources = gatewayPass.sources;
  const loopbackPass = rootless ? await probeSources(ROOTLESSKIT_HOST_LOOPBACK_ADDRESS) : null;
  if (loopbackPass) result.rootlessHostLoopbackSources = loopbackPass.sources;

  // The reachability probe from inside the environment container, as a
  // bridge start and the workflow preflight run it.
  const reachability = new ContainerHostReachabilityService({
    servicePort: () => server.servicePort(),
    ownerNamespace: owner,
    fallbackImage: () => CONTAINER_HOST_PROBE_IMAGE,
    platform: process.argv.includes("--platform-linux") ? "linux" : process.platform,
  });
  const probeEnvironmentContainer = async (id: string) => {
    const probe = await reachability.checkEnvironmentContainer(id, { reason: "s0170-evidence" });
    return probe && { outcome: probe.outcome, httpStatus: probe.httpStatus };
  };
  result.environmentContainerProbe = await probeEnvironmentContainer(
    gatewayPass.environmentContainer,
  );
  if (loopbackPass) {
    result.rootlessHostLoopbackEnvironmentContainerProbe = await probeEnvironmentContainer(
      loopbackPass.environmentContainer,
    );
  }
  // The throwaway-container host check (Linux at startup; see --platform-linux).
  const hostCheck = await reachability.check("manual");
  result.hostCheck = {
    status: hostCheck.status,
    reason: hostCheck.reason ?? null,
    dockerRootless: hostCheck.dockerRootless ?? null,
    hostAddress: hostCheck.hostAddress ?? null,
    probes: (hostCheck.probes ?? []).map((probe) => ({
      scope: probe.scope,
      hostAddress: probe.hostAddress ?? null,
      outcome: probe.outcome,
      httpStatus: probe.httpStatus,
    })),
  };
  await reachability.dispose();

  // Requests from this host to its own non-loopback addresses: the peer is
  // that address, outside loopback and every owned Docker subnet.
  const outside: Record<string, unknown> = {};
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const before = peers.length;
      const raw = await exchange(entry.address, port, "/mcp");
      outside[entry.address] = {
        response: statusLine(raw),
        peerSeenByServer: peers
          .slice(before)
          .map((seen) => `${seen.peer} (${seen.verdict}, ${seen.path})`),
      };
    }
  }
  result.hostInterfaceRequests = outside;
  result.loopback = statusLine(await exchange("127.0.0.1", port, "/mcp"));
  result.admittedSubnets = filter.allowedSubnets();

  // Removal shrinks the list: the environment network's subnet is dropped.
  await removeTrackedResources(created.containers, (id) => docker(["rm", "-f", id]));
  const removal = await removeEnvironmentNetwork({ storage }, environmentId);
  if (removal === "removed") created.networks.splice(created.networks.indexOf(network), 1);
  await filter.reload();
  result.afterEnvironmentNetworkRemoval = { removal, admittedSubnets: filter.allowedSubnets() };
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const unresolved = await cleanupEvidenceResources(created, docker);
  result.unresolvedCleanup = unresolved;
  if (unresolved.containers.length || unresolved.networks.length) {
    process.exitCode = 1;
    console.error(JSON.stringify({ unresolvedCleanup: unresolved }));
  }
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
  result.leftovers = {
    containers: await docker(["ps", "-aq", "--filter", `label=${EVIDENCE_LABEL}`]),
    ownerContainers: await docker([
      "ps",
      "-aq",
      "--filter",
      `label=${DOCKER_LABEL_OWNER}=${owner}`,
    ]),
    networks: await docker(["network", "ls", "-q", "--filter", `label=${EVIDENCE_LABEL}`]),
    ownerNetworks: await docker([
      "network",
      "ls",
      "-q",
      "--filter",
      `label=${DOCKER_LABEL_OWNER}=${owner}`,
    ]),
  };
}
console.log(JSON.stringify(result, null, 2));
